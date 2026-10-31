import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';
import {recoverPiProvider} from '../src/agents/managed/pi-process-ownership.mjs';

const launch=async(home,script,ownerId)=>{
 const child=spawn(process.execPath,['-e',script,path.resolve('..','..','integrations','pi','owner-test')],{env:{...process.env,NOZELI_PI_OWNER_HOME:home,NOZELI_PI_OWNER_ID:ownerId},detached:true,stdio:['ignore','pipe','ignore']});
 await once(child,'spawn');return child;
};
const destroy=child=>{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}};

test('Pi orphan recovery refuses a reused PID identity without killing the unrelated owner',async t=>{
 if(process.platform!=='linux')return;
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pi-identity-')),home=path.join(root,'agents','frontdesk');await fs.mkdir(home,{recursive:true});
 const ownerId=randomUUID(),child=await launch(home,'setInterval(()=>{},1000)',ownerId);
 t.after(async()=>{destroy(child);await fs.rm(root,{recursive:true,force:true});});
 const stamp=await processStamp(child.pid),parts=stamp.split(':');
 await assert.rejects(recoverPiProvider({pid:child.pid,home,ownerId,stamp:parts[0]+':'+(BigInt(parts[1])+1n),kind:'pi-node'},root),/PID reused/);
 assert.equal(await processStamp(child.pid),stamp);
 const receipt=await recoverPiProvider({pid:child.pid,home,ownerId,stamp,kind:'pi-node'},root);
 assert.equal(receipt.verified,true);assert.equal(await processStamp(child.pid),null);
});

test('Pi owner exit confirmation reaps a still-running inherited native-tool process',async t=>{
 if(process.platform!=='linux')return;
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pi-descendants-')),home=path.join(root,'agents','worker');await fs.mkdir(home,{recursive:true});
 const ownerId=randomUUID(),child=await launch(home,"const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)",ownerId);
 let nativePid,nativeStamp;
 t.after(async()=>{destroy(child);if(nativePid&&await processStamp(nativePid)===nativeStamp){try{process.kill(-nativePid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}await fs.rm(root,{recursive:true,force:true});});
 nativePid=Number((await once(child.stdout,'data'))[0].toString().trim());nativeStamp=await processStamp(nativePid);const stamp=await processStamp(child.pid);
 assert.ok(await processStamp(nativePid));
 const receipt=await recoverPiProvider({pid:child.pid,home,ownerId,stamp,kind:'pi-node'},root);
 assert.equal(receipt.verified,true);assert.equal(await processStamp(child.pid),null);assert.equal(await processStamp(nativePid),null);
});
