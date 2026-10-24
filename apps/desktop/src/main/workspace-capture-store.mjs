import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CAPTURE_PIXELS} from '../domain/workspace-capture.mjs';
import {validateDrawing} from '../domain/region-drawing.mjs';

const FROZEN_LIMIT=192*1024*1024,DRAFT_LIMIT=16*1024*1024,RESULT_LIMIT=2*1024*1024;
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{8,160}$/.test(id);
const dimensions=(width,height)=>Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width<=20000&&height<=20000&&width*height<=CAPTURE_PIXELS;

/** Recoverable frozen evidence is never recaptured or garbage-collected here.
 * Writes for a capture are ordered, atomically published and durably flushed. */
export class WorkspaceCaptureStore {
 constructor({directory,maxBytes=512*1024*1024,maxCaptures=64}){
  if(!path.isAbsolute(directory)||!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxCaptures)||maxCaptures<1)throw Error('捕获存储配置无效');
  Object.assign(this,{directory,maxBytes,maxCaptures});this.flights=new Map();this.capacityFlight=Promise.resolve();
 }
 file(id,suffix=''){if(!validId(id))throw Error('捕获身份无效');return path.join(this.directory,id+suffix+'.json');}
 serial(id,fn){this.file(id);const operation=(this.flights.get(id)||Promise.resolve()).catch(()=>{}).then(fn);this.flights.set(id,operation);void operation.finally(()=>{if(this.flights.get(id)===operation)this.flights.delete(id);}).catch(()=>{});return operation;}
 async ensure(){await fs.mkdir(this.directory,{recursive:true,mode:0o700});const stat=await fs.lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('捕获目录不安全');}
 async read(id,suffix,limit,optional=false){
  await this.ensure();let handle;
  try{handle=await fs.open(this.file(id,suffix),constants.O_RDONLY|(constants.O_NOFOLLOW||0));const stat=await handle.stat();if(!stat.isFile()||stat.size>limit)throw Error('捕获记录类型或容量无效');const bytes=await handle.readFile();if(bytes.length>limit)throw Error('捕获记录过大');const value=JSON.parse(bytes.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('捕获记录损坏');return value;}
  catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}finally{await handle?.close();}
 }
 async capacity(file,bytes,projectId){
  let total=0,count=0,existing=0;
  for(const entry of await fs.readdir(this.directory,{withFileTypes:true})){
   if(!entry.name.endsWith('.json')||entry.name.startsWith('.pending-'))continue;
   const stat=await fs.lstat(path.join(this.directory,entry.name));if(!stat.isFile()||stat.isSymbolicLink())throw Error('捕获目录包含不安全记录');
   total+=stat.size;
   if(!/\.(drawing|result)\.json$/.test(entry.name)){
    const id=entry.name.slice(0,-5);
    if(validId(id)){const record=await this.read(id,'',FROZEN_LIMIT);if(record.projectId===projectId)count++;}
   }
   if(path.join(this.directory,entry.name)===file)existing=stat.size;
  }
  const newCapture=!existing&&!/\.(drawing|result)\.json$/.test(file);
  if(total-existing+bytes>this.maxBytes||count+Number(newCapture)>this.maxCaptures)throw Error('捕获恢复存储已满；原有材料未删除');
 }
 async write(id,suffix,value,limit){
  const text=JSON.stringify(value),bytes=Buffer.byteLength(text);if(bytes>limit)throw Error('捕获记录超过容量上限');
  // Capacity reservations and publication are shared across different capture IDs.
  const operation=this.capacityFlight.catch(()=>{}).then(async()=>{
   await this.ensure();const target=this.file(id,suffix);await this.capacity(target,bytes,value.projectId);
   const temporary=path.join(this.directory,'.pending-'+randomUUID());let handle;
   try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(text);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,target);if(process.platform!=='win32'){const directory=await fs.open(this.directory,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}}
   finally{await handle?.close();await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  });this.capacityFlight=operation;return operation;
 }
 validateFrozen(value){
  if(!validId(value?.id)||typeof value.projectId!=='string'||!value.projectId||!Array.isArray(value.tiles)||!value.tiles.length||value.tiles.length>32)throw Error('冻结捕获记录无效');
  let pixels=0;
  for(const tile of value.tiles){
   if(!dimensions(tile.width,tile.height)||!Array.isArray(tile.layers)||!tile.layers.length||tile.layers.length>128)throw Error('冻结窗口记录无效');pixels+=tile.width*tile.height;
   for(const layer of tile.layers){
    const b=layer.bounds;if(!b||!['x','y','width','height'].every(k=>Number.isFinite(b[k]))||b.width<=0||b.height<=0||typeof layer.dataUrl!=='string'||layer.dataUrl.length>FROZEN_LIMIT||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(layer.dataUrl))throw Error('冻结图层无效');
    const header=Buffer.from(layer.dataUrl.slice(22,66),'base64');
    if(header.length<24||header.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||!dimensions(header.readUInt32BE(16),header.readUInt32BE(20)))throw Error('冻结图层 PNG 尺寸无效');
   }
  }
  if(pixels>CAPTURE_PIXELS)throw Error('冻结捕获超过像素预算');
  if(value.width!=null&&!dimensions(value.width,value.height))throw Error('冻结画布尺寸无效');
 }
 async frozen(id,projectId){const record=await this.read(id,'',FROZEN_LIMIT);this.validateFrozen(record);if(record.id!==id||record.projectId!==projectId)throw Error('捕获不属于当前项目');return record;}
 saveFrozen(record){const snapshot=structuredClone(record);this.validateFrozen(snapshot);return this.serial(snapshot.id,async()=>{
  const previous=await this.read(snapshot.id,'',FROZEN_LIMIT,true);
  if(previous){if(JSON.stringify(previous)!==JSON.stringify(snapshot))throw Error('冻结捕获不可替换');return previous;}
  await this.write(snapshot.id,'',snapshot,FROZEN_LIMIT);return snapshot;
 });}
 saveDrawing(id,projectId,value){const snapshot=structuredClone(value);if(snapshot.drawing)snapshot.drawing=validateDrawing(snapshot.drawing);return this.serial(id,async()=>{await this.frozen(id,projectId);await this.write(id,'.drawing',{...snapshot,id,projectId},DRAFT_LIMIT);return {saved:true};});}
 saveResult(id,projectId,value){const snapshot=structuredClone(value);return this.serial(id,async()=>{
  await this.frozen(id,projectId);
  if(!['local','pending-delivery','delivered'].includes(snapshot.state)||!snapshot.attachment||snapshot.attachment.mime!=='image/png'||snapshot.attachment.source!=='drawing'||!/^[a-f0-9]{64}$/.test(snapshot.attachment.digest)||!Number.isSafeInteger(snapshot.attachment.size)||snapshot.attachment.size<1||snapshot.attachment.size>8*1024*1024)throw Error('捕获结果无效');
  const previous=await this.read(id,'.result',RESULT_LIMIT,true);
  if(previous&&(previous.attachment.digest!==snapshot.attachment.digest||previous.state==='delivered'&&snapshot.state!=='delivered'))throw Error('已保存结果不可替换或退回');
  if(snapshot.drawing)snapshot.drawing=validateDrawing(snapshot.drawing);
  await this.write(id,'.result',{...snapshot,id,projectId},RESULT_LIMIT);return {saved:true};
 });}
 load(id,projectId){return this.serial(id,async()=>{const record=await this.frozen(id,projectId),drawingDraft=await this.read(id,'.drawing',DRAFT_LIMIT,true),result=await this.read(id,'.result',RESULT_LIMIT,true);for(const part of [drawingDraft,result])if(part&&(part.id&&part.id!==id||part.projectId&&part.projectId!==projectId))throw Error('捕获恢复身份不符');return {...record,drawingDraft,result};});}
 discard(id,projectId){return this.serial(id,async()=>{
  await this.frozen(id,projectId);
  const operation=this.capacityFlight.catch(()=>{}).then(async()=>{
   // Any published result may be referenced by a note, draft or message. Even
   // unreadable result files are retained rather than guessed safe to delete.
   try{await fs.lstat(this.file(id,'.result'));throw Error('已有保存结果的捕获不能丢弃；引用材料已保留');}
   catch(error){if(error.code!=='ENOENT')throw error;}
   await fs.unlink(this.file(id,'.drawing')).catch(error=>{if(error.code!=='ENOENT')throw error;});
   await fs.unlink(this.file(id));
   if(process.platform!=='win32'){const directory=await fs.open(this.directory,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}
   return {discarded:true,id,projectId};
  });this.capacityFlight=operation;return operation;
 });}
 async listRecoverable(projectId){
  if(typeof projectId!=='string'||!projectId)throw Error('项目身份无效');await this.ensure();const records=[];
  for(const entry of await fs.readdir(this.directory,{withFileTypes:true})){
   if(!entry.isFile()||!entry.name.endsWith('.json')||entry.name.startsWith('.')||/\.(drawing|result)\.json$/.test(entry.name))continue;
   const id=entry.name.slice(0,-5);if(!validId(id))continue;
   let belongs=false;
   try{const record=await this.read(id,'',FROZEN_LIMIT);if(record.projectId!==projectId)continue;belongs=true;const loaded=await this.load(id,projectId);if(loaded.result?.state==='delivered')continue;records.push({id,projectId,createdAt:loaded.createdAt,state:loaded.result?.state|| (loaded.drawingDraft?'drawing':'frozen'),width:loaded.width,height:loaded.height});}
   catch(error){if(belongs)records.push({id,projectId,state:'unreadable',error:String(error.message).slice(0,160)});}
  }
  return records.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
 }
}
