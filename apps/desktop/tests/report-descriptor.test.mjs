import {openTestWorkspace} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {reportDescriptor,reportExtension,readStoredReport,reportSemanticText,decodeReportState,validReportDescriptor} from '../src/agents/managed/report-descriptor.mjs';
import {frontSource} from '../src/agents/managed/frontdesk-read.mjs';
import {validateReport} from '../src/agents/managed/report-review.mjs';

const HTML='<!doctype html><html><head><title>Frozen title</title><style>p { color: red; }</style></head><body><h1>Frozen conclusion</h1><p>Evidence &amp; result 😀</p></body></html>';
const MARKDOWN='# Legacy\r\n\r\nFrozen original 😀\r\n';
// Objects are content-addressed files of a registered project database; the
// old in-receipt text shape is gone, so reports are published through the real
// workspace and read back through the same immutable object store as production.
async function fixture(t,kind,body){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-report-consumer-')),content=path.join(base,'project');
 const store=await openTestWorkspace(path.join(base,'runtime'),content);
 t.after(async()=>{if(!store.closed)await store.close();await fs.rm(base,{recursive:true,force:true});});
 const submitted=await store.submit('task','brief',{name:'Test'});
 await store.activate(submitted.id);
 const work=store.find(submitted.id),receipt=await store.publish(work.id,work.revision,kind,body,randomUUID());
 return {store,work:store.find(work.id),receipt,bytes:Buffer.from(body),objectFile:(await store.storage.objects(store.projectId)).location(receipt.report.digest),recoveryFile:path.join(await store.storage.recoveryDirectory(store.projectId),'objects','sha256',receipt.report.digest)};
}

test('report state carries exact body digest and identity in descriptors and rejects inline text receipts',async t=>{
 const f=await fixture(t,'problem',MARKDOWN);
 const decoded=decodeReportState(f.store.state),receipt=decoded.receipts[0];
 assert.equal(decoded.schema,2);assert.equal(decoded.reportStateVersion,1);
 assert.equal(receipt.objectId,f.receipt.objectId);assert.equal(receipt.revision,f.work.revision);assert.equal(receipt.kind,'problem');
 assert.equal(Object.hasOwn(receipt,'text'),false);assert(validReportDescriptor(receipt.report));
 assert.equal(receipt.report.digest,reportDescriptor(f.bytes,{format:'markdown',objectId:receipt.objectId}).digest);
 assert.equal(reportExtension(receipt.report),'.md');
 assert.deepEqual(await readStoredReport(f.store,receipt),f.bytes);
 assert.throws(()=>decodeReportState({schema:2,reportStateVersion:1,receipts:[{objectId:receipt.objectId,text:MARKDOWN,revision:receipt.revision,kind:'problem'}]}));
 assert.throws(()=>decodeReportState({schema:2,receipts:[{objectId:receipt.objectId,text:MARKDOWN}]}));
});

test('frontdesk reads verified frozen HTML semantic text with descriptor digest and original revision',async t=>{
 const f=await fixture(t,'result',HTML);
 const source=await frontSource({store:f.store},'report:Test');
 assert(source.text.includes('Frozen conclusion'));assert(source.text.includes('Evidence & result 😀'));
 assert(!source.text.includes('<h1>'));assert(!source.text.includes('color: red'));
 assert.equal(source.version,f.receipt.report.digest);assert.equal(source.revision,f.work.revision);
 assert.equal(source.source,`objects/${f.receipt.objectId}.html`);
 await fs.writeFile(f.objectFile,'tampered');assert.equal((await frontSource({store:f.store},'report:Test')).version,f.receipt.report.digest);
 await fs.writeFile(f.recoveryFile,'tampered too');await assert.rejects(frontSource({store:f.store},'report:Test'));
});

test('report reader preserves Markdown bytes and candidate approval rejects changed report bytes',async t=>{
 const f=await fixture(t,'problem',MARKDOWN);
 assert.deepEqual(await readStoredReport(f.store,f.receipt),f.bytes);
 assert.equal(reportSemanticText(f.bytes,f.receipt.report),MARKDOWN);
 const candidate=await fixture(t,'result',HTML);
 assert.equal((await validateReport(candidate.store,candidate.work)).reportObjectId,candidate.receipt.objectId);
 await fs.writeFile(candidate.objectFile,'changed');await fs.writeFile(candidate.recoveryFile,'changed');await assert.rejects(validateReport(candidate.store,candidate.work));
});

test('report reads use a verified recovery copy when project objects become symlinks, rejecting untrusted copies',async t=>{
 const f=await fixture(t,'problem','frozen'),other=path.join(path.dirname(f.objectFile),'other');
 await fs.rename(f.objectFile,other);await fs.symlink(other,f.objectFile);
 assert.deepEqual(await readStoredReport(f.store,f.receipt),f.bytes);
 await fs.rename(f.recoveryFile,f.recoveryFile+'.old');await fs.symlink(other,f.recoveryFile);
 await assert.rejects(readStoredReport(f.store,f.receipt));
});
