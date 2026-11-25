import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {LocalSkillImports} from '../src/agents/managed/local-skill-imports.mjs';

test('changed sources block the whole batch; role grants, project instances, and old admitted versions stay separate',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-imports-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const catalog=new LocalSkillImports(path.join(home,'store.json'),{home,env:{}}),a={id:'a',instanceId:'instance-a'};
 const ctx={project:a}, invoke=(action,p={},options={})=>catalog.invoke(action,{projectId:a.id,...p},{...ctx,...options});
 const source=async(name,text)=>{const dir=path.join(home,'.codex','skills',name);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'SKILL.md'),text);};
 const analyze=async({candidates})=>({candidates:candidates.map(({id})=>({id,analysis:'Portable',portable:true,capability:'paracloud-capacity-v1'}))});
 async function proposal(){const scan=await invoke('scan',{sourceIds:['codex']});return invoke('analyze',{scanId:scan.scanId,candidateIds:scan.candidates.map(c=>c.id)},{analyze});}
 const grants=[{candidateId:'codex:0:reading',roles:['worker']},{candidateId:'codex:0:summary',roles:['frontdesk']}];
 await source('reading','Compare claims with their evidence.');await source('summary','Summarize the argument.');
 const stale=await proposal();await source('summary','Summarize the source and its limitations.');
 await assert.rejects(invoke('install',{proposalId:stale.proposalId,grants,enable:true}),{code:'SOURCE_CHANGED'});
 assert.deepEqual(await invoke('list'),[]);
 const current=await proposal();await invoke('install',{proposalId:current.proposalId,grants,enable:true});
 const [row]=await catalog.options(a,'worker'),selection={id:row.id,version:row.version};
 assert.deepEqual(await catalog.options({...a,instanceId:'replacement'},'worker'),[]);
 await assert.rejects(catalog.authorize(selection,{project:a,role:'orchestrator'}),{code:'STORE_SKILL_NOT_ENABLED'});
 const old=await catalog.authorize(selection,{project:a,role:'worker'});
 assert.equal(Object.hasOwn(old,'capability'),false);
 await source('reading','Compare claims; include the page number.');
 const updated=await proposal();await invoke('install',{proposalId:updated.proposalId,grants:[grants[0]],enable:true});
 await assert.rejects(catalog.authorize(selection,{project:a,role:'worker'}),{code:'STORE_SKILL_NOT_ENABLED'});
 assert.deepEqual(await catalog.resolve(old,{project:a,role:'worker'}),old);
 assert.equal((await catalog.options(a,'worker'))[0].id,old.id);
 assert.notEqual((await catalog.options(a,'worker'))[0].version,old.version);
});

test('scan distinguishes companion resources and size limits from model and host rejection',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-import-diagnostics-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const catalog=new LocalSkillImports(path.join(home,'store.json'),{home,env:{}});
 const create=async(name,text)=>{const dir=path.join(home,'.codex','skills',name);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'SKILL.md'),text);return dir;};
 const dir=await create('with-reference','Compare the supplied evidence.');await fs.writeFile(path.join(dir,'reference.md'),'Reference material.');
 await create('large','a'.repeat(32769));await create('reading','Compare claims with evidence.');await create('summary','Summarize the supplied argument.');
 const scan=await catalog.invoke('scan',{sourceIds:['codex']});
 assert.match(scan.candidates.find(c=>c.name==='with-reference').reason,/配套资源/);
 assert.deepEqual(scan.candidates.find(c=>c.name==='with-reference').resources,[{kind:'file',count:1}]);
 assert.match(scan.candidates.find(c=>c.name==='large').reason,/32 KiB/);
 const analyze=async({candidates})=>({candidates:candidates.map(c=>({id:c.id,analysis:'Reviewed',portable:c.name==='reading',text:'---\nallowed-tools: Bash\n---\nCompare evidence.'}))});
 const result=await catalog.invoke('analyze',{scanId:scan.scanId,candidateIds:['codex:0:reading','codex:0:summary']},{analyze});
 assert.match(result.candidates.find(c=>c.name==='reading').reason,/宿主文本兼容检查/);
 assert.match(result.candidates.find(c=>c.name==='summary').reason,/管理助手判定/);
 assert(result.candidates.every(c=>!c.skillId));
 for(const candidateIds of [undefined,[],['unknown'],['codex:0:large'],['codex:0:reading','codex:0:reading']]){
  await assert.rejects(catalog.invoke('analyze',{scanId:scan.scanId,candidateIds},{analyze:()=>assert.fail('invalid selection must not reach the provider')}),{code:'INVALID_SELECTION'});
 }
 const selected=await catalog.invoke('analyze',{scanId:scan.scanId,candidateIds:['codex:0:reading']},{analyze:async({candidates})=>{
  assert.deepEqual(candidates.map(c=>[c.name,c.text]),[['reading','Compare claims with evidence.']]);
  return {candidates:[{id:candidates[0].id,analysis:'Portable',portable:true,text:'Use the existing write tool to create the evidence table. See https://example.invalid.'}]};
 }});
 assert.deepEqual(selected.candidates.map(c=>c.name),['reading']);
 assert.match(selected.candidates[0].preview,/existing write tool/);
 await assert.rejects(catalog.invoke('install',{proposalId:selected.proposalId,grants:[{candidateId:'codex:0:summary',roles:['worker']}]}),{code:'INVALID_GRANT'});
 const inspected=await catalog.invoke('analyze',{scanId:scan.scanId,candidateIds:['codex:0:with-reference']},{analyze:async({candidates})=>{
  assert.deepEqual(candidates.map(c=>[c.compatibility,c.text,c.resources]),[['analysis-only','Compare the supplied evidence.',[{kind:'file',count:1}]]]);
  assert(!JSON.stringify(candidates).includes('Reference material.'));
  return {candidates:[{id:candidates[0].id,analysis:'Can discuss the workflow.',portable:true,text:'Compare the supplied evidence.'}]};
 }});
 assert.equal(inspected.candidates[0].compatibility,'analysis-only');
 assert.equal(inspected.candidates[0].preview,undefined);
 await assert.rejects(catalog.invoke('install',{proposalId:inspected.proposalId,grants:[{candidateId:'codex:0:with-reference',roles:['worker']}]}),{code:'INVALID_GRANT'});
});

const digestOf=text=>createHash('sha256').update(text,'utf8').digest('hex');
const capacity='paracloud-capacity-v1';
async function reviewedFixture(t){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-reviewed-imports-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const file=path.join(home,'store.json'),catalog=new LocalSkillImports(file,{home,env:{}});
 const project={id:'migration',instanceId:'instance-a'},other={...project,instanceId:'instance-b'};
 const locator={workId:'w1',objectId:'review-1',relPath:'adapter/SKILL.md'};
 const text='# Capacity\n\n只读取当前容量。\n',digest=digestOf(text);
 const artifact={text,name:'paracloud-capacity',description:'Read capacity',digest,capability:capacity,provenance:{...locator,instanceId:project.instanceId,commit:'a'.repeat(40),digest}};
 const reads=[];
 const readReviewed=async args=>{reads.push(args);return artifact;};
 const invoke=(action,p={},options={})=>catalog.invoke(action,{projectId:project.id,...p},{project,readReviewed,...options});
 const preview=(options={})=>invoke('reviewed',locator,options);
 const install=(proposal,options={})=>invoke('install',{proposalId:proposal.proposalId,grants:[{candidateId:proposal.candidates[0].id,roles:['worker']}],enable:true},options);
 return {file,home,catalog,project,other,locator,artifact,reads,invoke,preview,install};
}

test('reviewed adapter preview, install, and resolution preserve scoped identity and the text digest',async t=>{
 const {file,home,catalog,project,other,locator,artifact,reads,invoke,preview,install}=await reviewedFixture(t);
 const proposal=await preview();
 const candidate=proposal.candidates[0];
 assert.match(candidate.skillId,/^local-[a-f0-9]{32}$/);
 assert.deepEqual(candidate,{id:'reviewed:paracloud-capacity',sourceId:'reviewed',name:artifact.name,description:artifact.description,compatibility:'compatible',reason:'',bytes:Buffer.byteLength(artifact.text),resources:[],isPreview:true,skillId:candidate.skillId,version:candidate.version,digest:artifact.digest,preview:artifact.text});
 assert.deepEqual(await invoke('list'),[]);
 assert.deepEqual(await catalog.options(project,'worker'),[]);
 await assert.rejects(install(proposal,{project:other}),{code:'STALE_PROPOSAL'});
 assert.deepEqual(reads,[locator]);
 const [row]=await install(proposal),{id,version,digest}=row,selection={id,version};
 assert.deepEqual(reads,[locator,locator]);
 assert.deepEqual(row,{...selection,digest:artifact.digest,sourceId:'reviewed',name:artifact.name,description:artifact.description,isPreview:false,roles:[{id:'worker',name:'工作 Agent',enabled:true}]});
 assert.equal(id,candidate.skillId);assert.equal(version,candidate.version);
 assert.deepEqual(await invoke('list',{},{project:other}),[]);
 assert.deepEqual(await catalog.options(other,'worker'),[]);
 await assert.rejects(invoke('enable',{...selection,role:'worker'},{project:other}),{code:'PROJECT_SCOPE_DENIED'});
 await assert.rejects(catalog.authorize(selection,{project,role:'frontdesk'}),{code:'STORE_SKILL_NOT_ENABLED'});
 const worker={project,role:'worker'};
 const reloaded=new LocalSkillImports(file,{home,env:{}}),pin=await reloaded.authorize(selection,worker);
 assert.deepEqual(pin,{...selection,digest,text:artifact.text});
 assert.deepEqual(await reloaded.resolve(pin,worker),{...pin,capability:capacity});
 assert.equal(digest,digestOf(artifact.text));
 await assert.rejects(reloaded.resolve(pin,{...worker,project:other}),{code:'STORE_SKILL_NOT_ENABLED'});
 await assert.rejects(reloaded.resolve({...pin,digest:'0'.repeat(64)},worker),{code:'STORE_SKILL_NOT_ENABLED'});
 assert.throws(()=>reloaded.authorize({...selection,capability:capacity},worker),{code:'INVALID_PAYLOAD'});
 assert.throws(()=>reloaded.resolve({...pin,capability:capacity},worker),{code:'INVALID_PAYLOAD'});

 // Same name and text, with only the capability removed: new version, same text digest.
 delete artifact.capability;
 const changed=await preview(),next=changed.candidates[0];
 assert.equal(next.skillId,id);assert.equal(next.digest,digest);assert.notEqual(next.version,version);
 await install(changed);
 const updated=await reloaded.authorize({id,version:next.version},worker);
 assert.deepEqual(await reloaded.resolve(updated,worker),updated);
 await assert.rejects(reloaded.authorize(selection,worker),{code:'STORE_SKILL_NOT_ENABLED'});
 assert.deepEqual(await reloaded.resolve(pin,worker),{...pin,capability:capacity});
 const replacement=await preview({project:other,readReviewed:async()=>({...artifact,provenance:{...artifact.provenance,instanceId:other.instanceId}})});
 assert.notEqual(replacement.candidates[0].skillId,id);
});

test('reviewed import validates the locator and rechecks the entire trusted artifact before publication',async t=>{
 const {file,home,project,locator,artifact,reads,invoke,preview,install}=await reviewedFixture(t);
 await assert.rejects(invoke('reviewed',{...locator,projectId:undefined}),{code:'PROJECT_SCOPE_DENIED'});
 await assert.rejects(invoke('reviewed',{...locator,projectId:'another'}),{code:'PROJECT_SCOPE_DENIED'});
 await assert.rejects(invoke('reviewed',{...locator,relPath:'../SKILL.md'}),{code:'INVALID_PAYLOAD'});
 await assert.rejects(invoke('reviewed',{...locator,objectId:undefined}),{code:'INVALID_PAYLOAD'});
 await assert.rejects(invoke('reviewed',{...locator,capability:capacity}),{code:'INVALID_PAYLOAD'});
 assert.deepEqual(reads,[]);
 await assert.rejects(preview({readReviewed:undefined}),{code:'REVIEWED_REQUIRED'});
 for(const capability of [null,'unknown',['paracloud-capacity-v1']]){
  await assert.rejects(preview({readReviewed:async()=>({...artifact,capability})}),{code:'INVALID_REVIEWED'});
 }
 for(const change of [{instanceId:'other'},{workId:'other'},{objectId:'other'},{relPath:'different/SKILL.md'},{digest:digestOf('different')},{commit:'HEAD'}]){
  await assert.rejects(preview({readReviewed:async()=>({...artifact,provenance:{...artifact.provenance,...change}})}),{code:'INVALID_REVIEWED'});
 }
 await assert.rejects(preview({readReviewed:async()=>({...artifact,text:'Not the digested text.'})}),{code:'INVALID_REVIEWED'});
 const proposal=await preview();
 await assert.rejects(install(proposal,{readReviewed:undefined}),{code:'SOURCE_CHANGED'});
 await assert.rejects(install(proposal,{readReviewed:async()=>{throw Error('No longer accepted');}}),{code:'SOURCE_CHANGED'});
 const changedText='Different text.',digest=digestOf(changedText);
 for(const changed of [
  {...artifact,capability:undefined},{...artifact,name:'other-name'},{...artifact,description:'New description'},
  {...artifact,text:changedText,digest,provenance:{...artifact.provenance,digest}},
 ]){
  await assert.rejects(install(proposal,{readReviewed:async()=>changed}),{code:'SOURCE_CHANGED'});
 }
 // Mutating the callback's own object cannot mutate the frozen proposal.
 const commit=artifact.provenance.commit;artifact.provenance.commit='b'.repeat(40);
 await assert.rejects(install(proposal),{code:'SOURCE_CHANGED'});artifact.provenance.commit=commit;
 let active=true;
 await assert.rejects(install(proposal,{readReviewed:async()=>{active=false;return artifact;},assertCurrent:()=>{
  if(!active)throw Object.assign(Error(project.id),{code:'STALE_PROJECT'});
 }}),{code:'STALE_PROJECT'});
 await assert.rejects(fs.stat(file),{code:'ENOENT'});
 assert.deepEqual(await fs.readdir(home),[]);
 assert.deepEqual(await invoke('list'),[]);
 assert.equal((await install(proposal)).length,1);
});
