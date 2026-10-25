// Zero-model preparation only. Reuse authorized test-profile source settings in
// place: never inspect/copy credentials, old threads, or failed Work into a project.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {git} from './desktop-frozen-workflow.fixture.mjs';
import {rooms,primaryBookings,bookingCases} from './booking-oracle.fixture.mjs';

const priorArgument=process.argv[2];
assert(priorArgument,'Usage: node tests/booking-isolation-setup.mjs <prior-evidence-directory>');
const prior=path.resolve(priorArgument);
const baseline=JSON.parse(await fs.readFile(path.join(prior,'setup-shared-test-profile.json'),'utf8'));
const previousProtectionFile=path.join(prior,'protection-with-prior-failures.json');
const protection=JSON.parse(await fs.readFile(previousProtectionFile,'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Check the old negative fixtures before creating anything, retaining their exact
// recorded expectations rather than silently blessing an altered failure scene.
assert(protection.files.length>=20,'Expected original negatives and hGD failed-round files');
for(const entry of protection.files)assert.equal(hash(await fs.readFile(entry.path)),entry.digest,'Protected prior file changed: '+entry.path);
for(const entry of [protection,...(protection.additionalStates||[])]){
  const state=JSON.parse(await fs.readFile(entry.stateFile,'utf8'));
  assert.equal(hash(JSON.stringify({works:state.works,jobs:state.jobs,drafts:state.drafts})),entry.stateDigest,'Protected failed/unknown Work state changed: '+entry.stateFile);
}
const profile=baseline.profile;
assert(path.isAbsolute(profile)&&profile.includes('acceptance-profiles'),'Must reuse an existing isolated test profile, never the daily profile');
const root=await fs.mkdtemp(path.join(path.dirname(prior),'nozeli-booking-independent-'));
const project=path.join(root,'room-booking-audit'),projectB=path.join(root,'reading-room');
await fs.mkdir(project);await fs.mkdir(projectB);
const compiler=path.resolve(import.meta.dirname,'../node_modules/typescript/bin/tsc');
await fs.access(compiler);
const build=path.join(root,'worker-build');
const schema=`# Booking audit CLI and JSON schema
Input CLI: node <compiled audit.js> <rooms.json> <bookings.json>
Rooms are an array of {id,capacity,equipment:string[],bufferMinutes}. Bookings are an array of {id,revision,room,start,end,attendees,equipment:string[],cancelled:boolean}.
All IDs are ASCII strings; revisions are integers. All timestamps have explicit +08:00. Cancellation is applied after revision selection and before validation.
Output ONLY one JSON object with exactly these fields:
{active:string[],cancelled:string[],invalid:{id:string,reason:string}[],conflicts:[string,string][],suggestions:{id:string,room:string,start:string,end:string}[]}
active contains every selected noncancelled valid ID, including conflicting IDs. Sort active/cancelled/invalid/suggestions by ASCII ID ascending. Sort IDs inside each conflict pair, emit every intersecting pair once, and sort pairs lexicographically. Invalid reason is the first applicable of room (unknown room), attendees (not a positive integer), capacity (exceeds capacity), equipment (not a subset), interval (invalid timestamp or start >= end).
Conflict intervals are [start,end+bufferMinutes), room-specific, compared as absolute instants (including cross-midnight). Same instant endpoints do not conflict.
Suggestion plan is subject to frontend user confirmation: only genuinely conflicting IDs get suggestions. Each suggestion is INDEPENDENT, not a joint schedule, and never mutates bookings. For each conflicting booking use its +08:00 start calendar day; consider valid occupied intervals in that room intersecting [day midnight,next midnight), including spillover from the previous day. Find the latest occupied end, ceil that instant to a 5-minute boundary, retain original duration. Do not clip at midnight. Output timestamps as YYYY-MM-DDTHH:mm:ss+08:00. Nonconflicting, invalid and cancelled IDs have no suggestions. Independent suggestions may overlap and cannot be adopted together as a conflict-free schedule.
Same-revision selection and invalid-high-revision fallback are intentionally unresolved until the user answers; do not infer defaults from the legacy source.
`;
const legacy=`// Legacy policy v1: first record wins, inclusive endpoints, no room buffer.
declare const require:any; declare const process:any;
const fs=require('node:fs');
const rooms:any[]=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const input:any[]=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const selected=new Map<string,any>();
for(const row of input)if(!selected.has(row.id))selected.set(row.id,row);
const active:string[]=[],cancelled:string[]=[],invalid:{id:string,reason:string}[]=[],valid:any[]=[];
for(const row of selected.values()){
  if(row.cancelled){cancelled.push(row.id);continue;}
  const room=rooms.find(r=>r.id===row.room);
  const reason=!room?'room':!Number.isInteger(row.attendees)||row.attendees<=0?'attendees':row.attendees>room.capacity?'capacity':row.equipment.some((e:string)=>!room.equipment.includes(e))?'equipment':!Number.isFinite(Date.parse(row.start))||!Number.isFinite(Date.parse(row.end))||Date.parse(row.start)>=Date.parse(row.end)?'interval':null;
  if(reason)invalid.push({id:row.id,reason});else{active.push(row.id);valid.push(row);}
}
const conflicts:string[][]=[];
for(let i=0;i<valid.length;i++)for(let j=i+1;j<valid.length;j++){
  const a=valid[i],b=valid[j];
  if(a.room===b.room&&Date.parse(a.start)<=Date.parse(b.end)&&Date.parse(b.start)<=Date.parse(a.end))conflicts.push([a.id,b.id].sort());
}
active.sort();cancelled.sort();invalid.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);conflicts.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0);
console.log(JSON.stringify({active,cancelled,invalid,conflicts,suggestions:[]}));
`;
const files={
  'materials/policy-v1.md':'# Legacy policy v1\nFirst duplicate booking ID wins, even when a later revision exists. Interval endpoints equal also count as conflicts. No buffer applies. This document is obsolete wherever the signed amendment overrides it.\n',
  'materials/amendment.md':'# Signed amendment v2 — overrides policy v1\nSelect the maximum integer revision per booking ID. If selected record is cancelled, omit that ID from validity/conflicts. Otherwise validate room, positive integer attendees, capacity, required equipment subset and start < end. Invalid selected records appear in invalid and never conflict. Occupancy is half-open [start,end+room buffer). All timestamps explicitly +08:00. Deterministic sorting and CLI/schema are in schema.md.\n\n## Still unresolved — ask the user\n1. How to choose among equal maximum revisions?\n2. Should an invalid highest revision fall back to a valid lower revision?\n\nSuggestions are not a scheduling engine. Their display plan must be confirmed with the user before implementation; do not silently auto-adopt changes.\n',
  'materials/schema.md':schema,
  'materials/rooms.json':JSON.stringify(rooms,null,2)+'\n',
  'materials/bookings.json':JSON.stringify(primaryBookings,null,2)+'\n',
  'docs/decision-notes.md':'# Current decisions\nSource review and user clarification pending. Same-revision choice and invalid-high-revision fallback are UNRESOLVED. No implementation or background Work authorized.\n\n## Change history\nInitial synthetic project; preserve subsequent decision history below a current summary.\n',
  'docs/operator-guide.md':'# Legacy operation\nRun the CLI described in materials/schema.md. Current implementation uses policy v1 first-record/inclusive-endpoint/no-buffer semantics and emits no suggestions. It is deliberately obsolete; no revised behavior has been verified.\n',
  'src/audit.ts':legacy,
  'user-notes.md':'# User-owned notes\nBOOKING-USER-EDIT-SENTINEL: keep this original text; this file is not Worker scope.\n',
  'checks/README.txt':'Host-owned independent checks are frozen outside this project. No Worker may modify checks or invent expected results. The host compiles the published candidate into evidence and compares independent fixed cases.\n',
  '.gitignore':'.nozeli/\n',
  'TASK.md':`# Booking audit implementation boundaries
Read materials and current decisions first. Source is deliberately obsolete. Do not implement until the frontend explicitly authorizes one Work. Only src/audit.ts and docs/operator-guide.md may be candidate changes; never change materials/checks/user notes/TASK.md or original bookings. Do not adopt/end Work.
Use the existing TypeScript toolchain, no dependency install/network:
node ${JSON.stringify(compiler)} src/audit.ts --target es2022 --module commonjs --outDir ${JSON.stringify(build)} --skipLibCheck
node ${JSON.stringify(path.join(build,'audit.js'))} materials/rooms.json materials/bookings.json
All compiler output and verification scratch files MUST remain under ${JSON.stringify(root)} (evidence), never in project/candidate inputs. Verify actual compiled behavior; distinguish verified results, limitations and candidate files in your report. Independent host expectations are not accessible in this project.
`,
};
for(const[relative,content]of Object.entries(files)){
  const file=path.join(project,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);
}
await fs.writeFile(path.join(projectB,'reading-note.txt'),'READING-ROOM-B-SENTINEL\nRead-only synthetic reference: independent suggestions are not a joint schedule. Project B is for reading and unsent-draft isolation only; do not send prompts or create Work here.\n');
for(const directory of [project,projectB]){
  await git(directory,['init','--initial-branch=main']);await git(directory,['add','.']);await git(directory,['commit','-m','freeze synthetic booking inputs and reading target']);
}
const protectionManifest=path.join(root,'protection-manifest.json');
await fs.writeFile(protectionManifest,JSON.stringify({...protection,priorManifest:previousProtectionFile,priorManifestDigest:hash(await fs.readFile(previousProtectionFile))},null,2));
// Freeze independent expectations only in evidence, not inside Worker inputs.
const oracleFile=path.join(root,'frozen-booking-oracle.json');
await fs.writeFile(oracleFile,JSON.stringify(bookingCases(),null,2));
const host=new DesktopHost(profile);
const registered=await host.registerDirectory(project),registeredB=await host.registerDirectory(projectB);
const immutableInputs=Object.fromEntries(await Promise.all(Object.keys(files).filter(relative=>!['src/audit.ts','docs/decision-notes.md','docs/operator-guide.md'].includes(relative)).map(async relative=>[relative,hash(await fs.readFile(path.join(project,relative)))])));
const setup={kind:'independent-real-booking-plan',root,project,profile,projectId:registered.id,projectB,projectBId:registeredB.id,prior,protectionManifest,compiler,immutableInputs,initialSourceHash:hash(legacy),initialOperatorGuideHash:hash(files['docs/operator-guide.md']),projectBInputs:{'reading-note.txt':hash(await fs.readFile(path.join(projectB,'reading-note.txt')))},oracleFile,oracleDigest:hash(await fs.readFile(oracleFile)),initialBaselineVerification:{status:'not-run',requiredMinimumFailedCases:2,source:path.join(project,'src/audit.ts'),note:'Parent must compile into evidence and run the independent fixed cases before model dispatch. Setup never compiles or runs tests.'},scope:'New synthetic projects and fresh threads in the existing authorized TEST profile. Original negatives, failed/unknown Work and 20 protected files retained; no credentials read/copied, no model request, no build or test run.'};
await fs.writeFile(path.join(root,'setup.json'),JSON.stringify(setup,null,2));
console.log(JSON.stringify(setup));
