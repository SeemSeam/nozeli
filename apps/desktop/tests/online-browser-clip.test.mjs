import test from 'node:test';
import assert from 'node:assert/strict';
import {OnlineBrowserManager} from '../src/main/online-browser.mjs';

// Minimal fakes: only the fields owner()/require()/alive()/refreshScope() read.
// `applied` tracks the GUEST WCV's real setBounds; `containerApplied` tracks
// the clip-parent container — the contract under test is that clipping moves
// the container only and NEVER resizes the guest (no reflow / innerWidth jump).
function harness(){
  const manager=new OnlineBrowserManager({View:null,WebContentsView:null,session:{},workspace:{layouts:new Map([['p1',{views:{v1:{kind:'web'}}}]])},dialog:null,hostdialog:null,onNavigate:null,downloadDirectory:null,Menu:null,discussion:null});
  const applied={bounds:null,visible:false};
  const containerApplied={bounds:null,visible:false};
  const view={
    getBounds(){return applied.bounds;},
    setBounds(bounds){applied.bounds={...bounds};},
    getVisible(){return applied.visible;},
    setVisible(visible){applied.visible=visible;},
  };
  const container={...view,getBounds(){return containerApplied.bounds;},setBounds(bounds){containerApplied.bounds={...bounds};},getVisible(){return containerApplied.visible;},setVisible(visible){containerApplied.visible=visible;}};
  const scope={dead:false,wc:{id:7,isDestroyed:()=>false,getZoomFactor:()=>1},role:'surface',kind:'web',viewId:'v1',projectId:'p1',generation:3,
    view:{getBounds:()=>({x:0,y:0,width:1200,height:900}),getVisible:()=>true},transferring:false,recoveryHeld:false,previewRecoveryFailed:false};
  const slot={id:'7:k1',scope,key:'k1',generation:3,ownerGeneration:3,projectId:'p1',url:'https://example.com/',title:'t',view,container,
    bounds:{x:0,y:0,width:0,height:0},boundsSequence:-1,clip:null,overlay:false,parentWindow:null,closed:false};
  manager.slots.set(slot.id,slot);manager.generations.set(slot.id,3);
  const identity={viewId:'v1',key:'k1',generation:3};
  return {manager,scope,slot,identity,applied,containerApplied};
}

test('clipping moves the container mask only; the guest WCV keeps its full viewport',()=>{
  const h=harness();
  h.manager.bounds(h.scope,{...h.identity,sequence:1,rect:{x:40,y:30,width:1120,height:870},clip:{x:40,y:30,width:400,height:870}});
  assert.deepEqual(h.containerApplied.bounds,{x:40,y:30,width:400,height:870});
  // REAL guest geometry: full-viewport size, negative offset preserves page
  // coordinates — never the clipped rect.
  assert.deepEqual(h.applied.bounds,{x:0,y:0,width:1120,height:870});
  assert.equal(h.applied.visible,true);
  assert.deepEqual(h.slot.bounds,{x:40,y:30,width:1120,height:870});
  // Clearing the clip widens the mask; the guest setBounds is not touched
  // again (identical bounds object semantics — same values, same size).
  h.manager.bounds(h.scope,{...h.identity,sequence:2,rect:{x:40,y:30,width:1120,height:870},clip:null});
  assert.deepEqual(h.containerApplied.bounds,{x:40,y:30,width:1120,height:870});
  assert.deepEqual(h.applied.bounds,{x:0,y:0,width:1120,height:870});
});

test('a mask shift during a drag never resizes the guest viewport',()=>{
  const h=harness();
  h.manager.bounds(h.scope,{...h.identity,sequence:1,rect:{x:0,y:0,width:1000,height:800},clip:{x:0,y:0,width:1000,height:400}});
  const before={...h.applied.bounds};
  // The floating window moves: only the mask origin/size changes. The guest
  // keeps its exact viewport SIZE (no reflow / innerWidth change); its offset
  // shifts negatively so page coordinates stay where they were.
  h.manager.bounds(h.scope,{...h.identity,sequence:2,rect:{x:0,y:0,width:1000,height:800},clip:{x:0,y:400,width:1000,height:400}});
  assert.deepEqual(h.containerApplied.bounds,{x:0,y:400,width:1000,height:400});
  assert.equal(h.applied.bounds.width,before.width);
  assert.equal(h.applied.bounds.height,before.height);
  assert.deepEqual(h.applied.bounds,{x:0,y:-400,width:1000,height:800});
});
test('a stale or out-of-order layout receipt never re-clips the live guest',()=>{
  const h=harness();
  h.manager.bounds(h.scope,{...h.identity,sequence:5,rect:{x:0,y:0,width:1200,height:900},clip:{x:0,y:0,width:700,height:900}});
  assert.deepEqual(h.containerApplied.bounds,{x:0,y:0,width:700,height:900});
  assert.throws(()=>h.manager.bounds(h.scope,{...h.identity,sequence:5,rect:{x:0,y:0,width:1200,height:900},clip:null}),/网站区域布局已过期/);
  assert.throws(()=>h.manager.bounds(h.scope,{...h.identity,sequence:4,rect:{x:0,y:0,width:1200,height:900},clip:null}),/网站区域布局已过期/);
  assert.deepEqual(h.containerApplied.bounds,{x:0,y:0,width:700,height:900});
  assert.throws(()=>h.manager.bounds(h.scope,{...h.identity,rect:{x:0,y:0,width:1200,height:900}}),/网站区域布局已过期/);
});

test('a fully covered or overlay-hidden guest is not visible; full bounds stay intact',()=>{
  const h=harness();
  h.manager.bounds(h.scope,{...h.identity,sequence:1,rect:{x:0,y:0,width:1200,height:900},clip:{x:0,y:0,width:1200,height:900}});
  assert.equal(h.applied.visible,true);
  // The renderer's covered case: the unobstructed region is EMPTY, so both
  // the mask and the guest hide without the viewport bounds ever shrinking.
  h.manager.bounds(h.scope,{...h.identity,sequence:2,rect:{x:0,y:0,width:1200,height:900},clip:{x:0,y:0,width:0,height:0}});
  assert.equal(h.applied.visible,false);assert.equal(h.containerApplied.visible,false);
  h.manager.bounds(h.scope,{...h.identity,sequence:3,rect:{x:0,y:0,width:1200,height:900},clip:null,overlay:true});
  assert.equal(h.applied.visible,false);
  assert.deepEqual(h.slot.bounds,{x:0,y:0,width:1200,height:900});
  assert.deepEqual(h.applied.bounds,{x:0,y:0,width:1200,height:900});
});

test('invalid identity, generation and clip payloads are denied',()=>{
  const h=harness();
  assert.throws(()=>h.manager.bounds(h.scope,{...h.identity,generation:2,sequence:1,rect:{x:0,y:0,width:10,height:10}}),/网站页面版本已失效/);
  assert.throws(()=>h.manager.bounds(h.scope,{...h.identity,viewId:'other',sequence:1,rect:{x:0,y:0,width:10,height:10}}),/网站页面身份无效/);
  assert.throws(()=>h.manager.bounds(h.scope,{...h.identity,sequence:1,rect:{x:0,y:0,width:-1,height:10}}),/网站区域无效/);
  assert.throws(()=>h.manager.bounds(h.scope,{...h.identity,sequence:1,rect:{x:0,y:0,width:10,height:10},clip:{x:0,y:0,width:-5,height:10}}),/网站区域裁切无效/);
  assert.throws(()=>h.manager.bounds(h.scope,{...h.identity,sequence:1,rect:{x:0,y:0,width:10,height:10},clip:{x:0,y:0,width:'wide',height:10}}),/网站区域裁切无效/);
  assert.equal(h.applied.bounds,null);assert.equal(h.containerApplied.bounds,null);
});
