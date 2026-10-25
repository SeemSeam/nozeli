import fs from 'node:fs/promises';
import path from 'node:path';
import {after} from 'node:test';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {readManagedState,saveManagedState} from '../src/agents/managed/managed-storage.mjs';

const bindings=new Map();
const storages=new Set();
after(async()=>{await Promise.all([...storages].map(storage=>storage.db.close()));});

// Unit fixtures retain their chosen execution directory, but business state and
// immutable objects always belong to a registered, real project database.
export async function testStorageOptions(options){
 if(options.storage)return options;
 const contentRoot=path.resolve(options.contentRoot);
 let flight=bindings.get(contentRoot);
 if(!flight){
  flight=(async()=>{
   await fs.mkdir(contentRoot,{recursive:true});
   const storage=new ProjectStorage(path.join(path.dirname(contentRoot),'.test-storage'));
   storages.add(storage);
   const project=await storage.register(contentRoot);
   return {storage,projectId:project.id};
  })();
  bindings.set(contentRoot,flight);
 }
 return {...options,...await flight};
}
export async function openTestController(options){return Controller.open(await testStorageOptions(options));}
export async function openTestWorkspace(runtimeRoot,contentRoot,options={}){
 const binding=await testStorageOptions({...options,runtimeRoot,contentRoot});
 return Workspace.open(runtimeRoot,contentRoot,binding);
}
export async function readTestState(store){return readManagedState(store.storage,store.projectId);}
export async function writeTestState(store,state){
 const prior=store.state;
 store.state=structuredClone(state);
 try{await saveManagedState(store);}finally{store.state=prior;}
}
export async function readTestObject(store,objectId){
 const receipt=store.state.receipts.find(row=>row.objectId===objectId);
 if(!receipt)throw Error('Unknown fixture report object');
 return store.readObject(receipt.report.digest);
}
