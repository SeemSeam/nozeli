import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {DesktopHost} from '../src/main/host.mjs';
test('XLSX real package read/save/reopen, baseline recovery, conflict and invalid bytes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-word-'));const root=path.join(dir,'project');await fs.mkdir(root);const host=new DesktopHost(path.join(dir,'state'));
 try{const original=await fs.readFile(new URL('./fixtures/office/中文 表格.xlsx',import.meta.url));await fs.writeFile(path.join(root,'test.xlsx'),original);const {project}=await host.pick(root);const file=await host.readFile(project.id,'test.xlsx');assert.equal(file.kind,'sheet');assert.deepEqual(file.bytes,original);
 const zip=await JSZip.loadAsync(original);zip.file('xl/worksheets/sheet1.xml',(await zip.file('xl/worksheets/sheet1.xml').async('string')).replace('原始单元格','修改单元格'));const bytes=await zip.generateAsync({type:'nodebuffer'});const saved=await host.saveSheet(project.id,'test.xlsx',file.digest,bytes);assert.deepEqual((await host.readFile(project.id,'test.xlsx')).bytes,bytes);assert.deepEqual(await fs.readFile(saved.recoveryPath),bytes);
 await assert.rejects(host.saveSheet(project.id,'test.xlsx',file.digest,original),e=>e.code==='CONFLICT');assert.deepEqual(await fs.readFile(path.join(root,'test.xlsx')),bytes);
 await assert.rejects(host.saveSheet(project.id,'test.xlsx',saved.digest,Buffer.from('bad')));assert.deepEqual(await fs.readFile(path.join(root,'test.xlsx')),bytes);
 const backups=await fs.readdir(path.dirname(saved.recoveryPath));assert.equal(backups.length,2);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('recovery snapshot is persisted without writing spreadsheet source',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-sheet-recovery-')),root=path.join(dir,'project');await fs.mkdir(root);const host=new DesktopHost(path.join(dir,'state'));
 try{await fs.writeFile(path.join(root,'test.xlsx'),'untouched');const {project}=await host.pick(root);const bytes=Buffer.from(JSON.stringify({schema:'nozeli-sheet-recovery-v1',sheets:[{name:'edited',data:[[{v:'kept'}]]}],original:[1,2,3]}));const result=await host.recoverSheet(project.id,'test.xlsx',bytes);assert.deepEqual(await fs.readFile(result.recoveryPath),bytes);assert.equal(await fs.readFile(path.join(root,'test.xlsx'),'utf8'),'untouched');}finally{await fs.rm(dir,{recursive:true,force:true});}
});
