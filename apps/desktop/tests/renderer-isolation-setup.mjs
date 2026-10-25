// Developer-only independent real renderer-lifecycle fixture. Copies only test
// content, never profiles, credentials, prior Worktrees or hidden sidecars.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {DesktopHost} from '../src/main/host.mjs';
import {git} from './desktop-frozen-workflow.fixture.mjs';
const prior=process.argv[2];if(!prior)throw Error('Usage: node tests/renderer-isolation-setup.mjs <prior-evidence-directory>');
const baseline=JSON.parse(await fs.readFile(path.join(prior,'report.json'),'utf8')),old=JSON.parse(await fs.readFile(path.join(prior,'failure-state.json'),'utf8'));
const oldHome=Object.values(old.providers||{}).find(provider=>typeof provider.home==='string')?.home;assert(oldHome,'Actual previous runtime metadata is required');
const source=path.join(prior,'sensor-audit'),root=await fs.mkdtemp(path.join(path.dirname(path.resolve(prior)),'nozeli-renderer-independent-')),project=path.join(root,'sensor-audit'),profile=path.join(path.dirname(baseline.profile),path.basename(root));await fs.mkdir(project);await fs.mkdir(profile);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),files=[];
async function copy(rel){const from=path.join(source,rel),to=path.join(project,rel),stat=await fs.lstat(from);assert(!stat.isSymbolicLink(),'No external link copied into independent test');if(stat.isDirectory()){await fs.mkdir(to,{recursive:true});for(const name of await fs.readdir(from))await copy(path.join(rel,name));}else if(stat.isFile()){const bytes=await fs.readFile(from);await fs.writeFile(to,bytes);files.push({path:from,digest:digest(bytes),copiedAs:rel});}}
for(const rel of ['materials','checks','tools','src','docs','user-notes.txt'])await copy(rel);
await git(project,['init','--initial-branch=main']);await git(project,['add','.']);await git(project,['commit','-m','independent renderer lifecycle baseline']);await fs.appendFile(path.join(project,'.git/info/exclude'),'\n.nozeli/\n');
const stateFile=path.join(path.resolve(oldHome,'../..'),'state.json'),state=JSON.parse(await fs.readFile(stateFile,'utf8'));
const manifest={kind:'protected-original-test-state',stateFile,stateDigest:digest(JSON.stringify({works:state.works,jobs:state.jobs,drafts:state.drafts})),files,scope:'Original Work/job/draft state and source bytes must remain unchanged; new test uses a different project directory and user-data profile.'};
const manifestPath=path.join(root,'protection-manifest.json');await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2));
const host=new DesktopHost(profile),registered=await host.registerDirectory(project);assert.notEqual(registered.id,path.basename(path.resolve(oldHome,'../../..')),'New project has independent identity');
const setup={kind:'independent-renderer-lifecycle-plan',createdAt:new Date().toISOString(),root,project,profile,projectId:registered.id,prior,protectionManifest:manifestPath,sourceFiles:files.map(({copiedAs,digest})=>({relPath:copiedAs,digest})),sourceStateDigest:manifest.stateDigest,scope:'Setup only; no model input, existing jobs or outcomes copied, adopted or ended.'};
await fs.writeFile(path.join(root,'setup.json'),JSON.stringify(setup,null,2));console.log(JSON.stringify(setup));
