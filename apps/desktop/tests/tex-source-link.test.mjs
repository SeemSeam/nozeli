import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DesktopHost } from '../src/main/host.mjs';
import { TexBuildManager } from '../src/main/tex-build-manager.mjs';
import { parseSynctexResults, syncSourcePath } from '../src/main/tex-synctex.mjs';
import { mappedHeight } from '../src/renderer/preview-scroll-link.mjs';

const root = path.resolve(import.meta.dirname, '..');
await fs.mkdir(path.join(root, '.test-output'), { recursive: true });
const output = await fs.mkdtemp(path.join(root, '.test-output/tex-source-link-'));
const project = path.join(output, '中文 source project'); await fs.mkdir(path.join(project, '章节'), { recursive: true });
const text = '\\documentclass{article}\n\\begin{document}\n' + Array.from({length:12}, (_,i) => `PageOne paragraph ${i + 1}.\\par\n`).join('') + '\\newpage\n\\input{章节/内容}\n\\newpage\nPageThree final source.\n\\end{document}\n';
const child = Array.from({length:12}, (_,i) => `ChildPage paragraph ${i + 1}.\\par\n`).join('');
await fs.writeFile(path.join(project, 'main.tex'), text); await fs.writeFile(path.join(project, '章节/内容.tex'), child);
const host = new DesktopHost(path.join(output, 'profile')), id = (await host.pick(project)).project.id;
const manager = new TexBuildManager({ host });
let buildId, metadata;
test.after(async () => { await manager.stopAll(); await host.flush?.(); });

test('native SyncTeX forward/inverse uses real pages, included Unicode file, immutable build and source lines', async () => {
  await manager.configure({ projectId:id, root:'main.tex', engine:'xelatex', automatic:false });
  const request = await manager.request({projectId:id});
  const deadline = Date.now() + 45000;
  for (;;) {
    const state = await manager.status({projectId:id});
    if(state.sequence===request.sequence && ['success','error'].includes(state.phase)) { assert.equal(state.phase,'success',state.log||state.message); metadata=state.lastSuccess;buildId=metadata.buildId;break; }
    assert(Date.now()<deadline,'Real TeX build timeout');await new Promise(resolve=>setTimeout(resolve,30));
  }
  const one = await manager.sync({projectId:id,buildId,relPath:'main.tex',text,direction:'forward',line:7});
  assert(one.points.length);assert.equal(one.points[0].page,1);
  const inverse = await manager.sync({projectId:id,buildId,relPath:'main.tex',text,direction:'inverse',...one.points[0]});
  assert.equal(inverse.relPath,'main.tex');assert(Math.abs(inverse.line-7)<=1);assert.equal(inverse.sourceDigest,createHash('sha256').update(text).digest('hex'));
  const two=await manager.sync({projectId:id,buildId,relPath:'章节/内容.tex',text:child,direction:'forward',line:7});assert(two.points.length);assert.equal(two.points[0].page,2);
  const included=await manager.sync({projectId:id,buildId,relPath:'main.tex',text,direction:'inverse',...two.points[0]});assert.equal(included.relPath,'章节/内容.tex');assert(Math.abs(included.line-7)<=1);assert(!included.relPath.includes(project));
  const finalLine=text.split('\n').findIndex(line=>line.includes('PageThree'))+1;
  const three=await manager.sync({projectId:id,buildId,relPath:'main.tex',text,direction:'forward',line:finalLine});assert.equal(three.points[0].page,3);
  await fs.writeFile(path.join(output,'native-result.json'),JSON.stringify({ok:true,output,metadata,one,inverse,two,included,three},null,2)+'\n');
});

test('stale current buffer, changed included draft, invalid path/build/coordinates and corrupt map are rejected', async () => {
  assert(buildId);
  const base={projectId:id,buildId,relPath:'main.tex',text,direction:'forward',line:7};
  await assert.rejects(manager.sync({...base,text:text+'new change'}),{code:'TEX_SYNC_STALE'});
  await assert.rejects(manager.sync({...base,relPath:'../main.tex'}),{code:'TEX_PATH'});
  await assert.rejects(manager.sync({...base,line:0}),{code:'TEX_SYNC_INPUT'});
  await assert.rejects(manager.sync({...base,direction:'inverse',page:1,x:Infinity,y:5}),{code:'TEX_SYNC_INPUT'});
  await assert.rejects(manager.sync({...base,buildId:'../../other'}),{code:'TEX_BUILD'});
  const other=await host.pick(path.join(output,'profile'));await assert.rejects(manager.sync({...base,projectId:other.project.id}));
  const point=await manager.sync({...base,relPath:'章节/内容.tex',text:child});
  const read=await host.readFile(id,'章节/内容.tex');await host.persistDraft(id,'章节/内容.tex',read.digest,child+'new draft','dirty');
  await assert.rejects(manager.sync({...base,direction:'inverse',...point.points[0]}),{code:'TEX_SYNC_STALE'});
  await host.persistDraft(id,'章节/内容.tex',read.digest,child,'saved');
  const file=path.join(manager.dir(id),'builds',buildId,'preview.synctex.gz'), bytes=await fs.readFile(file);
  await fs.writeFile(file,Buffer.from('corrupt map'));await assert.rejects(manager.sync(base),{code:'TEX_INTEGRITY'});await fs.writeFile(file,bytes);
  assert.equal(await fs.readFile(path.join(project,'main.tex'),'utf8'),text);
});

test('missing optional tool keeps artifact/view and surfaces an explicit sync capability failure', async () => {
  const noTool=new TexBuildManager({host,findSynctex:async()=>null});
  try {
    assert.equal((await noTool.inspect({projectId:id,relPath:'main.tex'})).syncTool,false);
    assert((await noTool.artifact({projectId:id,buildId})).bytes.length>0);
    await assert.rejects(noTool.sync({projectId:id,buildId,relPath:'main.tex',text,direction:'forward',line:7}),{code:'TEX_SYNC_TOOL'});
    await noTool.view({projectId:id,root:'main.tex',view:{preview:true,page:2,zoom:1,scrollTop:100,linked:false}});
    assert.equal((await manager.view({projectId:id,root:'main.tex'})).linked,false);
  } finally { await noTool.stopAll(); }
});

test('protocol keeps Windows colons, rejects non-project inputs and piecewise geometry follows content rather than total ratio', () => {
  const parsed=parseSynctexResults('SyncTeX result begin\nOutput:C:\\cache\\preview.pdf\nInput:C:\\work\\main.tex\nLine:7\nColumn:-1\nSyncTeX result end');
  assert.equal(parsed[0].Input,'C:\\work\\main.tex');assert.equal(parsed[0].Column,-1);
  const work=path.resolve(output,'work'),files=[{relPath:'章节/内容.tex'}];
  assert.equal(syncSourcePath(path.join(work,'章节/内容.tex'),work,work,files),'章节/内容.tex');
  assert.equal(syncSourcePath(path.join(work,'../outside.tex'),work,work,files),null);
  assert.equal(syncSourcePath(path.join(work,'article.cls'),work,work,files),null);
  const points=[[0,0],[100,400],[200,500],[1000,2000]];
  assert.equal(mappedHeight(points,100),400);assert.equal(mappedHeight(points,450,1),150);assert.equal(mappedHeight(points,150),450);
});
