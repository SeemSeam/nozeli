#!/usr/bin/env node
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const root=process.env.NOZELI_LONG_REPORT_DATA,out=process.env.NOZELI_LONG_REPORT_FIDELITY_OUT;
if(!root||!out)throw Error('explicit actual long report runtime evidence and output required');
const source=await fs.readFile(path.join(root,'project/measurements.json'),'utf8'),data=JSON.parse(source),file=await fs.readFile(path.join(root,'project/outputs/long-report.md'),'utf8'),result=await fs.readFile(path.join(root,'actual-published-report.md'),'utf8');
const checks=[];for(const [name,text] of [['actual file',file],['published result',result]]){
 const parts=[...text.matchAll(/^## Case (\d+)\n([\s\S]*?)(?=^## Case |^## Verification|$(?![\s\S]))/gm)];assert.equal(parts.length,80,name+' 80 complete sections');
 for(const row of data.cases){const part=parts.find(m=>Number(m[1])===row.case)?.[2];assert(part,name+' section '+row.case);for(const field of ['measurementMs','observedRuns','disposition'])assert(part.includes(field+':'+row[field]),name+' '+row.case+' '+field);assert(part.includes(row.note),name+' '+row.case+' exact source note');for(const key of ['recoveryBytes','maxReleaseDelayMs'])if(row[key]!=null)assert(part.includes(key+':'+row[key]),name+' dispersed '+key);if(row.platformsNotTested)row.platformsNotTested.forEach(p=>assert(part.includes(p),name+' final limitation '+p));const citation=/\[S\]\(\.\.\/measurements\.json:(\d+)\)/.exec(part);assert(citation,name+' actual source line link');const line=source.split('\n')[Number(citation[1])-1];assert(line.includes('"case": '+row.case),name+' exact source record line '+row.case);}
 checks.push(name+' all80 exact measurements/run counts/dispositions/notes/line citations and dispersed fields');
}
const evidence={status:'PASS',checks,sourceBytes:Buffer.byteLength(source),fileBytes:Buffer.byteLength(file),resultChars:result.length,sourceSha256:createHash('sha256').update(source).digest('hex'),fileSha256:createHash('sha256').update(file).digest('hex')};await fs.writeFile(out,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
