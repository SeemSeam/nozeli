import test from 'node:test';
import assert from 'node:assert/strict';
import {sourcePageWindowEnvironment} from '../src/renderer/source-page-window-environment.mjs';
import {localWindowRect} from '../src/renderer/local-window.mjs';

function fixture() {
  let geometry={pageRect:{left:100,top:200,width:400,height:600},pageSize:{width:800,height:1200},anchorRect:{left:150,top:300},viewportRect:{left:0,top:40,right:1000,bottom:800}};
  const doc={documentElement:{clientWidth:1000,clientHeight:800},defaultView:{}};
  const parent={getBoundingClientRect:()=>({x:0,y:0,width:1000,height:800})};
  const environment=sourcePageWindowEnvironment({ownerDocument:doc,parentElement:parent},()=>geometry);
  return {environment,get:()=>geometry,set:value=>{geometry=value;}};
}

test('scaled source coordinates track page scrolling without rewriting a manual preference',()=>{
  const {environment:e,get,set}=fixture();
  const state={schema:2,revision:3,placement:{mode:'manual',space:'source-page',x:100,y:200},size:{width:300,height:260},collapsed:false,hidden:false};
  const original=structuredClone(state),first=e.measure();
  assert.deepEqual(e.toLocal(175,325),{x:150,y:250});
  assert.deepEqual(e.paintRect(localWindowRect(state,first),first),{x:150,y:300,width:150,height:130});
  set({...get(),pageRect:{...get().pageRect,top:-500}});
  const offscreen=e.measure();
  assert.equal(offscreen.visible,true); // The tail of this same page still intersects.
  assert.deepEqual(e.paintRect(localWindowRect(state,offscreen),offscreen),{x:150,y:-400,width:150,height:130});
  set({...get(),pageRect:{...get().pageRect,top:-700}});
  assert.equal(e.measure().visible,false);
  assert.deepEqual(state,original);
});

test('missing geometry cannot invent a page, and legacy viewport geometry is not interpreted as page units',()=>{
  const {environment:e,get,set}=fixture(),geometry=get();
  const legacy={schema:1,revision:4,placement:{mode:'manual',x:600,y:500},size:{width:300,height:260},collapsed:false,hidden:false},original=structuredClone(legacy);
  set(null);const absent=e.measure();assert.equal(absent.visible,false);assert.equal(e.migrateView(legacy,absent),null);
  set(geometry);const converted=e.migrateView(legacy,e.measure());
  assert.equal(converted.schema,2);
  assert.deepEqual(converted.placement,{mode:'auto',space:'source-page'});
  assert.deepEqual(converted.size,{width:600,height:520});
  assert.deepEqual(legacy,original);
  assert.equal(e.migrateView(converted,e.measure()),null);
});
