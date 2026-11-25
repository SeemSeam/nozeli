import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeWorkbook} from '../src/renderer/sheet-readiness.mjs';

test('an early Fortune ref cannot enable edits or freeze an empty baseline before active-sheet materialization and formula commit',()=>{
 const frames=[],snapshots=[],expected=[{id:'first'},{id:'lazy'}];let sheets=[],calculations=0;
 const editor={getAllSheets:()=>sheets,getSheet:()=>sheets[0],calculateFormula(){calculations++;frames.push(()=>{sheets[0].data[0][0]={f:'=SUM(10,20)',v:30};});}};
 initializeWorkbook({current:()=>editor,expected,schedule:callback=>frames.push(callback),onReady:value=>snapshots.push(value)});
 frames.shift()();assert.equal(calculations,0);assert.equal(snapshots.length,0);
 sheets=[{id:'first',celldata:[]},{id:'lazy',celldata:[]}];frames.shift()();assert.equal(calculations,0);assert.equal(snapshots.length,0);
 sheets[0].data=[[{f:'=SUM(10,20)'}]];frames.shift()();assert.equal(calculations,1);assert.equal(snapshots.length,0);
 while(frames.length)frames.shift()();assert.equal(snapshots.length,1);assert.equal(snapshots[0][0].data[0][0].v,30);sheets[0].data[0][0].v=99;assert.equal(snapshots[0][0].data[0][0].v,30);
});

test('closing initialization before materialization never calculates or publishes ready',()=>{
 const frames=[];const cancel=initializeWorkbook({current:()=>null,expected:[],schedule:callback=>frames.push(callback),onReady(){assert.fail('closed surface');}});cancel();frames.shift()();assert.equal(frames.length,0);
});
