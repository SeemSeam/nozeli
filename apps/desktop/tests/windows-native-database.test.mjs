import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {StorageDatabase} from '../src/main/storage-database.mjs';
import {openExperimentalPersistenceParent as open} from '../src/platform/windows/experimental-persistence.mjs';
import {openExperimentalDatabaseLease as lease} from '../src/platform/windows/experimental-database.mjs';
import {security} from './fixtures/windows-security.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};


test('live SQLite journal retirement does not invalidate the original native database custody',native,async t=>{
 const f=await fixture(t),storage=f.storage();
 await storage.request(f.file,'put',{collection:'drafts',id:'input',value:0,operationId:'initial-draft'});
 const observer=f.hold(f.file,{mustExist:true}),identity=observer.identity();
 let complete=false;
 const writes=Promise.all(Array.from({length:128},(_,index)=>storage.request(f.file,'put',{collection:'drafts',id:'input',value:index+1,operationId:'draft-'+index}))).finally(()=>{complete=true;});
 writes.catch(()=>{});
 let fault;
 while(!complete){
  for(let index=0;index<16;index++)try{observer.verify();}catch(error){fault??=error;}
  await yieldTurn();
 }
 const receipts=await writes;
 if(fault)throw fault;
 assert.deepEqual(receipts.map(receipt=>receipt.revision),Array.from({length:128},(_,index)=>index+2));
 assert.equal(await storage.request(f.file,'get',{collection:'drafts',id:'input'}),128);
 assert.deepEqual(await storage.request(f.file,'receipt',{operationId:'draft-127'}),{revision:129});
 assert.equal(observer.identity(),identity);assert.equal(storage.quarantined.has(f.file),false);
});
test('native SQLite observes the original CAS receipt without replay and rejects changed comparisons after reopening',native,async t=>{
 const f=await fixture(t),storage=f.storage();
 await storage.request(f.file,'put',{collection:'ledger',id:'original',value:{draft:'保留草稿'},operationId:'seed'});
 const before=await storage.request(f.file,'boundedList',{collection:'ledger',maxRecords:10,maxBytes:4096});
 const comparison={expectedCollections:{ledger:before},records:[{collection:'ledger',id:'archived',expectedRevision:0,value:{phase:'intent',automaticReplay:false}}]};
 const operationId='archive-cas',expected={committed:true,revisions:[{collection:'ledger',id:'archived',revision:1}]};
 assert.equal(await storage.request(f.file,'compareAndPutReceipt',{operationId,comparison}),null);
 assert.deepEqual(await storage.request(f.file,'list',{collection:'ledger'}),before);
 assert.deepEqual(await storage.request(f.file,'compareAndPut',{...comparison,operationId}),expected);
 await storage.closeFile(f.file);
 const rows=await storage.request(f.file,'list',{collection:'ledger',mustExist:true});
 const observe=change=>storage.request(f.file,'compareAndPutReceipt',{operationId,comparison:change,mustExist:true});
 assert.deepEqual(await observe(comparison),expected);
 // Fingerprints use canonical persisted JSON, so property order is irrelevant.
 assert.deepEqual(await observe({records:comparison.records,expectedCollections:comparison.expectedCollections}),expected);
 for(const change of [
  {...comparison,records:[{...comparison.records[0],value:{phase:'ready'}}]},
  {...comparison,expectedCollections:{ledger:[]}},
  {...comparison,records:[{...comparison.records[0],expectedRevision:1}]},
 ])await assert.rejects(observe(change),{code:'STORAGE_OPERATION_CONFLICT'});
 await assert.rejects(observe({...comparison,unexpected:true}),{code:'INVALID_COMPARE_BATCH'});
 assert.deepEqual(await storage.request(f.file,'list',{collection:'ledger'}),rows);
});
test('native SQLite bounded collection refuses oversized and corrupt contenders before parsing and preserves their exact bytes',native,async t=>{
 const f=await fixture(t),storage=f.storage();
 await storage.request(f.file,'put',{collection:'custody',id:'one',value:{text:'中文 😀'}});
 const args={collection:'custody',maxRecords:1,maxBytes:1024};
 const rows=await storage.request(f.file,'boundedList',args);assert.equal(rows.length,1);assert.equal(rows[0].value.text,'中文 😀');
 await storage.request(f.file,'put',{collection:'custody',id:'two',value:{text:'retained'}});
 await assert.rejects(storage.request(f.file,'boundedList',args),{code:'LOCAL_COLLECTION_TOO_LARGE'});
 await storage.closeFile(f.file);
 const pin=f.hold(f.file,{mustExist:true}),db=new DatabaseSync(pin.path),raw='{broken '+ '界'.repeat(1024);
 try{db.prepare('UPDATE records SET value=? WHERE collection=? AND id=?').run(raw,'custody','two');}finally{db.close();}
 await assert.rejects(storage.request(f.file,'boundedList',{...args,maxRecords:2}),{code:'LOCAL_COLLECTION_TOO_LARGE'});
 await assert.rejects(storage.request(f.file,'boundedList',{...args,maxRecords:0}),{code:'LOCAL_READ_LIMIT_INVALID'});
 await storage.closeFile(f.file);const check=new DatabaseSync(pin.path);
 try{assert.equal(check.prepare('SELECT value FROM records WHERE collection=? AND id=?').get('custody','two').value,raw);}finally{check.close();}
});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-database-')),resources=[];
 const parent=open(root,'private');try{parent.createPrivateDirectory('private');}finally{parent.close();}
 const directory=path.join(root,'private'),file=path.join(directory,'project.sqlite');
 t.after(async()=>{for(const resource of resources.reverse())await resource.close();await fs.rm(root,{recursive:true,force:true});});
 return {root,directory,file,hold(fileOverride=file,options){const pin=lease(root,fileOverride,options);resources.push(pin);return pin;},
  storage(options={}){const storage=new StorageDatabase({experimentalWindowsRoot:root,...options});resources.push(storage);return storage;}};
}
function compete(operation,...args){
 const child=spawnSync(process.execPath,['-e',`try{require('node:fs')[process.argv[1]](...process.argv.slice(2));}catch(e){console.log(e.code);process.exitCode=7;}`,operation,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.ifError(child.error);assert.equal(child.signal,null);return child;
}

test('private database lease creates a protected file, pins all ancestors and allows actual SQLite writes',native,async t=>{
 const f=await fixture(t),pin=f.hold();assert.equal(pin.created,true);assert.match(pin.path,/^\\\\\?\\/);
 pin.verify();const acl=security('inspect',f.file);assert.equal(acl.protected,true);assert.equal(acl.rules.length,1);assert.equal(acl.rules[0].sid,acl.currentSid);
 const db=new DatabaseSync(pin.path);try{db.exec('CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES(\'actual sqlite\');');pin.verify();assert.equal(db.prepare('SELECT value FROM evidence').get().value,'actual sqlite');}finally{db.close();}
 for(const [operation,args]of [['renameSync',[f.directory,f.directory+'-moved']],['renameSync',[f.file,f.file+'-moved']],['unlinkSync',[f.file]]]){
  const child=compete(operation,...args);assert.equal(child.status,7,operation+': '+child.stderr);assert.match(child.stdout,/EPERM|EACCES|EBUSY|UNKNOWN/);
 }
 assert.throws(()=>pin.verify.call({}),{code:'FS_HANDLE_REJECTED'});pin.close();pin.close();assert.throws(()=>pin.verify(),{code:'FS_HANDLE_CLOSED'});
 await fs.rename(f.file,f.file+'-released');
});

test('existing database open never truncates it and missing mustExist never creates a file',native,async t=>{
 const f=await fixture(t),first=f.hold();await fs.writeFile(f.file,'synthetic bytes');first.close();
 const second=f.hold(f.file,{mustExist:true});assert.equal(second.created,false);assert.equal(await fs.readFile(f.file,'utf8'),'synthetic bytes');second.close();
 assert.throws(()=>f.hold(path.join(f.directory,'missing.sqlite'),{mustExist:true}),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===2);
 assert.deepEqual(await fs.readdir(f.directory),['project.sqlite']);
});

test('broad permissions, hard links, reparse parents and outside-root database paths refuse without modifying winners',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'broad.sqlite'),'broad');
 assert.throws(()=>f.hold(path.join(f.root,'broad.sqlite')),{code:'FS_SECURITY_CHANGED'});
 const pin=f.hold();pin.close();await fs.link(f.file,path.join(f.root,'alias.sqlite'));
 assert.throws(()=>f.hold(),{code:'FS_ENTRY_REJECTED'});await fs.unlink(path.join(f.root,'alias.sqlite'));
 await fs.symlink(f.directory,path.join(f.root,'junction'),'junction');
 assert.throws(()=>f.hold(path.join(f.root,'junction','project.sqlite')),{code:'FS_REPARSE_REJECTED'});
 for(const file of [path.join(f.root,'..','outside.sqlite'),f.root,'relative.sqlite'])assert.throws(()=>lease(f.root,file),{code:'FS_PATH_REJECTED'});
 assert.equal(await fs.readFile(path.join(f.root,'broad.sqlite'),'utf8'),'broad');
});

test('lease detects main-file hard links, security changes and unsafe sidecars while retaining contents',native,async t=>{
 const f=await fixture(t),pin=f.hold();await fs.writeFile(f.file,'retained');
 await fs.link(f.file,path.join(f.root,'alias'));assert.throws(()=>pin.verify(),{code:'FS_ENTRY_REJECTED'});await fs.unlink(path.join(f.root,'alias'));
 const journal=f.file+'-journal';await fs.writeFile(journal,'synthetic journal');pin.verify();
 await fs.link(journal,path.join(f.root,'journal-alias'));assert.throws(()=>pin.verify(),{code:'FS_ENTRY_REJECTED'});await fs.unlink(path.join(f.root,'journal-alias'));
 security('add-write',journal);assert.throws(()=>pin.verify(),{code:'FS_SECURITY_CHANGED'});await fs.unlink(journal);
 security('add-write',f.file);assert.throws(()=>pin.verify(),{code:'FS_SECURITY_CHANGED'});assert.equal(await fs.readFile(f.file,'utf8'),'retained');
});

test('shared worker commits and reopens real Windows SQLite ledger with exact operation receipts and revisions',native,async t=>{
 const f=await fixture(t),storage=f.storage(),args={collection:'ledger',id:'work',value:{draft:'未发送',revision:1},expectedRevision:0,operationId:'synthetic-put'};
 assert.deepEqual(await storage.request(f.file,'put',args),{revision:1});
 assert.deepEqual(await storage.request(f.file,'put',args),{revision:1});
 await assert.rejects(storage.request(f.file,'put',{...args,value:{draft:'different'}}),{code:'STORAGE_OPERATION_CONFLICT'});
 await assert.rejects(storage.request(f.file,'put',{...args,operationId:'stale',expectedRevision:0}),{code:'STORAGE_CONFLICT'});
 assert.deepEqual(await storage.request(f.file,'receipt',{operationId:'synthetic-put'}),{revision:1});
 await storage.closeFile(f.file);
 assert.deepEqual(await storage.request(f.file,'record',{collection:'ledger',id:'work',mustExist:true}),{revision:1,value:args.value});
 const database=new DatabaseSync(f.file);try{assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode,'delete');assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{database.close();}
});

test('shared collection CAS and failed duplicate operations preserve ledger and independent recovery database',native,async t=>{
 const f=await fixture(t),storage=f.storage(),collections={works:[{id:'w',value:{candidate:'approved'}}]};
 assert.deepEqual(await storage.request(f.file,'replace',{collections,operationId:'initial'}),{committed:true});
 await assert.rejects(storage.request(f.file,'replace',{collections:{works:[]},expectedCollections:{works:[]},operationId:'stale'}),{code:'STORAGE_CONFLICT'});
 await assert.rejects(storage.request(f.file,'replace',{collections:{works:[{id:'dup',value:1},{id:'dup',value:2}]},operationId:'duplicates'}));
 const rows=await storage.request(f.file,'list',{collection:'works'});assert.deepEqual(rows,[{id:'w',value:{candidate:'approved'},revision:1}]);
 const recovery=path.join(f.directory,'recovery.sqlite');await storage.request(recovery,'put',{collection:'drafts',id:'w',value:'retained draft'});
 await storage.closeFile(f.file);assert.equal(await storage.request(recovery,'get',{collection:'drafts',id:'w'}),'retained draft');
});

test('live worker pins main file and parent until its actual exit, then releases namespace changes',native,async t=>{
 const f=await fixture(t),storage=f.storage();await storage.request(f.file,'put',{collection:'x',id:'a',value:'retained'});
 const channel=storage.channels.get(f.file);assert.equal(channel.exited,false);
 assert.equal(compete('renameSync',f.directory,f.directory+'-moved').status,7);
 assert.equal(compete('unlinkSync',f.file).status,7);
 await storage.closeFile(f.file);assert.equal(channel.exited,true);
 await fs.rename(f.file,f.file+'-moved');await fs.rename(f.file+'-moved',f.file);
});

test('worker rejects unsafe directory, missing existing database and unsupported old schema without losing bytes',native,async t=>{
 const f=await fixture(t),storage=f.storage(),broad=path.join(f.root,'broad.sqlite');
 await assert.rejects(storage.request(broad,'put',{collection:'x',id:'a',value:'must not write'}),{code:'FS_SECURITY_CHANGED'});
 await assert.rejects(fs.stat(broad),{code:'ENOENT'});
 await assert.rejects(storage.request(f.file,'get',{collection:'x',id:'a',mustExist:true}));await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
 const pin=f.hold();pin.close();const db=new DatabaseSync(f.file);db.exec('CREATE TABLE old(value TEXT);INSERT INTO old VALUES(\'old evidence\');');db.close();const before=await fs.readFile(f.file);
 await assert.rejects(storage.request(f.file,'put',{collection:'x',id:'a',value:'must not write'}),{code:'STORAGE_FORMAT_UNSUPPORTED'});
 assert.deepEqual(await fs.readFile(f.file),before);
});

test('cached native integrity failure rejects a write and closes the old database lease',native,async t=>{
 const f=await fixture(t),storage=f.storage();await storage.request(f.file,'put',{collection:'x',id:'a',value:'original'});
 const alias=path.join(f.root,'alias');await fs.link(f.file,alias);
 await assert.rejects(storage.request(f.file,'put',{collection:'x',id:'a',value:'must not write',operationId:'unsafe'}),{code:'PROJECT_METADATA_CONFLICT'});
 await fs.unlink(alias);await storage.closeFile(f.file);
 assert.equal(await storage.request(f.file,'get',{collection:'x',id:'a',mustExist:true}),'original');
 assert.equal(await storage.request(f.file,'receipt',{operationId:'unsafe'}),null);
});

test('real SQLite lock timeout fences the generation, retains draft and reconciles without automatic replay',native,async t=>{
 const f=await fixture(t),storage=f.storage({timeoutMs:5000});await storage.request(f.file,'put',{collection:'x',id:'a',value:'original',operationId:'baseline'});
 const lock=new DatabaseSync(f.file);lock.exec('BEGIN EXCLUSIVE');storage.timeoutMs=80;
 try{await assert.rejects(storage.request(f.file,'put',{collection:'x',id:'a',value:'uncertain',operationId:'blocked'}),{code:'STORAGE_RESULT_UNKNOWN'});}
 finally{await storage.invalidate(f.file);lock.exec('ROLLBACK');lock.close();}
 const channel=storage.channels.get(f.file);if(channel&&!channel.exited)await new Promise(resolve=>channel.worker.once('exit',resolve));
 await assert.rejects(storage.request(f.file,'put',{collection:'x',id:'a',value:'no replay'}),{code:'STORAGE_RESULT_UNKNOWN'});
 storage.timeoutMs=5000;const recovery=path.join(f.directory,'recovery.sqlite');await storage.request(recovery,'put',{collection:'drafts',id:'a',value:'retained draft'});
 assert.equal(await storage.reconcile(f.file,'blocked'),null);assert.deepEqual((await storage.recover(f.file)).operations,[{operationId:'blocked',receipt:null}]);
 assert.equal(await storage.request(f.file,'get',{collection:'x',id:'a'}),'original');assert.equal(await storage.request(recovery,'get',{collection:'drafts',id:'a'}),'retained draft');
});

test('unsafe preexisting sidecars refuse before main-file creation and are never cleaned by the lease',native,async t=>{
 const f=await fixture(t),journal=f.file+'-journal',alias=path.join(f.root,'journal-alias');await fs.writeFile(journal,'external journal');await fs.link(journal,alias);
 assert.throws(()=>f.hold(),{code:'FS_ENTRY_REJECTED'});await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
 assert.equal(await fs.readFile(alias,'utf8'),'external journal');await fs.unlink(alias);await fs.unlink(journal);
 await fs.mkdir(journal);assert.throws(()=>f.hold(),{code:'WIN32_IO_ERROR'});await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
});

test('actual abrupt SQLite transaction exit leaves a hot journal and the shared worker recovers original data',native,async t=>{
 const f=await fixture(t),storage=f.storage();await storage.request(f.file,'put',{collection:'x',id:'a',value:'original',operationId:'baseline'});await storage.closeFile(f.file);
 const loader=new URL('../src/platform/windows/experimental-database.mjs',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
 import {DatabaseSync} from 'node:sqlite';import {openExperimentalDatabaseLease as lease} from ${JSON.stringify(loader)};
 const pin=lease(process.argv[1],process.argv[2],{mustExist:true}),db=new DatabaseSync(pin.path);
 db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=1;BEGIN IMMEDIATE');
 db.prepare('UPDATE records SET value=? WHERE collection=? AND id=?').run(JSON.stringify('uncommitted'), 'x','a');
 for(let i=0;i<12;i++)db.prepare('INSERT INTO records(collection,id,value) VALUES(?,?,?)').run('large',String(i),JSON.stringify('x'.repeat(256*1024)));
 pin.verify();process.exit(23);`,f.root,f.file],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.ifError(child.error);assert.equal(child.status,23,child.stderr);assert.ok((await fs.stat(f.file+'-journal')).size>0);
 assert.equal(await storage.request(f.file,'get',{collection:'x',id:'a',mustExist:true}),'original');
 assert.deepEqual(await storage.request(f.file,'list',{collection:'large'}),[]);assert.deepEqual(await storage.request(f.file,'receipt',{operationId:'baseline'}),{revision:1});
 await assert.rejects(fs.stat(f.file+'-journal'),{code:'ENOENT'});
});
