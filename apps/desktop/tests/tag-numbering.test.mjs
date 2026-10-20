import test from 'node:test';
import assert from 'node:assert/strict';
import { tagDisplayOrdinals } from '../src/renderer/tag-numbering.mjs';
test('categories count independently, close gaps and ignore hidden projections',()=>{
  const notes=[{id:'n1',ordinal:12},{id:'c1',projection:{}},{id:'n2',ordinal:18}];
  const conversations=[{id:'c1'},{id:'c2',removed:true},{id:'c3'}];
  assert.deepEqual([...tagDisplayOrdinals(notes,conversations)],[['n1',1],['n2',2],['c1',1],['c3',2]]);
  assert.deepEqual([...tagDisplayOrdinals(notes.filter(n=>n.id!=='n1'),conversations)],[['n2',1],['c1',1],['c3',2]]);
});
