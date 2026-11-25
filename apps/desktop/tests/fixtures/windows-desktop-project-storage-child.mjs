// Separate real process for synthetic native storage cold-start qualification.
import assert from 'node:assert/strict';
import {ProjectStorage} from '../../src/main/project-storage.mjs';
const [action,profile,root]=process.argv.slice(2),storage=new ProjectStorage(profile,{windowsDesktopProjects:true});
try{
 if(action==='seed'){
  const p=await storage.register(root);await storage.putLocal(p.id,'draft',{text:'跨进程未发送 🧭'});await storage.putProject(p.id,'notes','n',{text:'project note'});const object=await storage.putObject(p.id,Buffer.from('immutable 中文'));
  await storage.putLocal(p.id,'object',object);console.log(JSON.stringify({id:p.id,identity:p.identity}));
 }else if(action==='read'){
  const rows=await storage.list();assert.equal(rows.length,1);const p=await storage.requireOnline(rows[0].id),object=await storage.getLocal(p.id,'object');
  assert.deepEqual(await storage.getLocal(p.id,'draft'),{text:'跨进程未发送 🧭'});assert.deepEqual(await storage.getProject(p.id,'notes','n'),{text:'project note'});assert.equal((await storage.readObject(p.id,object.digest)).toString(),'immutable 中文');
  console.log(JSON.stringify({id:p.id,identity:p.identity,recovered:true}));
 }else throw Error('Unknown fixture action');
}finally{const outcomes=await storage.db.close();assert(!outcomes.some(value=>value?.closed===false),'actual workers must stop before process exit');}
