// Selection probe only. No production IPC/UI and no user project input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
const [binary,reportPath,...extra]=process.argv.slice(2);
assert(binary&&path.isAbsolute(binary)&&reportPath&&path.isAbsolute(reportPath)&&!extra.length,'Usage: node engine-probe.mjs /absolute/rg /absolute/report.json');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-search-probe-'));
const checks=[],measurements=[];const env={...process.env};delete env.RIPGREP_CONFIG_PATH;
function run(args,{cwd=root}={}){
 return new Promise((resolve,reject)=>{
  const started=performance.now(),child=spawn(binary,['--no-config',...args],{cwd,env,shell:false,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',firstMs=null;child.stdout.on('data',chunk=>{firstMs??=performance.now()-started;stdout+=chunk;if(stdout.length>8*1024*1024)child.kill();});child.stderr.on('data',chunk=>stderr+=chunk);
  child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr,firstMs,totalMs:performance.now()-started}));
 });
}
const round=n=>n===null?null:+n.toFixed(2);
async function check(name,fn){await fn();checks.push(name);}
async function search(query,flags=[]){const r=await run(['--json',...flags,'--',query,'.']);assert([0,1].includes(r.code),r.stderr);return {...r,matches:r.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==='match').map(row=>row.data)};}
let failure;
try{
 const version=await run(['--version']);assert.equal(version.code,0);
 const dir='中文 空格目录',file=dir+'/论文.txt';await fs.mkdir(path.join(root,dir));
 const body='第一行\r\n前缀😀 模型 模型 后缀\r\nliteral a.b and axb\r\n';
 await fs.writeFile(path.join(root,file),body);await fs.writeFile(path.join(root,'.ignore'),'ignored.txt\nignored-dir/\n');
 await fs.writeFile(path.join(root,'ignored.txt'),'模型');await fs.mkdir(path.join(root,'ignored-dir'));await fs.writeFile(path.join(root,'ignored-dir','other.txt'),'模型');await fs.writeFile(path.join(root,'.hidden.txt'),'模型');await fs.writeFile(path.join(root,'binary.bin'),Buffer.from('binary\0模型'));
 await check('two-character Chinese, spaced Unicode path, CRLF line and UTF-8 ranges',async()=>{
  const r=await search('模型',['--fixed-strings']);assert.equal(r.matches.length,1);const m=r.matches[0];assert.equal(m.path.text.split(path.sep).join('/'),'./'+file);assert.equal(m.line_number,2);assert.equal(m.submatches.length,2);
  const bytes=Buffer.from(m.lines.text);for(const hit of m.submatches){assert.equal(bytes.subarray(hit.start,hit.end).toString(),'模型');const prefix=bytes.subarray(0,hit.start).toString();assert.equal(prefix.length,hit===m.submatches[0]?5:8);}
  assert.equal(m.absolute_offset,Buffer.byteLength('第一行\r\n'));assert.equal(m.submatches[0].start,11);
 });
 await check('literal punctuation differs from explicit regex',async()=>{assert.equal((await search('a.b',['--fixed-strings'])).matches[0].submatches.length,1);assert.equal((await search('a.b')).matches[0].submatches.length,2);});
 await check('ignore rules, hidden and binary inputs excluded by default',async()=>{const r=await search('模型',['--fixed-strings']);assert(r.matches.every(m=>m.path.text.includes('论文.txt')));});
 await check('no-match exit 1 and invalid-regex exit 2 remain distinct',async()=>{assert.equal((await search('NO_MATCH_4389',['--fixed-strings'])).code,1);assert.equal((await run(['--json','--','[','.'])).code,2);});
 if(process.platform!=='win32')await check('outside-project directory symlink is not traversed by default',async()=>{
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-search-outside-'));
  try{await fs.writeFile(path.join(outside,'external.txt'),'OUTSIDE_PROJECT_4389');await fs.symlink(outside,path.join(root,'external-link'),'dir');assert.equal((await search('OUTSIDE_PROJECT_4389',['--fixed-strings'])).code,1);}finally{await fs.rm(path.join(root,'external-link'),{force:true});await fs.rm(outside,{recursive:true,force:true});}
 });
 const count=10505,bytesPerFile=4096;await fs.mkdir(path.join(root,'scale'));
 for(let offset=0;offset<count;offset+=100)await Promise.all(Array.from({length:Math.min(100,count-offset)},(_,i)=>{
  const index=offset+i,text=index===count-1?'SCALE_LAST_RESOURCE_4389\n':'ordinary small text\n';return fs.writeFile(path.join(root,'scale',String(index).padStart(5,'0')+'.txt'),text.padEnd(bytesPerFile,'x'));
 }));
 await check('more than 10,000 files search without a hidden traversal ceiling',async()=>{
  for(let i=0;i<4;i++){const r=await search('SCALE_LAST_RESOURCE_4389',['--fixed-strings']);assert.equal(r.matches.length,1);assert(r.matches[0].path.text.endsWith('10504.txt'));measurements.push({iteration:i+1,firstOutputMs:round(r.firstMs),totalMs:round(r.totalMs)});}
 });
 await check('cancel a running stream and receive terminal close',async()=>{
  const started=performance.now();await new Promise((resolve,reject)=>{
   const child=spawn(binary,['--no-config','--json','--fixed-strings','--','x','-'],{env,shell:false,stdio:['pipe','pipe','pipe']});let cancelledAt,seen=false;let stderr='';
   const timer=setTimeout(()=>{child.kill();reject(Error('Cancellation probe timed out'));},5000);
   child.on('error',reject);child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',()=>{if(seen)return;seen=true;cancelledAt=performance.now();assert(child.kill());});child.stdin.on('error',()=>{});child.stdin.write('x\n'.repeat(10000));
   child.once('close',(code,signal)=>{clearTimeout(timer);try{assert(seen,stderr);assert(signal||code!==0);measurements.push({cancelCloseMs:round(performance.now()-cancelledAt),streamLifetimeMs:round(performance.now()-started),code,signal});resolve();}catch(error){reject(error);}});
  });
 });
 await fs.mkdir(path.dirname(reportPath),{recursive:true});
 await fs.writeFile(reportPath,JSON.stringify({ok:true,platform:process.platform,arch:process.arch,node:process.version,binary,version:version.stdout.split('\n')[0],binaryBytes:(await fs.stat(binary)).size,checks,scale:{files:count,bytes:count*bytesPerFile},measurements,scope:'Real engine selection only; synthetic files, no product UI/IPC, no unsaved-buffer implementation; first call is not an OS-cache-cold measurement; no cross-platform claim.'},null,2));
 console.log(await fs.readFile(reportPath,'utf8'));
}catch(error){failure=error;console.error(error);process.exitCode=1;await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify({ok:false,checks,measurements,error:error.stack},null,2));}
finally{await fs.rm(root,{recursive:true,force:true});}
