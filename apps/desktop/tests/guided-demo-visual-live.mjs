import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {demoSteps} from '../src/domain/guided-demo.mjs';
import {createGuidedDemoHarness} from './guided-demo-live-helper.mjs';

process.env.NOZELI_TEST_BINARY ??= createRequire(import.meta.url)('electron');
process.env.NOZELI_TEST_APP_ROOT ??= path.resolve(import.meta.dirname,'..');
process.env.NOZELI_GUIDED_DEMO_ROOT ??= await fs.mkdtemp(path.join(tmpdir(),'nozeli-demo-visual-'));
const h=await createGuidedDemoHarness({kind:'content-aligned-labels'}),r=h.report;
let shell,controls,hint;
const overlap=(a,b)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
const model=page=>h.invoke(page,'workspace.bootstrap');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function capture(name,projectId){
 const [controlState,hintState,windows]=await Promise.all([model(controls),model(hint),h.invoke(shell,'workspace.windows.list',{projectId})]);
 if(controlState.visible&&hintState.visible)assert(!overlap(controlState.bounds,hintState.bounds),name+': native overlays overlap');
 const frame={name,control:controlState,hint:hintState,windows,layers:[],cards:[],collisions:[],coverage:'Real individual WebContents screenshots with native bounds. Reconstructed composites are not OS/compositor screenshots.'};
 const save=async(page,role,bounds)=>{const file=name+'-'+role+'.png';await page.screenshot({path:path.join(h.root,file)});frame.layers.push({role,file,bounds});};
 await save(shell,'shell',{x:0,y:0,...await shell.evaluate(()=>({width:innerWidth,height:innerHeight}))});
 const visible=windows.flatMap(window=>(window.surfaces||[]).filter(surface=>surface.visible).map(surface=>({...surface,windowId:window.windowId??window.id})));
 for(const surface of visible){
  const {page}=await h.scope(scope=>scope.viewId===surface.viewId,'visible content '+surface.viewId);
  await save(page,surface.viewId,surface.bounds);
  const previews=await page.evaluate(async()=>{const results=[];for(const node of document.querySelectorAll('.isolated-viewport[data-preview-key]')){const response=await window.nozeli.invoke('isolated-preview.snapshot',{key:node.dataset.previewKey});if(response.ok){const box=node.getBoundingClientRect();results.push({...response.value,rect:{x:box.x,y:box.y,width:box.width,height:box.height}});}}return results;});
  for(const preview of previews){
   const previewPage=(await h.browser.pages()).find(target=>target.url().startsWith(preview.origin+'/'));
   assert(previewPage,name+': report preview page exists');
   const text=await previewPage.evaluate(()=>document.body.innerText.trim());
   assert(text.length>20,name+': actual report content rendered');
   await save(previewPage,surface.viewId+'-report',{x:surface.bounds.x+preview.rect.x,y:surface.bounds.y+preview.rect.y,width:preview.rect.width,height:preview.rect.height});
  }
  const cards=await page.evaluate(()=>[...document.querySelectorAll('.note-projection:not([hidden])')].filter(node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden').map(node=>{const box=node.getBoundingClientRect(),root=node.closest('[data-annotation]');return{id:root?.dataset.annotation,kind:root?.className,x:box.x,y:box.y,width:box.width,height:box.height,text:node.innerText.slice(0,180)};}));
  frame.cards.push({viewId:surface.viewId,bounds:surface.bounds,cards});
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++)if(overlap(cards[i],cards[j]))frame.collisions.push({viewId:surface.viewId,i,j});
 }
 if(controlState.visible)await save(controls,'controls',controlState.bounds);
 if(hintState.visible)await save(hint,'hint',hintState.bounds);
 r.scenes.push(frame);await fs.writeFile(path.join(h.root,'frames.json'),JSON.stringify(r.scenes,null,2));
 assert.deepEqual(frame.collisions,[],name+': annotation cards overlap');
 return frame;
}
try{
 await h.launch();({page:shell}=await h.scope(scope=>scope.role==='shell'));
 controls=await h.startLearning(shell);({page:hint}=await h.scope(scope=>scope.role==='demo-hint'));
 const id=(await model(controls)).model.projectId;r.projectId=id;
 const playback=async intent=>{const m=(await model(controls)).model;await h.invoke(controls,'workspace.demoControls.action',{sessionId:m.sessionId,epoch:m.epoch,controlId:'play',intent});};
 for(let index=0;index<demoSteps.length;index++){
  const step=demoSteps[index];
  await h.until(async()=>{const state=await model(hint);return state.visible&&state.model?.stepIndex===index&&state.model?.phase==='reading'?state:null;},'settled content and reading label '+step.id,90000);
  await playback('pause');
  await h.until(async()=>(await model(hint)).model?.paused,'reading explanation pauses');
  const state=await h.invoke(shell,'demo.state',{projectId:id});
  assert.equal(state.session.stepIndex,index,'label belongs to the currently presented step');
  const frame=await capture(String(index).padStart(2,'0')+'-'+step.id,id);
  if(step.relPath)assert(frame.windows.some(window=>(window.surfaces||[]).some(surface=>surface.visible&&surface.relPath===step.relPath)),step.id+': source is visible before its explanation');
  if(['discuss-create','discuss-send','discuss-followup'].includes(step.id))assert(frame.cards.some(group=>group.cards.some(card=>card.kind?.includes('tag-discuss'))),step.id+': current discussion card, not an old note, is actually visible');
  assert.equal(frame.hint.model.title,step.hintTitle,'reading explanation matches this step');
  for(const group of frame.cards)for(const card of group.cards){const native={...card,x:card.x+group.bounds.x,y:card.y+group.bounds.y};if(frame.hint.visible)assert(!overlap(native,frame.hint.bounds),step.id+': explanation covers current annotation');if(frame.control.visible)assert(!overlap(native,frame.control.bounds),step.id+': controls cover current annotation');}
  r.checks.push({step:step.id,phase:'reading',title:step.hintTitle,visible:frame.windows.flatMap(window=>(window.surfaces||[]).filter(surface=>surface.visible).map(surface=>({kind:surface.kind,relPath:surface.relPath})))});
  if(index===0){
   for(const [width,height] of [[480,700],[700,480],[1280,800]]){
    await h.invoke(shell,'session.resize',{width,height});
    await h.until(()=>shell.evaluate(({width,height})=>Math.abs(innerWidth-width)<3&&Math.abs(innerHeight-height)<3,{width,height}),'real window resized');
    await h.invoke(controls,'workspace.demoControls.drag',{x:width/2-180,y:44});
    await pause(300);await capture('layout-'+width+'x'+height+'-collision',id);
   }
   const controlRect=(await model(controls)).bounds;
   await h.invoke(controls,'workspace.demoControls.drag',{x:1280-controlRect.width-16,y:800-controlRect.height-16});
   await pause(150);
  }
  // Observe the held explanation before allowing the next actual action.
  await pause(150);
  await playback('play');
  await h.until(async()=>(await model(hint)).model?.paused===false,'reading resumes without replay');
  const current=(await model(hint)).model;
  await h.invoke(hint,'workspace.demoHint.dismiss',{key:current.key});
 }
 await h.until(async()=>!(await model(controls)).visible,'finished demo controls hide',60000);
 await h.auditIsolation();assert.deepEqual(r.errors,[]);await h.closeNormally(shell);r.ok=true;
}catch(error){r.failure=error.stack;process.exitCode=1;if(shell)await shell.screenshot({path:path.join(h.root,'failure-shell.png')}).catch(()=>{});await h.cleanupAfterFailure();}
finally{await h.save();console.log(JSON.stringify({root:h.root,ok:r.ok,checks:r.checks,failure:r.failure,errors:r.errors},null,2));}
