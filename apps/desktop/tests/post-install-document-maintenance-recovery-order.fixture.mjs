// Read-only diagnosis of the actual no-model recovery failure. No state/project writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const out=await fs.realpath(process.env.NOZELI_RECOVERY_DIAGNOSTIC_ROOT||'');assert(path.basename(out).startsWith('nozeli-document-recovery-fixture-'));
const result=JSON.parse(await fs.readFile(path.join(out,'result.json'))),state=JSON.parse(await fs.readFile(path.join(out,'failed-state.json'))),work=state.works[0],root=work.closure.executionEvidence.path.split('/evidence/closure/')[0],content=path.join(out,'project');
const {artifactSnapshot,validateReport}=await import(pathToFileURL(path.join(result.frozen,'app/src/agents/managed/report-review.mjs')));
const digest=b=>createHash('sha256').update(b).digest('hex'),before=await fs.readFile(path.join(root,'state.json')),index=await fs.readFile(path.join(content,'.git/index'));
const receipt=state.receipts.find(r=>r.objectId===work.result.objectId),expected=new Map(receipt.snapshot.files.map(f=>[f.relPath,{...f}]));
assert.equal(digest(await fs.readFile(path.join(root,'objects',receipt.objectId+'.md'))),receipt.snapshot.reportDigest);
for(const r of work.closure.maintenance.receipts.filter(r=>r.scope==='project-document')){const bytes=await fs.readFile(path.join(content,r.relPath));assert.equal(digest(bytes),r.afterDigest);expected.set(r.relPath,{relPath:r.relPath,digest:r.afterDigest,size:bytes.length});}
const actual=await artifactSnapshot(content,[...expected.keys()]),localeExpected=[...expected.values()].sort((a,b)=>a.relPath.localeCompare(b.relPath));for(const row of actual)assert.deepEqual(row,expected.get(row.relPath));assert.notEqual(JSON.stringify(actual),JSON.stringify(localeExpected));
let rejection;await assert.rejects(validateReport({state,root,content},work),e=>{rejection=e.message;return /成果文件已变化/.test(e.message);});
const agent=path.join(root,'agents/resident-orchestrator'),events=(await fs.readFile(path.join(agent,'recovery-fixture-events.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));const contexts=events.filter(e=>e.prompt.startsWith('用户已明确正常结束')).map(e=>JSON.parse(e.prompt.split('任务与有界原文/读取索引：\n')[1])),current=contexts.find(c=>c.revision===2);assert.equal(current.facts.reviewApproval.status,'accepted');assert.equal(current.facts.reviewApproval.reportObjectId,work.acceptance.reportObjectId);const manual=state.jobs.find(j=>j.type==='manual'&&j.target===work.id);assert.equal(manual.text,result.userText);const input=current.recentInputs.find(i=>i.source==='runtime/state.json#job:'+manual.id);assert(input);assert.equal(input.status,'completed');assert(input.readRef);
assert.deepEqual(await fs.readFile(path.join(root,'state.json')),before);assert.deepEqual(await fs.readFile(path.join(content,'.git/index')),index);
await fs.writeFile(path.join(out,'ordering-diagnosis.json'),JSON.stringify({status:'REPRODUCED',modelEvidence:false,rejection,allPerPathBytesMatch:true,actual,localeExpected,actualOrder:actual.map(f=>f.relPath),expectedOrder:localeExpected.map(f=>f.relPath),actualCurationContext:current,userTestSource:input.source,inlineTestTextDelivered:input.complete&&input.text===result.userText,workId:work.id,stateAndIndexUnchanged:true},null,2));console.log(JSON.stringify({status:'REPRODUCED',out,allPerPathBytesMatch:true,rejection,actualOrder:actual.map(f=>f.relPath),expectedOrder:localeExpected.map(f=>f.relPath),stateAndIndexUnchanged:true}));
