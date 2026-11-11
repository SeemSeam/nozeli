import path from 'node:path';
import {WorkspaceCaptureStore} from './workspace-capture-store.mjs';
import {createHash} from 'node:crypto';
import {validateDrawing} from '../domain/region-drawing.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const fail = message => {throw Object.assign(new Error(message), {code: 'INVALID_ATTACHMENT'});};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validateDrawingPng(bytes, mime = 'image/png') {
 if (mime !== 'image/png' || bytes.length < 33 || bytes.length > MAX_BYTES || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('涂鸦材料不是有效的有界 PNG。');
 const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
 if (!width || !height || width > 20000 || height > 20000 || width * height > 40_000_000) fail('涂鸦 PNG 超过像素上限。');
}

function drawingFocus(record) {
 const value=record.result?.drawing??record.drawingDraft?.drawing;
 if(!value)return null;
 const drawing=validateDrawing(value),{width,height,strokes}=drawing;
 if(width!==record.width||height!==record.height)fail('冻结笔迹与原图尺寸不一致，未发送。');
 let left=width,top=height,right=0,bottom=0;
 for(const stroke of strokes){
  const radius=stroke.width*Math.min(width,height)/2;
  for(const [x,y] of stroke.points){left=Math.min(left,x*width-radius);right=Math.max(right,x*width+radius);top=Math.min(top,y*height-radius);bottom=Math.max(bottom,y*height+radius);}
 }
 const x=Math.max(0,Math.floor(left)),y=Math.max(0,Math.floor(top));
 const pixelBounds=strokes.length?{x,y,width:Math.min(width,Math.ceil(right))-x,height:Math.min(height,Math.ceil(bottom))-y}:null;
 const sourceRegions=pixelBounds?(record.result?.sources||[]).flatMap(source=>{
  const r=source.outputRegion;if(!r)return [];
  const left=Math.max(x,r.x),top=Math.max(y,r.y),right=Math.min(x+pixelBounds.width,r.x+r.width),bottom=Math.min(y+pixelBounds.height,r.y+r.height);
  return right>left&&bottom>top?[{sourceId:source.sourceId,relPath:source.relPath??null,locationStatus:'viewport-only',pixelBounds:{x:left,y:top,width:right-left,height:bottom-top},selection:null}]:[];
 }):[];
 return {sourceId:'drawing:'+record.id,kind:'drawing-focus',locationStatus:'image-relative',summary:'带笔迹的冻结PNG原图；像素坐标基于原图左上角，模型端等比缩放时归一化坐标保持不变；不是文件页码或精确选区。',image:{width,height},drawing:{strokeCount:strokes.length,colors:[...new Set(strokes.map(stroke=>stroke.color))],coordinateSpace:'image-pixels',origin:'top-left',pixelBounds,normalizedBounds:pixelBounds?{x:x/width,y:y/height,width:pixelBounds.width/width,height:pixelBounds.height/height}:null},sourceRegions};
}

/** Pending selections belong to local instance recovery; sent bytes and provenance belong to the project. */
export class ProjectAttachments {
 constructor(storage) {this.storage = storage;}
 async instance(projectId) {
  if (typeof projectId !== 'string' || !projectId) fail('附件缺少项目身份。');
  return this.storage.requireRegistered(projectId);
 }
 async attach(input) {
  const instance = await this.instance(input?.projectId);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 255 || /[/\\\x00-\x1f]/.test(name)) fail('附件文件名无效。');
  const mime = typeof input.mime === 'string' && input.mime.length <= 100 ? input.mime : 'application/octet-stream';
  const source = ['local-select', 'paste', 'drop', 'drawing'].includes(input.source) ? input.source : 'local-select';
  if (typeof input.bytes !== 'string' || input.bytes.length > Math.ceil(MAX_BYTES / 3) * 4) fail('附件内容无效或超过大小上限。');
  const bytes = Buffer.from(input.bytes, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES || typeof input.size === 'number' && input.size !== bytes.length) fail('附件大小无效。');
  if (source === 'drawing') validateDrawingPng(bytes, mime);
  const object = await this.storage.putRecoveryObject(input.projectId, bytes);
  const ref = {projectId: input.projectId, instanceId: instance.instanceId, storage: 'recovery', digest: object.digest, name, mime, size: object.byteLength, source};
  const key = 'attachment:' + object.digest + ':' + source, previous = await this.storage.getRecovery(input.projectId, key);
  if (!previous) await this.storage.putRecovery(input.projectId, key, {...ref, createdAt: new Date().toISOString()});
  return {...ref, duplicate: !!previous};
 }
 async entry(ref) {
  if (!validDigest(ref?.digest) || !['recovery', 'project'].includes(ref.storage)) fail('附件引用无效。');
  const instance = await this.instance(ref.projectId);
  if (ref.storage === 'recovery' && ref.instanceId !== instance.instanceId) fail('附件不属于当前项目实例。');
  const entry = ref.storage === 'recovery' ? await this.storage.getRecovery(ref.projectId, 'attachment:' + ref.digest + ':' + ref.source) : await this.storage.getProject(ref.projectId, 'material_attachments', ref.digest + ':' + ref.source);
  if (!entry || entry.digest !== ref.digest || entry.projectId !== ref.projectId || ref.mime && ref.mime !== entry.mime) fail('附件未登记到当前项目。');
  return entry;
 }
 async readBytes(ref) {
  const entry = await this.entry(ref);
  const bytes = ref.storage === 'recovery' ? await this.storage.readRecoveryObject(ref.projectId, ref.digest) : await this.storage.readObject(ref.projectId, ref.digest);
  if (bytes.length !== entry.size || bytes.length > MAX_BYTES || digest(bytes) !== ref.digest) fail('附件材料损坏。');
  if (entry.source === 'drawing') validateDrawingPng(bytes, entry.mime);
  return bytes;
 }
 async read(ref) {
  const entry = await this.entry(ref), bytes = await this.readBytes(ref);
  return {...entry, storage: ref.storage, bytes: bytes.toString('base64')};
 }
 async promote(projectId, ref, {sources = []} = {}) {
  if (projectId !== ref?.projectId) fail('附件不能跨项目发送。');
  const entry = await this.entry(ref), bytes = await this.readBytes(ref);
  const object = await this.storage.putObject(projectId, bytes);
  if (object.digest !== ref.digest || object.byteLength !== bytes.length) fail('项目附件摘要不一致。');
  const manifest = {schema: 1, projectId, attachment: {digest: object.digest, byteLength: object.byteLength, name: entry.name, mime: entry.mime, source: entry.source}, sources: structuredClone(sources)};
  const sourceManifest = await this.storage.putObject(projectId, Buffer.from(JSON.stringify(manifest)));
  const promoted = {projectId, storage: 'project', digest: object.digest, name: entry.name, mime: entry.mime, size: object.byteLength, source: entry.source, sourceManifest};
  if (!await this.storage.getProject(projectId, 'material_attachments', object.digest + ':' + entry.source)) await this.storage.putProject(projectId, 'material_attachments', object.digest + ':' + entry.source, promoted);
  return promoted;
 }
 async drawingSources(projectId, ref) {
  if (ref?.projectId !== projectId) fail('涂鸦来源不属于当前项目。');
  const entry = await this.entry(ref);
  if (entry.source !== 'drawing' || entry.mime !== 'image/png') fail('不是已登记的涂鸦材料。');
  if (ref.storage === 'project') {
   const manifest = ref.sourceManifest || entry.sourceManifest;
   if (!manifest || !validDigest(manifest.digest)) fail('涂鸦来源清单缺失。');
   const bytes = await this.storage.readObject(projectId, manifest.digest);
   if (digest(bytes) !== manifest.digest || bytes.length !== manifest.byteLength) fail('涂鸦来源清单损坏。');
   const record = JSON.parse(bytes.toString('utf8'));
   const binding = await this.instance(projectId), lineage = Array.isArray(binding.lineage) ? binding.lineage : [binding.lineage];
   if (record.projectId !== projectId && !lineage.includes(record.projectId) || record.attachment?.digest !== ref.digest) fail('涂鸦来源清单身份不符。');
   return structuredClone(record.sources);
  }
  const store = new WorkspaceCaptureStore({directory: path.join(await this.storage.recoveryDirectory(projectId), 'drawing-captures')});
  const record = await store.load(ref.deliveryId, projectId);
  if (record.result?.attachment?.digest !== ref.digest) fail('涂鸦图片与冻结捕获记录不符。');
  const sources=structuredClone(record.result.sources||[]),focus=drawingFocus(record);
  if(focus)sources.push(focus);
  return sources;
 }
}
