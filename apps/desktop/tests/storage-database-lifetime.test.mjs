import {MessageChannel} from 'node:worker_threads';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StorageDatabase} from '../src/main/storage-database.mjs';

class Worker extends EventEmitter {
 constructor(){super();const {port1,port2}=new MessageChannel();this.responsePort=port1;this.replyPort=port2;this.on('exit',()=>port2.close());}
 unref(){} ref(){}
 postMessage(message){this.message=message;}
 terminate(){return new Promise((resolve,reject)=>{this.exit=()=>{this.emit('exit',0);resolve(0);};this.rejectStop=reject;});}
 reply(value){this.responsePort.emit('message',{id:this.message.id,value,completedAt:process.hrtime.bigint()});}
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-db-lifetime-')),file=path.join(dir,'synthetic');await fs.writeFile(file,'identity fixture; not a database');t.after(()=>fs.rm(dir,{recursive:true,force:true}));return file;}

test('a routed worker drains and terminates before releasing its directory scope exactly once',async()=>{
 const worker=new Worker(),files=[];let releases=0;
 const db=new StorageDatabase({workerFactory:file=>{files.push(file);return worker;},onClosed:()=>{releases++;}});
 const request=db.request('selected/project.sqlite','get'),closing=db.close();assert.equal(db.close(),closing);
 await assert.rejects(db.request('unselected/new.sqlite','get'),{code:'STORAGE_CLOSED'});assert.deepEqual(files,['selected/project.sqlite']);
 worker.reply('accepted');assert.equal(await request,'accepted');await turn();assert.equal(releases,0);
 worker.exit();await closing;assert.equal(releases,1);
 await assert.rejects(db.reconcile('selected/project.sqlite','operation'),{code:'STORAGE_CLOSED'});
});

test('unknown worker termination retains directory scope and never reports a successful close',async()=>{
 const worker=new Worker();let releases=0;
 const db=new StorageDatabase({workerFactory:()=>worker,onClosed:()=>{releases++;}}),request=db.request('selected/project.sqlite','get');
 worker.reply('accepted');await request;const closing=db.close();await turn();worker.rejectStop(Error('synthetic stop failure'));
 const outcomes=await closing;assert.equal(outcomes[0].closed,false);assert.equal(outcomes[0].code,'STORAGE_RESULT_UNKNOWN');assert.equal(releases,0);assert.equal(db.channels.size,1);
 worker.exit();assert.equal(db.channels.size,0);
});

test('global close joins a receipt reconciliation admitted before its asynchronous file inspection',async t=>{
 const file=await fixture(t),worker=new Worker();let releases=0,created;
 const started=new Promise(resolve=>{created=resolve;});
 const db=new StorageDatabase({workerFactory:()=>{created();return worker;},onClosed:()=>{releases++;}});
 const receipt=db.reconcile(file,'known-operation'),closing=db.close();await started;
 assert.equal(releases,0);worker.reply({revision:3});await turn();assert.equal(releases,0);assert.equal(db.reconciliations.has(file),true);
 worker.exit();assert.deepEqual(await receipt,{revision:3});await closing;assert.equal(releases,1);assert.equal(db.reconciliations.size,0);
});

test('a reconciliation with unconfirmed termination keeps global close unknown and its scope retained',async t=>{
 const file=await fixture(t),worker=new Worker();let releases=0,created;
 const started=new Promise(resolve=>{created=resolve;});
 const db=new StorageDatabase({workerFactory:()=>{created();return worker;},onClosed:()=>{releases++;}});
 const receipt=db.reconcile(file,'known-operation');await started;const closing=db.close();worker.reply({revision:1});await turn();worker.rejectStop(Error('synthetic stop failure'));
 assert.deepEqual(await receipt,{revision:1});const outcomes=await closing;assert.deepEqual(outcomes,[{closed:false,code:'STORAGE_RESULT_UNKNOWN',file}]);assert.equal(releases,0);assert.equal(db.reconciliations.has(file),true);
 worker.exit();assert.equal(db.reconciliations.size,0);
});

test('failed reconciliation inspection still releases scope after global close without opening a worker',async t=>{
 const file=await fixture(t);await fs.unlink(file);let releases=0;
 const db=new StorageDatabase({workerFactory:()=>assert.fail('missing file must not start a worker'),onClosed:()=>{releases++;}});
 const receipt=assert.rejects(db.reconcile(file,'missing'),{code:'ENOENT'}),closing=db.close();await receipt;await closing;assert.equal(releases,1);
});
