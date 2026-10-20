import test from 'node:test';
import assert from 'node:assert/strict';
import {lineAuthorship,groupAuthorship,groupTitle,groupScope} from '../src/domain/authorship-groups.mjs';
import {userActor,agentActor} from '../src/domain/document-changes.mjs';

const a1=agentActor('project','qa',{provider:'codex'}),a2=agentActor('project','task',{provider:'codex'});
const item=(from,to,actor=userActor,revision=1)=>({from,to,eventId:'batch-'+revision,actor,revision,time:`2026-10-${String(revision).padStart(2,'0')}T00:00:00Z`});
const attribution=(spans,points=[])=>({docId:'doc',revision:10,digest:'abc',spans,points});

test('200 same-actor lines merge across events while every batch/time is retained',()=>{
  const text='word\n'.repeat(200),value=attribution([item(0,300,a1,1),item(300,650,a1,2),item(650,1000,a1,3)]);
  const groups=lineAuthorship(text,value);
  assert.equal(groups.length,1);assert.deepEqual([groups[0].line,groups[0].endLine],[1,200]);
  assert.deepEqual(new Set(groups[0].items.map(i=>i.eventId)),new Set(['batch-1','batch-2','batch-3']));
  assert.match(groupTitle(groups[0]),/3批/);assert.match(groupTitle(groups[0]),/最早.*最新/);
  assert.deepEqual(groupScope(groups[0]),{docId:'doc',revision:10,digest:'abc',from:0,to:1000,actorIds:[a1.id],kind:'text'});
  assert.equal(value.spans.length,3);
});
test('unknown lines and blank lines interrupt; only an attributed newline joins a blank row',()=>{
  const text='aa\n\nbb\ncc\ndd';
  assert.deepEqual(lineAuthorship(text,attribution([item(0,3,a1),item(4,6,a1),item(10,12,a1)])).map(g=>[g.line,g.endLine]),[[1,1],[3,3],[5,5]]);
  assert.deepEqual(lineAuthorship(text,attribution([item(0,6,a1)])).map(g=>[g.line,g.endLine]),[[1,3]]);
});
test('mixed lines stand alone, keep same-actor multiple batches and distinguish same-provider agents',()=>{
  const groups=lineAuthorship('abc\ndef\nghi\njkl',attribution([item(0,4,a1,1),item(4,5,a1,2),item(5,6,a1,3),item(6,7,a2,4),item(8,11,a1,5),item(12,15,a2,6)]));
  assert.equal(groups.length,4);assert.equal(groups[1].actorIds.length,2);assert.equal(groups[1].items.length,3);
  assert.deepEqual(groups.map(g=>g.line),[1,2,3,4]);
});
test('pure deletion has a separate point and never connects or owns neighboring text',()=>{
  const point={...item(3,3,a2,2)};delete point.to;
  const groups=lineAuthorship('abc\ndef',attribution([item(0,3,a1),item(4,7,a1)], [point]));
  assert.equal(groups.filter(g=>g.kind==='text').length,1);
  const deletion=groups.find(g=>g.kind==='deletion');assert.deepEqual([deletion.from,deletion.to],[3,3]);
  assert.deepEqual(deletion.actorIds,[a2.id]);assert.deepEqual(groups[0].actorIds,[a1.id]);
});
test('Markdown unmarked blocks and structural containers break grouping; layout spacing does not',()=>{
  const parent={},heading={},units=[{from:0,to:2,boundary:parent},{from:4,to:6,boundary:parent},{from:8,to:10,boundary:heading},{from:12,to:14,boundary:parent},{from:16,to:18,boundary:parent},{from:20,to:22,boundary:parent}];
  const groups=groupAuthorship(units,attribution([item(0,14,a1),item(20,22,a1)]));
  assert.deepEqual(groups.map(g=>[g.from,g.to]),[[0,6],[8,10],[12,14],[20,22]]);
});
test('pending input has no confirmed time; saved batches retain full dates and UTF-16 offsets',()=>{
  const value=attribution([item(2,4,userActor,1),{...item(4,6,userActor,2),pending:true,time:'2099-01-01T00:00:00Z'}]);
  const [group]=lineAuthorship('😀abcd',value);
  assert.equal(group.pending,true);assert.equal(group.items.length,2);
  assert.match(groupTitle(group),/1批.*2026/);assert.match(groupTitle(group),/尚无确认时间/);assert.doesNotMatch(groupTitle(group),/2099/);
});
