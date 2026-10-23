import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {reportDescriptor,reportExtension,readStoredReport,reportSemanticText,decodeReportState,validReportDescriptor} from '../src/agents/managed/report-descriptor.mjs';
import {frontSource} from '../src/agents/managed/frontdesk-read.mjs';
import {validateReport} from '../src/agents/managed/report-review.mjs';

async function fixture(t,format,body){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-report-consumer-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'objects'));
 const bytes=Buffer.from(body),objectId=randomUUID(),report=reportDescriptor(bytes,{format,objectId,title:'Frozen title',excerpt:'Frozen summary'}),receipt={id:randomUUID(),workId:'work',objectId,kind:'result',revision:3,report,snapshot:{reportDigest:report.digest,files:[]}};
 await fs.writeFile(path.join(root,'objects',objectId+reportExtension(report)),bytes);
 const work={id:'work',name:'Test',revision:3,result:{objectId,revision:3}},store={root,content:root,state:{schema:2,reportStateVersion:1,works:[work],receipts:[receipt]}};
 return {store,receipt,report,bytes,work,file:path.join(root,'objects',objectId+reportExtension(report))};
}

test('historical Markdown migration preserves exact body digest and identity without retaining inline text',()=>{
 const objectId=randomUUID(),body='# Legacy\r\n\r\n原字节 😀\r\n',state={schema:2,receipts:[{objectId,text:body,revision:7,kind:'result'}]};
 const decoded=decodeReportState(state),receipt=decoded.receipts[0];assert.equal(decoded.schema,2);assert.equal(decoded.reportStateVersion,1);assert.equal(receipt.objectId,objectId);assert.equal(receipt.revision,7);assert.equal(Object.hasOwn(receipt,'text'),false);assert(validReportDescriptor(receipt.report));assert.equal(receipt.report.digest,reportDescriptor(Buffer.from(body),{format:'markdown',objectId}).digest);assert.equal(reportExtension(receipt.report),'.md');
});

test('frontdesk reads verified frozen HTML semantic text with descriptor digest and original revision',async t=>{
 const f=await fixture(t,'html-static','<!doctype html><html><head><title>Frozen title</title><style>p { color: red; }</style></head><body><h1>Frozen conclusion</h1><p>Evidence &amp; result 😀</p></body></html>');
 const source=await frontSource({store:f.store},'report:Test');assert(source.text.includes('Frozen conclusion'));assert(source.text.includes('Evidence & result 😀'));assert(!source.text.includes('<h1>'));assert(!source.text.includes('color: red'));assert.equal(source.version,f.report.digest);assert.equal(source.revision,3);assert.equal(source.source,`objects/${f.receipt.objectId}.html`);
 await fs.writeFile(f.file,'tampered');await assert.rejects(frontSource({store:f.store},'report:Test'));
});

test('legacy report reader preserves Markdown bytes and candidate approval rejects changed report bytes',async t=>{
 const f=await fixture(t,'markdown','# Legacy\r\n\r\nFrozen original 😀\r\n');assert.deepEqual(await readStoredReport(f.store,f.receipt),f.bytes);assert.equal(reportSemanticText(f.bytes,f.report),f.bytes.toString());assert.equal((await validateReport(f.store,f.work)).reportObjectId,f.receipt.objectId);
 await fs.writeFile(f.file,'changed');await assert.rejects(validateReport(f.store,f.work));
});

test('report read rejects symbolic and hard linked objects instead of following another authority',async t=>{
 const f=await fixture(t,'markdown','frozen'),other=path.join(f.store.root,'other.md');await fs.rename(f.file,other);await fs.symlink(other,f.file);await assert.rejects(readStoredReport(f.store,f.receipt));await fs.unlink(f.file);await fs.link(other,f.file);await assert.rejects(readStoredReport(f.store,f.receipt));
});
