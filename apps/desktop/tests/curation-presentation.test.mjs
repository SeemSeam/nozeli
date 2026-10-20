import test from 'node:test';
import assert from 'node:assert/strict';
import {closurePresentation,curationPresentation} from '../src/domain/curation-presentation.mjs';

test('business end and resource cleanup have independent durable receipts',()=>{
 const work={id:'w',status:'ended',outcome:'accept',endedAt:'2026-10-18',closure:{decision:'accept',phase:'blocked',report:{relPath:'objects/report.md'},error:'target changed'}};
 const original=structuredClone(work),view=closurePresentation(work);
 assert.equal(view.rows.find(r=>r.stage==='decision').text.includes('接受'),true);
 assert.equal(view.rows.find(r=>r.stage==='report').text.includes('已持久保存'),true);
 assert.match(view.summary,/target changed/);
 assert.equal(view.rows.find(r=>r.stage==='cleanup').text.includes('已清理'),false);
 assert.deepEqual(work,original);
 work.closure.phase='complete';work.closure.git={status:'merged',commit:'abc123'};
 assert.match(closurePresentation(work).rows.find(r=>r.stage==='git').text,/abc123/);
 assert.equal(closurePresentation(work).rows.find(r=>r.stage==='cleanup').text.includes('已清理'),true);
});
test('discard is explicit and failed report or Git status does not invent it',()=>{
 const discarded=closurePresentation({status:'ended',outcome:'discard',closure:{phase:'complete',git:{status:'discarded'}}});
 assert.match(discarded.rows.find(r=>r.stage==='decision').text,/丢弃/);
 const unknown=closurePresentation({status:'ended',closure:{phase:'blocked',error:'execution failed'}});
 assert.equal(unknown.rows.find(r=>r.stage==='decision').text.includes('已丢弃'),false);
 assert.equal(closurePresentation({status:'review'}),null);
});
test('historical curation remains readable without acting as a cleanup receipt',()=>{
 const text='原始报告与尚未完成事项';
 const work={status:'ended',curated:true,curationText:text,closure:{phase:'blocked'}};
 assert.equal(curationPresentation(work).evidence,text);
 assert.equal(closurePresentation(work).rows.find(r=>r.stage==='cleanup').text.includes('已清理'),false);
});
