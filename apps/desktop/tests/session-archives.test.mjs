import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {readWorkerArchive,loadWorkerArchive} from '../src/agents/managed/worker-archive.mjs';
import {residentHistoryPage} from '../src/agents/managed/resident-history.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('worker archives verify original bytes before pagination and expose no transport or write handles',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-archive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(root+'/objects');
 const dossier={workId:'work-a',archiveId:'archive-a',request:'Preserved original request',jobs:[{text:'Original job',collabAttempts:[{nonce:'private'}],readHandle:'write-capability',home:'/private/home'}],reports:[{text:'Original report',directory:'/private/worktree'}]};const bytes=Buffer.from(JSON.stringify(dossier)),id=sha(bytes);await fs.writeFile(root+'/objects/'+id+'.json',bytes);const work={id:'work-a',threadArchive:[{id:'archive-a',dossierObjectId:id,dossierDigest:id}]};
 const page=await readWorkerArchive(root,work,{archiveId:'archive-a'});assert.match(page.text,/Preserved original request/);assert.doesNotMatch(page.text,/write-capability|private\/home|collabAttempts|nonce/);
 assert.equal((await loadWorkerArchive(root,work,'archive-a')).dossier.jobs[0].readHandle,'write-capability');
 await fs.writeFile(root+'/objects/'+id+'.json',JSON.stringify({...dossier,request:'Tampered'}));await assert.rejects(readWorkerArchive(root,work,{archiveId:'archive-a'}),{code:'ARCHIVE_CORRUPT'});
});
test('unverified legacy handoff stays retained rather than accepting newly computed digest',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-archive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(root+'/objects');const id='12345678-1234-1234-1234-123456789012';await fs.writeFile(root+'/objects/'+id+'.json','{}');await assert.rejects(readWorkerArchive(root,{id:'work',threadArchive:[{id:'legacy',dossierObjectId:id}]},{archiveId:'legacy'}),{code:'ARCHIVE_UNVERIFIED'});assert.equal(await fs.readFile(root+'/objects/'+id+'.json','utf8'),'{}');
});
test('resident history pages preserve the beginning and end of long native journal without model startup',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-resident-pages-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'history.jsonl'),body='BEGIN-'+('原生历史🙂\n'.repeat(20000))+'-END';await fs.writeFile(file,JSON.stringify({type:'message',message:{role:'assistant',content:[{type:'text',text:body}]}})+'\n');let page=await residentHistoryPage({file}),text='',version=page.version;for(;;){assert(page.text.length<=16000);text+=page.text;if(page.nextOffset===null)break;page=await residentHistoryPage({file,version,offset:page.nextOffset});}assert.equal(text,'assistant: '+body+'\n\n');await fs.appendFile(file,'{}\n');await assert.rejects(residentHistoryPage({file,version}),{code:'HISTORY_CHANGED'});
});
