import { createHash } from 'node:crypto';
import path from 'node:path';
import {createMaterialStoreIO} from './material-store-io.mjs';

export class MaterialError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'MaterialError'; this.code = code; }
}
export const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code,message) => new MaterialError(code,message);

/** Application-owned immutable CAS; publication never replaces an existing digest. */
export class MaterialStore {
  constructor(directory, { maxBytes = 32 * 1024 * 1024, createDirectory = true, experimentalWindowsRoot } = {}) {
    if(typeof directory !== 'string'||!path.isAbsolute(directory))throw fail('INVALID_DIRECTORY','Material directory must be absolute.');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw fail('INVALID_LIMIT','Invalid material byte limit.');
    Object.assign(this,{directory:path.resolve(directory),maxBytes,createDirectory});
    this.io=createMaterialStoreIO(this.directory,{createDirectory,experimentalWindowsRoot,fail});
    if(this.io.qualification)this.qualification=this.io.qualification;
  }
  location(digest) {
    if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw fail('INVALID_DIGEST','Expected a SHA-256 content identifier.');
    return path.join(this.directory,digest);
  }
  async ensureDirectory() {
    return this.io.ensureDirectory();
  }
  async withObject(digest,fn,{maxBytes=Infinity}={}) {
    this.location(digest);let reader;
    try {
      reader=await this.io.openObject(digest);const {handle,stat,stream}=reader;
      if(stat.size>maxBytes)throw fail('MATERIAL_TOO_LARGE','Stored material exceeds the reader byte limit.');
      const hash=createHash('sha256');for await(const chunk of stream())hash.update(chunk);
      if(hash.digest('hex')!==digest)throw fail('MATERIAL_CORRUPT','Material content does not match its identifier.');
      const result=await fn({handle,stat,stream});
      // A winning publisher may unlink its pending hardlink during this read.
      // Rehash ctime-only transitions rather than rejecting legitimate readers.
      if(await reader.verify()){
        const hash=createHash('sha256');for await(const chunk of stream())hash.update(chunk);
        if(hash.digest('hex')!==digest)throw fail('MATERIAL_CORRUPT','Material content changed.');
        await reader.verify();
      }
      return result;
    } catch(error) {
      if(error.code==='ENOENT')throw new MaterialError('MATERIAL_MISSING','The referenced material is unavailable.',{cause:error});
      throw error;
    } finally {await reader?.close();}
  }
  async verify(digest) {return this.withObject(digest,({stat})=>({digest,byteLength:stat.size}));}
  async get(digest,{maxBytes=this.maxBytes}={}) {
    return this.withObject(digest,async({handle,stat})=>{
      if(stat.size>maxBytes)throw fail('MATERIAL_TOO_LARGE','Stored material exceeds the reader byte limit.');
      const bytes=Buffer.alloc(stat.size);let offset=0;
      while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw fail('MATERIAL_CORRUPT','Material truncated.');offset+=bytesRead;}
      if(digestBytes(bytes)!==digest)throw fail('MATERIAL_CORRUPT','Material content does not match its identifier.');
      return bytes;
    },{maxBytes});
  }
  async put(input) {
    if(!(input instanceof Uint8Array))throw fail('INVALID_BYTES','Material input must be bytes.');
    if(input.byteLength>this.maxBytes)throw fail('MATERIAL_TOO_LARGE','Material exceeds the byte limit.');
    const bytes=Buffer.from(input);
    return this.putStream([bytes],{digest:digestBytes(bytes)});
  }
  async putStream(input,{digest:expected}={}) {
    if(expected!==undefined)this.location(expected);
    await this.ensureDirectory();
    let stage,published=false,primaryError,digest=null,byteLength=0;
    const publication=()=>({directory:this.directory,digest,byteLength,published:published||primaryError?.committed===true,...(stage?.facts?{stage:stage.facts}:{})});
    try {
      stage=await this.io.createStage();const hash=createHash('sha256');
      for await(const value of input){const chunk=Buffer.from(value);hash.update(chunk);byteLength+=chunk.length;if(!Number.isSafeInteger(byteLength))throw fail('MATERIAL_TOO_LARGE','Material size is not representable.');await stage.write(chunk);}
      digest=hash.digest('hex');if(expected!==undefined&&digest!==expected)throw fail('MATERIAL_CORRUPT','Imported material digest mismatch.');
      await stage.sync();published=await stage.publish(digest);await stage.releaseFile();
      await this.verify(digest);
      await stage.syncDirectory();
      return {digest,byteLength};
    } catch(cause) {
      const error=cause instanceof Error?cause:new MaterialError('MATERIAL_WRITE_FAILED','Material publication failed.',{cause});
      primaryError=error;if(published||error.committed){error.committed=true;error.durability='uncertain';}error.materialPublication=publication();throw error;
    } finally {
      try{await stage?.close();}catch(error){if(primaryError)primaryError.cleanupErrors=[...(primaryError.cleanupErrors??[]),error];else{if(published){error.committed=true;error.durability='uncertain';}error.materialPublication=publication();throw error;}}
    }
  }
}
