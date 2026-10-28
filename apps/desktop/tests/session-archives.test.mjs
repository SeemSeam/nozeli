import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {readWorkerArchive,loadWorkerArchive} from '../src/agents/managed/worker-archive.mjs';
import {residentHistoryPage} from '../src/agents/managed/resident-history.mjs';
import {testStorageOptions} from './project-storage.fixture.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('worker archives verify original bytes before pagination and expose no transport or write handles',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-archive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {storage,projectId}=await testStorageOptions({contentRoot:path.join(root,'project')});
 const store={readObject:digest=>storage.readObject(projectId,digest)};
 const dossier={workId:'work-a',archiveId:'archive-a',request:'Preserved original request',jobs:[{text:'Original job',collabAttempts:[{nonce:'private'}],readHandle:'write-capability',home:'/private/home'}],reports:[{text:'Original report',directory:'/private/worktree'}]};const bytes=Buffer.from(JSON.stringify(dossier)),id=sha(bytes);await storage.putObject(projectId,bytes);const work={id:'work-a',archives:[{id:'archive-a',dossierObjectId:id,dossierDigest:id}]};
 const page=await readWorkerArchive(store,work,{archiveId:'archive-a'});assert.match(page.text,/Preserved original request/);assert.doesNotMatch(page.text,/write-capability|private\/home|collabAttempts|nonce/);
 assert.equal((await loadWorkerArchive(store,work,'archive-a')).dossier.jobs[0].readHandle,'write-capability');
 const object=path.join(await storage.projectDirectory(projectId),'objects','sha256',id),tampered=Buffer.from(JSON.stringify({...dossier,request:'Tampered'}));await fs.writeFile(object,tampered);
 await assert.rejects(readWorkerArchive(store,work,{archiveId:'archive-a'}),{code:'MATERIAL_CORRUPT'});assert.equal(await fs.readFile(object,'utf8'),tampered.toString('utf8'));
 await assert.rejects(readWorkerArchive({readObject:async()=>tampered},work,{archiveId:'archive-a'}),{code:'ARCHIVE_CORRUPT'});
});
test('unverified legacy handoff stays retained rather than accepting newly computed digest',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-archive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {storage,projectId}=await testStorageOptions({contentRoot:path.join(root,'project')});
 const store={readObject:digest=>storage.readObject(projectId,digest)},retained=(await storage.putObject(projectId,Buffer.from('{}'))).digest;
 const work={id:'work',archives:[{id:'legacy',dossierObjectId:'12345678-1234-1234-1234-123456789012',dossierDigest:retained}]};
 await assert.rejects(readWorkerArchive(store,work,{archiveId:'legacy'}),{code:'ARCHIVE_IDENTITY'});
 assert.equal((await storage.readObject(projectId,retained)).toString(),'{}');
});
test('resident history pages preserve the beginning and end of long native journal without model startup',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-resident-pages-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'history.jsonl'),body='BEGIN-'+('原生历史🙂\n'.repeat(20000))+'-END';await fs.writeFile(file,JSON.stringify({type:'message',message:{role:'assistant',content:[{type:'text',text:body}]}})+'\n');let page=await residentHistoryPage({file}),text='',version=page.version;for(;;){assert(page.text.length<=16000);text+=page.text;if(page.nextOffset===null)break;page=await residentHistoryPage({file,version,offset:page.nextOffset});}assert.equal(text,'assistant: '+body+'\n\n');await fs.appendFile(file,'{}\n');await assert.rejects(residentHistoryPage({file,version}),{code:'HISTORY_CHANGED'});
});
