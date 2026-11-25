import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {platformPersistence} from '../../platform/shared/persistence.mjs';

const MAX_TEXT=32*1024, MAX_BATCH=128*1024, MAX_ROWS=24, MAX_ENTRIES=256, MAX_VERSIONS=256, MAX_STATE=16*1024*1024;
const roles={frontdesk:'前台',orchestrator:'主控',worker:'工作 Agent'};
const REVIEWED='reviewed', CAPACITY='paracloud-capacity-v1';
const fail=(code,message)=>Object.assign(Error(message),{code});
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const scope=p=>typeof p?.id==='string'&&p.id&&p.id.length<=400&&typeof p.instanceId==='string'&&p.instanceId&&p.instanceId.length<=400?JSON.stringify([p.id,p.instanceId]):null;
const validRole=r=>typeof r==='string'&&Object.hasOwn(roles,r);
const validText=t=>typeof t==='string'&&t.trim()&&Buffer.byteLength(t)<=MAX_TEXT&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/.test(t)&&Buffer.from(t).toString('utf8')===t;
const validName=n=>typeof n==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(n);
const validCapability=c=>c===undefined||c===CAPACITY||c==='paracloud-jobs-v2';
const reviewedId=(key,name)=>'local-'+hash(JSON.stringify([REVIEWED,key,name])).slice(0,32);
// Runtime verifies digest against the exact UTF-8 text; bind capability to the version separately.
const reviewedRevision=(digest,capability,description)=>hash(JSON.stringify([REVIEWED,digest,capability??null,description])).slice(0,32);
const meta=({id,sourceId,name,description,compatibility,reason,bytes,resources=[]})=>({id,sourceId,name,description,compatibility,reason,bytes,resources});
function versionOf(c){
 const digest=hash(c.text),reviewed=c.sourceId===REVIEWED,capability=reviewed?c.artifact.capability:undefined;
 return {id:reviewed?reviewedId(c.sourceKey,c.name):'local-'+hash(c.id).slice(0,32),version:reviewed?reviewedRevision(digest,capability,c.description):digest.slice(0,32),digest,text:c.text,sourceId:c.sourceId,name:c.name,description:c.description,
  ...(reviewed?{sourceKey:c.sourceKey,...(capability!==undefined?{capability}:{})}:{})};
}
const payload=({id,version,digest,text,sourceId,capability},historical)=>Object.freeze({id,version,digest,text,...(historical&&sourceId===REVIEWED&&capability!==undefined?{capability}:{})});
const same=(a,b)=>a.id===b.id&&a.version===b.version;
const requireKeys=(p,keys)=>{if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!keys.includes(k)))throw fail('INVALID_PAYLOAD','本地技能参数无效。');};
const validLocatorPart=v=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\x00-\x1f\x7f]/.test(v);
const validRelPath=v=>validLocatorPart(v)&&!v.includes('\\')&&!v.includes(':')&&v.split('/').every(part=>part&&part!=='.'&&part!=='..');

async function reviewedArtifact(readReviewed,locator,instanceId){
 if(typeof readReviewed!=='function')throw fail('REVIEWED_REQUIRED','审核产物读取服务不可用。');
 const {text,name,description,digest,capability,provenance}=await readReviewed(locator)??{};
 if(!validText(text)||!validName(name)||typeof description!=='string'||description.length>240||hash(text)!==digest||!validCapability(capability)||!provenance||provenance.instanceId!==instanceId||provenance.workId!==locator.workId||provenance.objectId!==locator.objectId||provenance.relPath!==locator.relPath||provenance.digest!==digest||typeof provenance.commit!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(provenance.commit))throw fail('INVALID_REVIEWED','审核产物无效或来源不匹配。');
 return Object.freeze({text,name,description,digest,capability,commit:provenance.commit});
}

// Check every path component, not just the leaf. Refuse symlinks even when they
// point inside the root. Recheck identity after opening and before publication.
async function checkedPath(file){
 const absolute=path.resolve(file),{root}=path.parse(absolute);let current=root,last;
 for(const component of absolute.slice(root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,component);last=await fs.lstat(current);
  if(last.isSymbolicLink()||(current!==absolute&&!last.isDirectory()))throw fail('UNSAFE_PATH','不支持链接或非目录父路径。');
 }
 return last??fs.lstat(root);
}
const identity=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
async function readBounded(file,max){
 const before=await checkedPath(file);
 if(!before.isFile())throw fail('UNSAFE_FILE','不是普通文件。');
 if(before.size>max)throw fail('FILE_TOO_LARGE','文件超过大小上限。');
 const fd=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
 try{
  const opened=await fd.stat();if(!opened.isFile()||!identity(before,opened)||!identity(opened,await checkedPath(file)))throw fail('SOURCE_CHANGED','源文件变化。');
  const buffer=Buffer.alloc(opened.size+1);let offset=0;
  while(offset<buffer.length){const {bytesRead}=await fd.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
  if(offset!==opened.size||!identity(opened,await fd.stat())||!identity(opened,await checkedPath(file)))throw fail('SOURCE_CHANGED','源文件变化。');
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,offset));
 }finally{await fd.close();}
}
async function entries(dir){
 const before=await checkedPath(dir);if(!before.isDirectory())throw fail('UNSAFE_PATH','非目录。');
 const out=[];const handle=await fs.opendir(dir);
 try{for await(const entry of handle){if(out.length>=MAX_ENTRIES)throw fail('SCAN_LIMIT','目录条目超限。');out.push(entry);}}finally{await handle.close().catch(()=>{});}
 if(!identity(before,await checkedPath(dir)))throw fail('SOURCE_CHANGED','源目录变化。');
 return out.sort((a,b)=>a.name.localeCompare(b.name));
}
// Compatibility is a file-format check, not a restriction on the receiving
// Agent's existing tools. Metadata is not installed as executable config.
function compatible(text){return validText(text)&&!/^\uFEFF?---[ \t]*\r?\n/.test(text);}
function cleanFrontmatter(text){
 // Only name and description scalar metadata are recognized, never YAML eval.
 const m=/^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);if(!m)return {body:text,description:''};
 const lines=m[1].split(/\r?\n/);if(lines.some(line=>!/^\s*$|^(?:name|description):\s*[^\r\n]*$/.test(line)))return {body:text,description:''};
 return {body:text.slice(m[0].length),description:(lines.find(line=>line.startsWith('description:'))??'').slice(12).trim().slice(0,240)};
}

function resourceInventory(contents){
 const counts=new Map();for(const entry of contents){if(entry.name==='SKILL.md')continue;const kind=entry.isSymbolicLink()?'link':entry.isDirectory()?'directory':entry.isFile()?'file':'special';counts.set(kind,(counts.get(kind)??0)+1);}
 return [...counts].map(([kind,count])=>({kind,count}));
}

/** Local, data-only import; roots are scoped to documented user skill paths.
 * No project scan, recursive home scan, plugin cache, CLI invocation or auth read.
 * analyze({candidates,signal}) returns {candidates:[{id,analysis,portable,text?}]};
 * model adaptation is allowed only for host-validated self-contained text.
 */
export class LocalSkillImports{
 constructor(file,{home=os.homedir(),env=process.env}={}){
  this.file=file;this.serial=Promise.resolve();this.scanRecord=null;this.proposal=null;
  const root=(value,fallback)=>typeof value==='string'&&path.isAbsolute(value)?value:path.join(home,...fallback);
  // Claude Code ~/.claude/skills; Codex $CODEX_HOME/skills and ~/.agents/skills;
  // Pi $PI_CODING_AGENT_DIR/skills or ~/.pi/agent/skills; Gemini ~/.gemini/skills.
  this.catalog=[
   {id:'claude',name:'Claude Code',commands:['claude'],roots:[path.join(root(env.CLAUDE_CONFIG_DIR,['.claude']),'skills')]},
   {id:'codex',name:'Codex',commands:['codex'],roots:[path.join(root(env.CODEX_HOME,['.codex']),'skills'),path.join(home,'.agents','skills')]},
   {id:'pi',name:'Pi',commands:['pi'],roots:[path.join(root(env.PI_CODING_AGENT_DIR,['.pi','agent']),'skills')]},
   {id:'gemini',name:'Gemini CLI',commands:['gemini'],roots:[path.join(home,'.gemini','skills')]},
  ];
  this.binDirs=(env.PATH??'').split(path.delimiter).filter(p=>path.isAbsolute(p)).slice(0,64);
 }
 enqueue(run){const result=this.serial.then(run);this.serial=result.catch(()=>{});return result;}
 async #load(){
  try{
   const s=JSON.parse(await readBounded(this.file,MAX_STATE));
   if(s.schema!==1||!Array.isArray(s.versions)||s.versions.length>MAX_VERSIONS||!Array.isArray(s.grants)||s.grants.length>MAX_VERSIONS*3)throw Error();
   const unique=new Map();for(const v of s.versions){
    if(!validText(v.text)||hash(v.text)!==v.digest||!validName(v.name)||typeof v.description!=='string'||v.description.length>240||unique.has(v.id+v.version))throw Error();
    if(v.sourceId===REVIEWED){
     const [id,instanceId]=JSON.parse(v.sourceKey);
     if(scope({id,instanceId})!==v.sourceKey||v.id!==reviewedId(v.sourceKey,v.name)||!validCapability(v.capability)||v.version!==reviewedRevision(v.digest,v.capability,v.description))throw Error();
    }else if(v.sourceKey!==undefined||v.capability!==undefined||!compatible(v.text)||v.version!==v.digest.slice(0,32)||!/^local-[a-f0-9]{32}$/.test(v.id)||!this.catalog.some(c=>c.id===v.sourceId))throw Error();
    unique.set(v.id+v.version,v);
   }
   const grants=new Set();for(const g of s.grants){const v=unique.get(g.id+g.version);if(!validRole(g.role)||!v||grants.has(g.id+g.version+g.role)||!Array.isArray(g.enabled)||!Array.isArray(g.admitted)||g.enabled.some(k=>!g.admitted.includes(k))||g.admitted.some(k=>typeof k!=='string'||(v.sourceId===REVIEWED?k!==v.sourceKey:k.length>1024)))throw Error();grants.add(g.id+g.version+g.role);}
   return s;
  }catch(e){if(e.code==='ENOENT')return {schema:1,versions:[],grants:[]};throw fail('INVALID_STATE','本地技能记录损坏或超限。');}
 }
 async #save(s,assertCurrent,recheck){
  const text=JSON.stringify(s);if(Buffer.byteLength(text)>MAX_STATE||s.versions.length>MAX_VERSIONS)throw fail('STORE_LIMIT','本地技能库超限。');
  platformPersistence.requireSupported();
  const directory=path.dirname(this.file),tmp=this.file+'.'+randomUUID();let handle,published=false;
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  try{
   handle=await fs.open(tmp,'wx',0o600);await handle.writeFile(text);await platformPersistence.syncFileHandle(handle);await handle.close();handle=null;
   if(recheck){assertCurrent();await recheck();}
   assertCurrent();await fs.rename(tmp,this.file);published=true;
   await platformPersistence.syncDirectory(directory);
  }catch(error){
   if(published)throw fail('STORE_RESULT_UNKNOWN','安装记录已写入但耐久性未确认，请刷新已安装列表，不要重复提交。');
   throw error;
  }finally{await handle?.close();if(!published)await fs.rm(tmp,{force:true});}
 }
 async #sources(){
  const rows=[];for(const source of this.catalog){let status='unverified';
   for(const dir of source.roots){try{if((await checkedPath(dir)).isDirectory())status='skills-only';}catch{}}
   // A regular executable in a known PATH location is evidence of an entry,
   // not of version or functional usability; no command is launched.
   outer:for(const dir of this.binDirs)for(const command of source.commands){try{const file=path.join(dir,command+(process.platform==='win32'?'.exe':''));if((await checkedPath(file)).isFile()){await fs.access(file,constants.X_OK);status='installed';break outer;}}catch{}}
   rows.push({id:source.id,name:source.name,status});
  }return rows;
 }
 async #scan(sourceIds,key){
  if(!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.length>this.catalog.length||new Set(sourceIds).size!==sourceIds.length||sourceIds.some(id=>!this.catalog.some(s=>s.id===id)))throw fail('INVALID_SOURCE','请选择有效来源。');
  const candidates=[];let total=0;
  for(const source of this.catalog.filter(s=>sourceIds.includes(s.id)))for(const [rootIndex,root] of source.roots.entries()){
   let children;try{children=await entries(root);}catch(e){if(['ENOENT','UNSAFE_PATH'].includes(e.code))continue;throw e;}
   for(const child of children){if(!validName(child.name)||!child.isDirectory()||child.isSymbolicLink())continue;
    const dir=path.join(root,child.name),file=path.join(dir,'SKILL.md');let text,description='',compatibility='blocked',reason='技能入口无法核对。',bytes=0,resources=[];
    try{await checkedPath(file);}catch(e){if(!['UNSAFE_PATH'].includes(e.code)){if(e.code==='ENOENT')continue;throw e;}}
    try{
     const contents=await entries(dir);
     resources=resourceInventory(contents);
     // Read only the entry point. Companion contents are never read or sent.
     text=await readBounded(file,MAX_TEXT);if(!validText(text))throw fail('INVALID_TEXT','技能入口不是受支持的非空 UTF-8 文本。');
     bytes=Buffer.byteLength(text);const parsed=cleanFrontmatter(text);description=parsed.description;
     compatibility=compatible(parsed.body)?'compatible':'adaptation';reason=compatibility==='compatible'?'':'需将外部元数据转换为独立技能正文。';
     if(resources.length){compatibility='analysis-only';reason='有配套资源，仅可分析 SKILL.md；暂不可安装。';}
    }catch(error){text=undefined;bytes=0;reason=({UNSAFE_PATH:'入口或父路径含链接，未读取。',UNSAFE_FILE:'入口不是普通文件。',FILE_TOO_LARGE:'SKILL.md 超过 32 KiB。',INVALID_TEXT:'入口不是受支持的非空 UTF-8 文本。',ERR_ENCODING_INVALID_ENCODED_DATA:'入口不是有效 UTF-8。',SOURCE_CHANGED:'读取期间来源发生变化，请重新扫描。',SCAN_LIMIT:'目录条目超限。'})[error.code]||'技能入口读取失败或无法验证。';}
    if(candidates.length>=MAX_ROWS||total+bytes>MAX_BATCH)throw fail('SCAN_LIMIT','候选批次超限，请减少来源。');
    total+=bytes;candidates.push(Object.freeze({id:`${source.id}:${rootIndex}:${child.name}`,sourceId:source.id,name:child.name,description,compatibility,reason,bytes,text,resources}));
   }
  }
  return Object.freeze({scanId:randomUUID(),key,candidates:Object.freeze(candidates)});
 }
 async #analyze(scan,sent,analyze){
  if(typeof analyze!=='function')throw fail('ANALYZE_REQUIRED','分析服务不可用。');
  const controller=new AbortController();let timer,result;
  try{result=await Promise.race([Promise.resolve().then(()=>analyze({candidates:sent,signal:controller.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('ANALYZE_TIMEOUT','管理助手在 60 秒内未返回。未安装任何技能，所选来源已保留。'));},60000);})]);}finally{clearTimeout(timer);}
  if(!Array.isArray(result?.candidates)||result.candidates.length!==sent.length)throw fail('INVALID_ANALYSIS','分析结果不完整。');
  const byId=new Map();for(const row of result.candidates){if(!sent.some(c=>c.id===row?.id)||byId.has(row.id)||typeof row.analysis!=='string'||row.analysis.length>600||typeof row.portable!=='boolean'||(row.text!==undefined&&!validText(row.text)))throw fail('INVALID_ANALYSIS','分析记录无效。');byId.set(row.id,row);}
  let total=0;const candidates=sent.map(c=>{
   const row=byId.get(c.id);
   if(c.compatibility==='analysis-only')return Object.freeze({...meta(c),analysis:row.analysis});
   const text=cleanFrontmatter(row.text??c.text).body;
   if(!row.portable||!compatible(text))return Object.freeze({...meta(c),compatibility:'blocked',reason:!row.portable?'管理助手判定功能无法迁移。':'管理助手建议移植，但候选未通过宿主文本兼容检查；未安装。',analysis:row.analysis,original:c.text});
   total+=Buffer.byteLength(text);if(total>MAX_BATCH)throw fail('ANALYZE_LIMIT','拟安装文本超限。');
   return Object.freeze({...meta(c),compatibility:'compatible',reason:'',analysis:row.analysis,bytes:Buffer.byteLength(text),original:c.text,text,digest:hash(text),originalDigest:hash(c.text)});
  });
  return Object.freeze({proposalId:randomUUID(),key:scan.key,scanId:scan.scanId,candidates:Object.freeze(candidates)});
 }
 #preview(c){const row={...meta(c),...(c.sourceId===REVIEWED?{isPreview:true}:{analysis:c.analysis})};if(c.text){const v=versionOf(c);Object.assign(row,{skillId:v.id,version:v.version,digest:v.digest,preview:c.text});}return row;}
 #list(s,key){return s.versions.filter(v=>v.sourceId!==REVIEWED||v.sourceKey===key).map(({id,version,digest,sourceId,name,description})=>({id,version,digest,sourceId,name,description,...(sourceId===REVIEWED?{isPreview:false}:{}),roles:s.grants.filter(g=>g.id===id&&g.version===version).map(g=>({id:g.role,name:roles[g.role],enabled:key!==null&&g.enabled.includes(key)}))}));}
 #enable(s,g,key){for(const other of s.grants)if(other.id===g.id&&other.role===g.role)other.enabled=other.enabled.filter(k=>k!==key);if(!g.admitted.includes(key))g.admitted.push(key);g.enabled.push(key);}
 async invoke(action,p,{project,assertCurrent=()=>{},analyze,readReviewed}={}){
  const keys={sources:[],list:[],scan:['sourceIds'],analyze:['scanId','candidateIds'],reviewed:['workId','objectId','relPath'],install:['proposalId','grants','enable'],enable:['id','version','role'],disable:['id','version','role']};
  if(!Object.hasOwn(keys,action))throw fail('INVALID_ACTION','本地技能操作无效。');requireKeys(p,['projectId',...keys[action]]);
  const key=scope(project);if(p.projectId!==undefined&&p.projectId!==project?.id)throw fail('PROJECT_SCOPE_DENIED','项目作用域不匹配。');
  let locator,instanceId;
  if(action==='reviewed'){
   if(!key||p.projectId!==project.id)throw fail('PROJECT_SCOPE_DENIED','项目作用域不匹配。');
   const {workId,objectId,relPath}=p;
   if(!validLocatorPart(workId)||!validLocatorPart(objectId)||!validRelPath(relPath))throw fail('INVALID_PAYLOAD','审核产物定位无效。');
   locator=Object.freeze({workId,objectId,relPath});
   instanceId=project.instanceId;
  }
  return this.enqueue(async()=>{
   assertCurrent();
   if(action==='sources'){const rows=await this.#sources();assertCurrent();return rows;}
   if(action==='scan'){const scan=await this.#scan(p.sourceIds,key);assertCurrent();this.scanRecord=scan;this.proposal=null;return {scanId:scan.scanId,candidates:scan.candidates.map(meta)};}
   if(action==='analyze'){
    const scan=this.scanRecord;if(!scan||scan.scanId!==p.scanId||scan.key!==key)throw fail('STALE_SCAN','扫描已失效。');
    const ids=p.candidateIds;
    if(!Array.isArray(ids)||!ids.length||ids.length>scan.candidates.length||new Set(ids).size!==ids.length)throw fail('INVALID_SELECTION','请选择至少一项可分析技能，且不能重复选择。');
    const selected=new Set(ids),sent=Object.freeze(scan.candidates.filter(c=>selected.has(c.id)&&c.compatibility!=='blocked'));
    if(sent.length!==ids.length)throw fail('INVALID_SELECTION','所选技能不在本次扫描结果中或不可分析。');
    this.proposal=null;
    const proposal=await this.#analyze(scan,sent,analyze);assertCurrent();this.proposal=proposal;return {proposalId:proposal.proposalId,candidates:proposal.candidates.map(c=>this.#preview(c))};
   }
   if(action==='reviewed'){
    this.proposal=null;
    const artifact=await reviewedArtifact(readReviewed,locator,instanceId);assertCurrent();
    const {name,description,digest,text}=artifact;
    const candidate=Object.freeze({id:`${REVIEWED}:${name}`,sourceId:REVIEWED,sourceKey:key,name,description,digest,text,bytes:Buffer.byteLength(text),compatibility:'compatible',reason:'',artifact,locator,instanceId});
    const proposalId=randomUUID();this.proposal=Object.freeze({proposalId,key,candidates:Object.freeze([candidate])});
    return {proposalId,candidates:[this.#preview(candidate)]};
   }
   const s=await this.#load();assertCurrent();if(action==='list')return this.#list(s,key);
   if(action==='install'){
    const proposal=this.proposal;if(!proposal||proposal.proposalId!==p.proposalId||proposal.key!==key)throw fail('STALE_PROPOSAL','安装方案已失效。');
    if((p.enable!==undefined&&typeof p.enable!=='boolean')||(p.enable&&!key)||!Array.isArray(p.grants)||!p.grants.length||p.grants.length>MAX_ROWS)throw fail('INVALID_GRANT','安装授权无效。');
    const selected=new Set();let recheck;
    for(const grant of p.grants){requireKeys(grant,['candidateId','roles']);const c=proposal.candidates.find(c=>c.id===grant.candidateId),reviewed=c?.sourceId===REVIEWED;
     if(!c?.text||c.compatibility!=='compatible'||!(reviewed?validText(c.text):compatible(c.text))||selected.has(c.id)||!Array.isArray(grant.roles)||!grant.roles.length||grant.roles.length>3||new Set(grant.roles).size!==grant.roles.length||grant.roles.some(r=>!validRole(r)))throw fail('INVALID_GRANT','候选或角色授权无效。');
     if(hash(c.text)!==c.digest)throw fail('STALE_PROPOSAL','冻结内容校验失败。');
     if(reviewed){
      recheck=async()=>{
       try{if(!isDeepStrictEqual(c.artifact,await reviewedArtifact(readReviewed,c.locator,c.instanceId)))throw Error();}
       catch{throw fail('SOURCE_CHANGED','审核产物已变化或无法核对，请重新预览。');}
      };
     }else{
      if(hash(c.original)!==c.originalDigest)throw fail('STALE_PROPOSAL','冻结内容校验失败。');
      const [,rootIndex,name]=c.id.split(':');const root=this.catalog.find(s=>s.id===c.sourceId)?.roots[Number(rootIndex)];
      if(!root||!validName(name))throw fail('STALE_PROPOSAL','冻结来源无效。');
      const dir=path.join(root,name);try{const listing=await entries(dir);if(listing.length!==1||listing[0].name!=='SKILL.md'||!listing[0].isFile()||hash(await readBounded(path.join(dir,'SKILL.md'),MAX_TEXT))!==c.originalDigest)throw Error();}catch{throw fail('SOURCE_CHANGED','技能来源已变化，请重新扫描。');}
     }
     selected.add(c.id);const v=versionOf(c),existing=s.versions.find(x=>same(x,v));if(existing&&(existing.sourceId!==v.sourceId||(reviewed?!isDeepStrictEqual(existing,v):existing.digest!==v.digest)))throw fail('VERSION_CONFLICT','版本冲突。');if(!existing)s.versions.push(v);
     for(const role of grant.roles){let g=s.grants.find(g=>same(g,v)&&g.role===role);if(!g){g={id:v.id,version:v.version,role,enabled:[],admitted:[]};s.grants.push(g);}if(p.enable)this.#enable(s,g,key);}
    }
    await this.#save(s,assertCurrent,recheck);this.proposal=null;return this.#list(s,key);
   }
   if(!key||!validRole(p.role))throw fail('PROJECT_SCOPE_DENIED','项目或角色作用域无效。');
   const v=s.versions.find(v=>same(v,p));
   if(v?.sourceId===REVIEWED&&v.sourceKey!==key)throw fail('PROJECT_SCOPE_DENIED','项目作用域不匹配。');
   const g=s.grants.find(g=>same(g,p)&&g.role===p.role);if(!g)throw fail('NOT_INSTALLED','未向该角色开放技能。');
   if(action==='enable')this.#enable(s,g,key);else g.enabled=g.enabled.filter(k=>k!==key);
   await this.#save(s,assertCurrent);return this.#list(s,key);
  });
 }
 options(project,role,assertCurrent=()=>{}){return this.enqueue(async()=>{if(!scope(project)||!validRole(role))throw fail('PROJECT_SCOPE_DENIED','项目或角色作用域无效。');const s=await this.#load();assertCurrent();return this.#list(s,scope(project)).filter(v=>v.roles.some(r=>r.id===role&&r.enabled)).map(({roles:_,...v})=>v);});}
 authorize(selection,{project,role,assertCurrent=()=>{}}={}){requireKeys(selection,['id','version']);return this.#pin(selection,{project,role,assertCurrent},false);}
 resolve(ref,{project,role,assertCurrent=()=>{}}={}){requireKeys(ref,['id','version','digest','text']);return this.#pin(ref,{project,role,assertCurrent},true);}
 #pin(ref,{project,role,assertCurrent},historical){return this.enqueue(async()=>{
  const key=scope(project);if(!key||!validRole(role))throw fail('PROJECT_SCOPE_DENIED','项目或角色作用域无效。');const s=await this.#load();assertCurrent();
  const v=s.versions.find(v=>same(v,ref)),g=s.grants.find(g=>same(g,ref)&&g.role===role);
  if(!v||!g||(v.sourceId===REVIEWED&&v.sourceKey!==key)||!(historical?g.admitted:g.enabled).includes(key)||(historical&&v.digest!==ref.digest)||(ref.text!==undefined&&ref.text!==v.text))throw fail('STORE_SKILL_NOT_ENABLED','所选技能版本不可用。');
  return payload(v,historical);
 });}
}
