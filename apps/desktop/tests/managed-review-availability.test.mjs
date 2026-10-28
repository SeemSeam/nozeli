import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewInlineAvailable,reviewVersionAvailable,reviewStaleMessage,reviewReportOutdated} from '../src/renderer/managed-review-availability.mjs';
const file={change:'modified',candidateText:'candidate',baselineText:'base',candidateDigest:'c',baselineDigest:'b',draft:null};
test('omitted binary and large Markdown never become empty editable documents',()=>{
 for(const side of ['candidateOmitted','baselineOmitted'])for(const reason of ['size','binary'])assert.equal(reviewInlineAvailable({...file,[side]:reason}),false);
 assert.equal(reviewInlineAvailable({...file,candidateText:null}),false);
 assert.equal(reviewInlineAvailable({...file,baselineText:null}),false);
 assert.equal(reviewInlineAvailable({...file,draft:{revision:1,text:null}}),false);
 assert.equal(reviewInlineAvailable(file),true);
});
test('only explicit absent added/removed sides may use empty comparison text',()=>{
 assert.equal(reviewInlineAvailable({...file,change:'added',baselineText:null,baselineDigest:null}),true);
 assert.equal(reviewInlineAvailable({...file,change:'removed',candidateText:null,candidateDigest:null}),true);
 assert.equal(reviewInlineAvailable({...file,change:'modified',candidateText:null,candidateDigest:null}),false);
});
test('missing review snapshot tokens cannot authorize actions or break status rendering',()=>{
 for(const reviewVersion of [null,undefined,'',0])assert.equal(reviewVersionAvailable({reviewVersion}),false);
 assert.equal(reviewVersionAvailable({reviewVersion:'abc'}),true);
});
test('human draft report warning depends on reviewed bytes rather than publication staleness',()=>{
 assert.equal(reviewReportOutdated([file]),false);
 assert.equal(reviewReportOutdated([{...file,draft:{textDigest:'human'}}]),true);
 assert.equal(reviewReportOutdated([{...file,draft:{textDigest:'c'}}]),false);
});
test('stale object details never leak object coercion into warning text',()=>{
 assert.match(reviewStaleMessage({code:'SUPERSEDED',detail:{reason:'new-round'}}),/旧报告/);
 assert.match(reviewStaleMessage({code:'WORKTREE_DRIFT',detail:{paths:['a.md']}}),/并发修改/);
 assert(!reviewStaleMessage({detail:{reason:'unknown'}}).includes('[object Object]'));
 assert.equal(reviewStaleMessage(null),'');
});
