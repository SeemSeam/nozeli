import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {TexLanguageService} from '../src/main/tex-language-service.mjs';
test('real TexLab: completion, cross-file label/citation definitions, memory changes and shutdown', {timeout:30000},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-tex-editor-'));const project=path.join(root,'中文 project');await fs.mkdir(path.join(project,'chapters'),{recursive:true});
 const source='\\documentclass{article}\n\\begin{document}\n\\input{chapters/body}\n\\bibliography{refs}\n中文😀 \\ref{sec:demo}\n\\cite{demo}\n\\end{document}\n';
 await fs.writeFile(path.join(project,'main.tex'),source);await fs.writeFile(path.join(project,'chapters/body.tex'),'\\section{Demo}\n\\label{sec:demo}\n');await fs.writeFile(path.join(project,'refs.bib'),'@article{demo, title={Synthetic}, author={Tester}, year={2026}}');
 const host=new DesktopHost(path.join(root,'profile'));const {project:p}=await host.pick(project);const events=[];const service=new TexLanguageService({host,onEvent:e=>events.push(e)});
 const input={projectId:p.id,relPath:'main.tex',text:source};
 try {
 await service.sync(input);
 const definition=await service.request({...input,action:'definition',line:4,column:15});assert.ok(definition.some(d=>d.relPath==='chapters/body.tex'&&d.range.start.line===1),JSON.stringify(definition));
 const citation=await service.request({...input,action:'definition',line:5,column:8});assert.ok(citation.some(d=>d.relPath==='refs.bib'),JSON.stringify(citation));
 const completion=await service.request({...input,action:'completion',line:4,column:14});assert.ok((completion.items||completion).some(i=>i.label==='sec:demo'),JSON.stringify(completion));
 const changed=source.replace('sec:demo','sec:missing');await service.sync({...input,text:changed});const missing=await service.request({...input,text:changed,action:'definition',line:4,column:15});assert.equal(missing.length,0);

 const hover=await service.request({...input,action:'hover',line:5,column:8});assert.ok(hover?.contents,JSON.stringify(hover));
 const pathCompletion=await service.request({...input,action:'completion',line:2,column:16});assert.ok((pathCompletion.items||pathCompletion).some(i=>i.label.includes('body')),JSON.stringify(pathCompletion));
 const bibCompletion=await service.request({...input,action:'completion',line:5,column:8});assert.ok((bibCompletion.items||bibCompletion).some(i=>i.label==='demo'));
 const chapter=await host.readFile(p.id,'chapters/body.tex');await host.draft(p.id,'chapters/body.tex',chapter.digest,'\\section{Draft}\n\\label{sec:unsaved}\n');
 const draftText=source.replace('sec:demo','sec:unsaved');const draftDefinition=await service.request({...input,text:draftText,action:'definition',line:4,column:15});assert.ok(draftDefinition.some(d=>d.relPath==='chapters/body.tex'));
 await service.sync({...input,text:'\\begin{document}\n\\end{figure}'});
 const deadline=Date.now()+3000;while(Date.now()<deadline&&!events.some(e=>e.type==='diagnostics'&&e.diagnostics.length))await new Promise(r=>setTimeout(r,50));assert.ok(events.some(e=>e.type==='diagnostics'&&e.diagnostics.length),'real parser diagnostics');
 const project2=path.join(root,'other');await fs.mkdir(project2);await fs.writeFile(path.join(project2,'main.tex'),'\\ref{sec:unsaved}');const {project:other}=await host.pick(project2);
 const isolated=await service.request({projectId:other.id,relPath:'main.tex',text:'\\ref{sec:unsaved}',action:'definition',line:0,column:9});assert.equal(isolated.length,0);
 await fs.unlink(path.join(project,'chapters/body.tex'));const deleted=await service.request({...input,text:draftText,action:'definition',line:4,column:15});assert.equal(deleted.length,0);
 const session=await service.start(p.id);assert.equal(session.child.spawnargs[0].includes('texlab'),true);await service.stopAll();assert.equal(service.sessions.size,0);assert.ok(session.child.exitCode!==null||session.child.signalCode!==null);
 console.log(JSON.stringify({definition,citation,completionCount:(completion.items||completion).length,events:events.map(e=>e.type)}));
 }finally{await service.stopAll();await fs.rm(root,{recursive:true,force:true});}
});

test('missing TexLab reports explicit unavailability without retaining a session',async()=>{
 const service=new TexLanguageService({host:{requireProject:async()=>({root:os.tmpdir()})},executable:async()=>{throw Error('missing TexLab');}});
 await assert.rejects(service.sync({projectId:'test'}),/missing TexLab/);assert.equal(service.sessions.size,0);await service.stopAll();
});
