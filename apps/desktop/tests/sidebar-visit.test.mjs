import test from 'node:test';import assert from 'node:assert/strict';
import {createSidebarVisit} from '../src/renderer/sidebar-visit.mjs';

test('project entry opens once; restores and responsive changes retain explicit collapse',()=>{
 const visit=createSidebarVisit();assert.equal(visit.enter(null),false);assert.equal(visit.enter('a'),true);visit.set(false);assert.equal(visit.enter('a'),false);assert.equal(visit.open,false);assert.equal(visit.enter('b'),true);visit.set(false);assert.equal(visit.enter('a'),true);assert.equal(visit.enter(null),false);assert.equal(visit.set(true),false);assert.equal(visit.enter('a'),true);
});
