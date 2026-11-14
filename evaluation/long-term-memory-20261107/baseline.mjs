import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ContextReader,memoryContext} from '../../apps/desktop/src/agents/managed/context-reader.mjs';
import {MemoryVersion} from '../../apps/desktop/src/agents/managed/memory-version.mjs';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-memory-baseline-'));
const text='# Plan Tree\n'+Array.from({length:3},(_,i)=>`<!-- report:r${i} -->\n- 双星混沌 PPT revision ${i+1}; user ${i===2?'discard':'accept'}\n<!-- /report:r${i} -->`).join('\n');
const report={scope:'Synthetic baseline; no user project read',runtime:process.version,platform:process.platform,arch:process.arch,directory};
report.markerClassification=memoryContext(text,'双星',new ContextReader());
const topics=Array.from({length:9},(_,i)=>({path:`topics/t${i}.md`,text:`# 双星 ${i}\n${'无关正文。'.repeat(150)}混沌目标段落${i}`}));
report.topK=memoryContext('# Plan Tree','混沌',new ContextReader(),topics);
await fs.mkdir(path.join(directory,'topics'));
await fs.writeFile(path.join(directory,'index.md'),'# Plan Tree\n[中文](topics/双星.md)\n[anchor](topics/plain.md#section)\n[plain](topics/plain.md)\n[nested](topics/sub/deep.md)\n[missing](topics/missing.md)');
await fs.writeFile(path.join(directory,'topics','双星.md'),'# 中文主题');
await fs.writeFile(path.join(directory,'topics','plain.md'),'# Plain\n[child](topics/child.md)');
report.snapshot=await new MemoryVersion(directory).snapshot();
const reader=new ContextReader();let ref=reader.add('双星🙂\n'.repeat(4000),{source:'synthetic/frozen',title:'long'}),joined='';const ranges=[];
while(ref){const page=reader.read(ref,{maxBytes:2048,maxResultBytes:4096});joined+=page.text;ranges.push([page.offset,page.endOffset]);ref=page.nextReadRef;}
report.frozenRead={pages:ranges.length,ranges,exact:joined==='双星🙂\n'.repeat(4000)};
const db=new DatabaseSync(':memory:');
report.sqlite={version:db.prepare('select sqlite_version() version').get().version,compile:db.prepare('pragma compile_options').all()};
for(const tokenizer of ['unicode61','trigram']){db.exec(`create virtual table f_${tokenizer} using fts5(body,tokenize='${tokenizer}')`);db.prepare(`insert into f_${tokenizer}(body) values (?)`).run('双星混沌 binary chaos finishClosure');report.sqlite[tokenizer]=Object.fromEntries(['双星','混沌','双星混沌','finishClosure'].map(q=>[q,db.prepare(`select count(*) n from f_${tokenizer} where f_${tokenizer} match ?`).get(q).n]));}
db.close();
report.observations={reportBlocksBecomeSingleIndex:report.markerClassification.sections===1&&report.markerClassification.historyMatches.length===0,topicHitsCappedAtFour:report.topK.matches.length===4,matchingPassageAbsentFromPreview:report.topK.matches.every(m=>!m.preview.includes('混沌目标')),recognizedTopicPaths:report.snapshot.topics.map(t=>t.path)};
await fs.writeFile(new URL('./baseline-report.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify({observations:report.observations,frozenRead:report.frozenRead.exact,sqlite:report.sqlite.version,tokenizer:{unicode61:report.sqlite.unicode61,trigram:report.sqlite.trigram}},null,2));
await fs.rm(directory,{recursive:true,force:true});
