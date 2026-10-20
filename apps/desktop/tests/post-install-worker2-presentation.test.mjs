import test from 'node:test';
import assert from 'node:assert/strict';
import {closurePresentation,curationPresentation} from '../src/domain/curation-presentation.mjs';

test('saved model prose cannot imply technical closure completed',()=>{
 const work={status:'ended',outcome:'accept',curated:true,curationText:'已提交并清理。',closure:{phase:'blocked',error:'target moved'}};
 const before=structuredClone(work),view=closurePresentation(work);
 assert.match(view.summary,/target moved/);
 assert.equal(view.rows.find(r=>r.stage==='cleanup').text.includes('已清理'),false);
 assert.equal(view.rows.find(r=>r.stage==='git').text.includes('已安全合入'),false);
 assert.equal(curationPresentation(work).evidence,work.curationText);
 assert.deepEqual(work,before);
});
test('completed resource cleanup is not inferred merely from business status ended',()=>{
 const pending=closurePresentation({status:'ended',outcome:'discard',closure:{phase:'cleanup'}});
 const complete=closurePresentation({status:'ended',outcome:'discard',closure:{phase:'complete',git:{status:'discarded'}}});
 assert.equal(pending.rows.find(r=>r.stage==='cleanup').text.includes('已清理'),false);
 assert.equal(complete.rows.find(r=>r.stage==='cleanup').text.includes('已清理'),true);
});
