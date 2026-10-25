// Actual cached Tectonic build/cancellation and independent SQLite/object recovery.
// No remote downloads, model calls, user project, or synthetic compiler.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {TexBuildManager} from '../src/main/tex-build-manager.mjs';
const root=await fs.mkdtemp(path.join(process.env.NOZELI_STORAGE_TEST_ROOT||os.tmpdir(),'nozeli-tex-storage-'));
const projectRoot=path.join(root,'project'),profile=path.join(root,'profile');
await fs.mkdir(projectRoot);const source='\\documentclass{article}\n\\begin{document}\nStorage recovery marker 73129.\n\\end{document}\n';
await fs.writeFile(path.join(projectRoot,'main.tex'),source);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const host=new DesktopHost(profile),project=(await host.pick(projectRoot)).project;
const manager=new TexBuildManager({host,timeout:60000});
let cold;
try{
 await manager.configure({projectId:project.id,root:'main.tex',engine:'tectonic',automatic:false});
 await manager.request({projectId:project.id});let slot=await manager.slot(project.id);await slot.running;
 assert.equal(slot.state.phase,'success',JSON.stringify(slot.state));
 const success=slot.state.lastSuccess,{bytes,metadata}=await manager.artifact({projectId:project.id,buildId:success.buildId});
 assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.equal(hash(bytes),metadata.pdfDigest);
 assert.equal(metadata.files.find(file=>file.relPath==='main.tex').digest,hash(Buffer.from(source)));
 await manager.request({projectId:project.id,buffers:[{relPath:'main.tex',baseDigest:hash(Buffer.from(source)),text:'\\documentclass{article}\n\\begin{document}\\loop\\iftrue\\repeat\\end{document}\n'}]});
 slot=await manager.slot(project.id);
 const end=Date.now()+15000;while(!slot.job?.child?.spawnargs.includes('compile')){if(Date.now()>end)throw Error('Actual compiler did not start: '+JSON.stringify(slot.state));await new Promise(resolve=>setTimeout(resolve,10));}
 const child=slot.job.child;assert(child.pid);await manager.stopProject(project.id);
 assert.notEqual(child.exitCode===null&&child.signalCode===null,true,'real compiler exit confirmed');
 assert.equal((await host.storage.getRecovery(project.id,'tex:last-success')).buildId,success.buildId);
 await fs.rename(projectRoot,projectRoot+'-offline');
 await assert.rejects(host.requireProject(project.id),{code:'PROJECT_ROOT_MISSING'});
 assert.deepEqual((await manager.artifact({projectId:project.id,buildId:success.buildId})).bytes,bytes);
 await host.storage.db.close();cold=new DesktopHost(profile);
 const reopened=new TexBuildManager({host:cold});
 assert.deepEqual((await reopened.artifact({projectId:project.id,buildId:success.buildId})).bytes,bytes);
 assert.equal(await fs.readFile(path.join(projectRoot+'-offline','main.tex'),'utf8'),source);
 const report={root,engine:metadata.engineVersion,buildId:success.buildId,pdfDigest:metadata.pdfDigest,compilerStopped:true,coldOfflinePdfRecovered:true,sourceUnchanged:true,syncTexToolVerified:false,ok:true};
 await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){console.error('TeX storage smoke evidence:',root);throw error;}
finally{await manager.stopAll();await host.storage.db.close();await cold?.storage.db.close();}
