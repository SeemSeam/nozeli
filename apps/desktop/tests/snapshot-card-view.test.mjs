import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateLegacyCardOffset,consumableLegacyCardOffset,cardWindowOwnerId} from '../src/renderer/snapshot-card-view.mjs';

const fresh=()=>({schema:1,revision:0,placement:{mode:'auto'},size:null,collapsed:false,hidden:false});

test('a measurable legacy displacement converts once into an absolute manual placement',()=>{
  const view=migrateLegacyCardOffset(fresh(),[120.4,-60.6],[300,200]);
  assert.deepEqual(view.placement,{mode:'manual',x:420,y:139});
});

test('an already committed or manual view is never re-migrated',()=>{
  const committed={...fresh(),revision:1};
  assert.equal(migrateLegacyCardOffset(committed,[50,50],[300,200]),committed);
  const manual={...fresh(),placement:{mode:'manual',x:10,y:10}};
  assert.equal(migrateLegacyCardOffset(manual,[50,50],[300,200]),manual);
  assert.equal(migrateLegacyCardOffset({schema:2,revision:0},[50,50],[300,200]).schema,2);
});

test('an unmeasurable natural position keeps auto placement and never consumes the record',()=>{
  assert.equal(migrateLegacyCardOffset(fresh(),[50,50],null).placement.mode,'auto');
  assert.equal(consumableLegacyCardOffset([50,50],null),null);
  assert.equal(consumableLegacyCardOffset([50,50],[300,200]).length,2);
  assert.equal(consumableLegacyCardOffset([50,'x'],[300,200]),null);
  assert.equal(consumableLegacyCardOffset(null,[300,200]),null);
});

test('window lineage identity: record-carried, fork-stable, session-minted',()=>{
  // A record (or its recovery fork) that already carries the field reuses it.
  assert.equal(cardWindowOwnerId({windowOwnerId:'snapwin-cap-1'},'cap-fork-9'),'snapwin-cap-1');
  assert.equal(cardWindowOwnerId({windowOwnerId:'snapwin-cap-1'}),'snapwin-cap-1');
  // A first open mints from its own capture session — two independent
  // doodles (even over an identical frozen view) never share an identity.
  assert.equal(cardWindowOwnerId(null,'cap-1'),'snapwin-cap-1');
  assert.equal(cardWindowOwnerId({},'cap-2'),'snapwin-cap-2');
  assert.notEqual(cardWindowOwnerId(null,'cap-1'),cardWindowOwnerId(null,'cap-2'));
  // Malformed inputs never mint.
  assert.equal(cardWindowOwnerId(null,''),null);
  assert.equal(cardWindowOwnerId({windowOwnerId:7},'cap-1'),'snapwin-cap-1');
});
