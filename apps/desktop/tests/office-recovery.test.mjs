import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {encodeRecoveryBytes,decodeRecoveryBytes} from '../src/domain/office-recovery.mjs';
import {normalizeOfficeRecovery,validateSheetSnapshot} from '../src/main/office-recovery.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';
const original=Array.from(await fs.readFile(new URL('./fixtures/office/中文 表格.xlsx',import.meta.url)));
const snapshot=(overrides={})=>new TextEncoder().encode(JSON.stringify({schema:'nozeli-sheet-recovery-v1',sheets:[{name:'表格',celldata:[{r:1,c:0,v:{v:'甲',bl:1}}]}],original,...overrides}));
test('unsupported spreadsheet formatting is retained exactly with the original usable XLSX',async()=>{
 const bytes=snapshot(),candidate={sheetSnapshot:encodeRecoveryBytes(bytes)};
 assert.deepEqual(await normalizeOfficeRecovery('sheet',candidate),candidate);
 assert.deepEqual(decodeRecoveryBytes(candidate.sheetSnapshot),bytes);
 await validateSheetSnapshot(bytes);
});
test('sheet snapshots reject invalid schema, model and byte values',async()=>{
 for(const value of [{schema:'other'},{sheets:[]},{sheets:[null]},{original:[-1]},{original:[256]},{original:[1.5]}])await assert.rejects(validateSheetSnapshot(snapshot(value)));
});
test('sheet snapshots reject corrupt original packages and noncanonical encoded lengths',async()=>{
 await assert.rejects(validateSheetSnapshot(snapshot({original:[80,75,3,4]})));
 const encoded=encodeRecoveryBytes(snapshot());encoded.byteLength++;
 await assert.rejects(normalizeOfficeRecovery('sheet',{sheetSnapshot:encoded}));
});
test('ordinary XLSX recovery stays a usable document and other Office kinds reject sheet snapshot payloads',async()=>{
 const candidate={bytes:encodeRecoveryBytes(Uint8Array.from(original))};assert.deepEqual(await normalizeOfficeRecovery('sheet',candidate),candidate);
 for(const kind of ['word','ppt'])await assert.rejects(normalizeOfficeRecovery(kind,{sheetSnapshot:encodeRecoveryBytes(snapshot())}));
});
test('host retention never marks a complete spreadsheet snapshot as a clean source baseline',async()=>{
 const values=new Map(),storage={getRecovery:async(id,key)=>values.get(key),putRecovery:async(id,key,value)=>values.set(key,value)};
 const native=new WorkspaceNative({host:{storage,requireRegisteredProject:async()=>({})}});
 const record={projectId:'p',viewId:'sheet',role:'surface',kind:'document',relPath:'sheet.xlsx',generation:1,recoveryOwner:'owner',documentSource:{type:'project'}};
 const candidate={sheetSnapshot:encodeRecoveryBytes(snapshot())};
 await native.saveRecovery(record,{projectId:'p',viewId:'sheet',relPath:'sheet.xlsx',kind:'sheet',generation:1,baseDigest:'a'.repeat(64),sourceDigest:'a'.repeat(64),candidate,documentStatus:{dirty:false,composing:false,conflict:false,missing:false,readOnly:false}});
 assert.deepEqual(values.get('workspace:sheet').candidate,candidate);
 assert.equal(values.get('workspace:sheet').cleanOfficeBaseline,undefined);
});
// The synthetic minimal PPTX fixture is used read-only; it stays byte-identical.
const pptx=await fs.readFile(new URL('./fixtures/ppt/compatibility.pptx',import.meta.url));
const pptOriginal=Uint8Array.from(pptx),pptSourceDigest=createHash('sha256').update(pptx).digest('hex');
const cleanStatus={dirty:false,composing:false,conflict:false,missing:false,readOnly:false};
const pptSurface=()=>({projectId:'p',viewId:'ppt',role:'surface',kind:'document',relPath:'deck.pptx',generation:1,recoveryOwner:'owner',documentSource:{type:'project'}});
const fakeStorage=()=>{const values=new Map();return {values,storage:{getRecovery:async(id,key)=>values.get(key),putRecovery:async(id,key,value)=>values.set(key,value)}};};
test('a PPT whose initial import failed retains its unmodified original bytes without any editing model',async()=>{
 const candidate={bytes:encodeRecoveryBytes(pptOriginal),sourceRead:true};
 const retained=await normalizeOfficeRecovery('ppt',candidate);
 assert.deepEqual(retained,{bytes:candidate.bytes,sourceRead:true});
 assert.deepEqual(decodeRecoveryBytes(retained.bytes),pptOriginal);
});
test('failed-initial-import close/switch retention is admitted with the exact original bytes and a clean baseline',async()=>{
 const {values,storage}=fakeStorage();
 const native=new WorkspaceNative({host:{storage,requireRegisteredProject:async()=>({})}});
 const bytes=encodeRecoveryBytes(pptOriginal);
 await native.saveRecovery(pptSurface(),{projectId:'p',viewId:'ppt',relPath:'deck.pptx',kind:'ppt',generation:1,baseDigest:pptSourceDigest,sourceDigest:pptSourceDigest,candidate:{bytes,sourceRead:true},documentStatus:{...cleanStatus}});
 const stored=values.get('workspace:ppt');
 assert.deepEqual(stored.candidate,{bytes,sourceRead:true});
 assert.deepEqual(decodeRecoveryBytes(stored.candidate.bytes),pptOriginal);
 assert.deepEqual(stored.cleanOfficeBaseline,{schemaVersion:1,sourceDigest:pptSourceDigest});
});
test('a genuinely dirty PPT without an editing model is refused, never replaced by its original bytes',async()=>{
 const bytes=encodeRecoveryBytes(pptOriginal);
 await assert.rejects(normalizeOfficeRecovery('ppt',{bytes}),{code:'INVALID_OFFICE_RECOVERY'});
 await assert.rejects(normalizeOfficeRecovery('ppt',{bytes,sourceRead:true,model:{slides:[{id:'slide',elements:[]}]}}));
 const {values,storage}=fakeStorage();
 const native=new WorkspaceNative({host:{storage,requireRegisteredProject:async()=>({})}});
 await assert.rejects(native.saveRecovery(pptSurface(),{projectId:'p',viewId:'ppt',relPath:'deck.pptx',kind:'ppt',generation:1,baseDigest:pptSourceDigest,sourceDigest:pptSourceDigest,candidate:{bytes,sourceRead:true},documentStatus:{...cleanStatus,dirty:true}}),{code:'PPT_EDIT_UNPROVEN'});
 assert.equal(values.size,0);
});
test('valid PPT editing proof still requires and keeps both the usable package and the live model',async()=>{
 const bytes=encodeRecoveryBytes(pptOriginal);
 const model={slides:[{id:'slide-A',elements:[{id:'text-A',type:'text',content:'<p>PPT_EDIT_PROOF_中文</p>'}]}]};
 assert.deepEqual(await normalizeOfficeRecovery('ppt',{bytes,model}),{bytes,model});
 await assert.rejects(normalizeOfficeRecovery('ppt',{bytes,model:{slides:[]}}),{code:'INVALID_OFFICE_RECOVERY'});
});
