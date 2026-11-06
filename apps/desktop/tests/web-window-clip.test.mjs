import test from 'node:test';
import assert from 'node:assert/strict';
import {largestUnobstructedRect,intersectRect} from '../src/domain/web-window-clip.mjs';

const viewport={x:0,y:0,width:1000,height:800};

test('a window over the right edge leaves the full left strip for the guest',()=>{
  const clip=largestUnobstructedRect(viewport,[{key:'w',epoch:1,sequence:1,rect:{x:640,y:0,width:360,height:800}}]);
  assert.deepEqual(clip,{x:0,y:0,width:640,height:800});
});

test('a centered window keeps the largest strip, never a shrunk viewport',()=>{
  const clip=largestUnobstructedRect(viewport,[{key:'w',epoch:1,sequence:1,rect:{x:400,y:300,width:200,height:200}}]);
  // Left/right strips (400x800) beat top/bottom (1000x300) by area.
  assert.equal(clip.width*clip.height,400*800);
  assert.deepEqual([clip.x,clip.y,clip.width,clip.height].every(Number.isFinite),true);
  assert.ok(clip.width===400&&clip.height===800);
});

test('disjoint and malformed occlusion rows never clip the viewport',()=>{
  assert.deepEqual(largestUnobstructedRect(viewport,[{key:'w',rect:{x:2000,y:0,width:10,height:10}}]),viewport);
  assert.deepEqual(largestUnobstructedRect(viewport,[null,{key:'w',rect:{x:'x'}},{key:'w'}]),viewport);
  assert.deepEqual(largestUnobstructedRect(viewport,[]),viewport);
});

test('a window covering the whole viewport empties the visible area',()=>{
  // Every candidate strip is degenerate; the result may carry a zero measure
  // on one axis but never any visible area.
  const clip=largestUnobstructedRect(viewport,[{key:'w',rect:{x:-10,y:-10,width:5000,height:5000}}]);
  assert.equal(clip.width*clip.height,0);
});

test('intersectRect is containment-safe and empty when disjoint',()=>{
  assert.deepEqual(intersectRect({x:0,y:0,width:1000,height:800},{x:600,y:0,width:600,height:800}),{x:600,y:0,width:400,height:800});
  const disjoint=intersectRect({x:0,y:0,width:100,height:100},{x:200,y:0,width:50,height:50});
  assert.equal(disjoint.width*disjoint.height,0);
});
