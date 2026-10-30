import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export class MaterialError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'MaterialError'; this.code = code; }
}
export const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code,message) => new MaterialError(code,message);
// Application-owned publication links may change ctime without changing bytes.
const identity = stat => [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.mode,stat.uid,stat.gid].join(':');

/** Application-owned immutable CAS; publication never replaces an existing digest. */
export class MaterialStore {
  constructor(directory, { maxBytes = 32 * 1024 * 1024, createDirectory = true } = {}) {
    if(typeof directory !== 'string'||!path.isAbsolute(directory))throw fail('INVALID_DIRECTORY','Material directory must be absolute.');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw fail('INVALID_LIMIT','Invalid material byte limit.');
    Object.assign(this,{directory:path.resolve(directory),maxBytes,createDirectory});
  }
  location(digest) {
    if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw fail('INVALID_DIGEST','Expected a SHA-256 content identifier.');
    return path.join(this.directory,digest);
  }
  async ensureDirectory() {
    if(this.createDirectory)await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    const stat=await fs.lstat(this.directory);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('INVALID_DIRECTORY','Material directory is not a regular directory.');
  }
  async withObject(digest,fn,{maxBytes=Infinity}={}) {
    const file=this.location(digest);let handle;
    try {
      const directory=await fs.lstat(this.directory);
      if(!directory.isDirectory()||directory.isSymbolicLink())throw fail('INVALID_DIRECTORY','Material directory is not a regular directory.');
      const entry=await fs.lstat(file);
      if(!entry.isFile()||entry.isSymbolicLink())throw fail('INVALID_MATERIAL','Material is not a regular file.');
      handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      const stat=await handle.stat();
      if(!stat.isFile()||identity(entry)!==identity(stat))throw fail('MATERIAL_CORRUPT','Material identity changed.');
      if(stat.size>maxBytes)throw fail('MATERIAL_TOO_LARGE','Stored material exceeds the reader byte limit.');
      const stream=()=>handle.createReadStream({start:0,autoClose:false});
      const hash=createHash('sha256');for await(const chunk of stream())hash.update(chunk);
      if(hash.digest('hex')!==digest)throw fail('MATERIAL_CORRUPT','Material content does not match its identifier.');
      const result=await fn({handle,stat,stream});
      if(identity(await handle.stat())!==identity(stat)||identity(await fs.lstat(file))!==identity(stat))throw fail('MATERIAL_CORRUPT','Material identity changed.');
      // A winning publisher may unlink its pending hardlink during this read.
      // Rehash ctime-only transitions rather than rejecting legitimate readers.
      if((await handle.stat()).ctimeMs!==stat.ctimeMs){
        const hash=createHash('sha256');for await(const chunk of stream())hash.update(chunk);
        if(hash.digest('hex')!==digest||identity(await handle.stat())!==identity(stat)||identity(await fs.lstat(file))!==identity(stat))throw fail('MATERIAL_CORRUPT','Material content changed.');
      }
      return result;
    } catch(error) {
      if(error.code==='ENOENT')throw new MaterialError('MATERIAL_MISSING','The referenced material is unavailable.',{cause:error});
      throw error;
    } finally {await handle?.close();}
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
    const temporary=path.join(this.directory,'.pending-'+randomUUID());let handle;
    try {
      handle=await fs.open(temporary,'wx',0o600);const hash=createHash('sha256');let byteLength=0;
      for await(const value of input){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);hash.update(chunk);byteLength+=chunk.length;if(!Number.isSafeInteger(byteLength))throw fail('MATERIAL_TOO_LARGE','Material size is not representable.');await handle.writeFile(chunk);}
      const digest=hash.digest('hex');if(expected!==undefined&&digest!==expected)throw fail('MATERIAL_CORRUPT','Imported material digest mismatch.');
      await handle.sync();await handle.close();handle=null;
      try{await fs.link(temporary,this.location(digest));}catch(error){if(error.code!=='EEXIST')throw error;}
      await this.verify(digest);
      if(process.platform!=='win32'){const directory=await fs.open(this.directory,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}
      return {digest,byteLength};
    } finally {await handle?.close();await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
}
