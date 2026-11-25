import {platformPersistence} from '../platform/shared/persistence.mjs';
// File effects for the shared project Git initialization state machine.
// Default selection retains the qualified platform capability gates.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {runGit} from '../agents/managed/git-runtime.mjs';
import {requireCapability} from '../platform/platform-capabilities.mjs';
const fail = (code, message) => Object.assign(new Error(message), { code });
const sameIdentity = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
async function exists(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const unchangedFile = (a,b) => a.isFile() && b.isFile() && sameIdentity(a,b) && a.size===b.size && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs;
// Lock pathnames can be reused as soon as publication succeeds. Cleanup owns
// only the entity opened with wx, never a subsequent occupant of that name.
async function ownsLock(file, identity) {
  const stat = await exists(file);
  return Boolean(identity && stat?.isFile() && !stat.isSymbolicLink() && sameIdentity(stat, identity));
}
async function removeOwnedLock(file, identity) {
  if (await ownsLock(file, identity)) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function captureFile(full,git,root,env) {
  const before=await fs.lstat(full);
  if(!before.isFile()||before.isSymbolicLink())throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while capturing baseline');
  let handle;
  try { handle=await fs.open(full,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)); }
  catch(error){if(['ELOOP','ENOENT'].includes(error.code))throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while capturing baseline');throw error;}
  try {
    const opened=await handle.stat(),pathStat=await fs.lstat(full);
    if(!unchangedFile(before,opened)||!unchangedFile(opened,pathStat)||pathStat.isSymbolicLink()||await fs.realpath(full)!==full)throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while capturing baseline');
    // Read only the already verified descriptor, never ask Git to reopen a
    // mutable pathname. Fixed-size chunks bound memory independently of size.
    async function* chunks(){let position=0;while(position<opened.size){const buffer=Buffer.allocUnsafe(Math.min(64*1024,opened.size-position));const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while capturing baseline');position+=bytesRead;yield buffer.subarray(0,bytesRead);}}
    const oid=(await runGit(root,[...git,'hash-object','--no-filters','-w','--stdin'],{env,encoding:'utf8',input:Readable.from(chunks())})).trim();
    const after=await handle.stat(),finalPath=await fs.lstat(full);
    if(!unchangedFile(opened,after)||!unchangedFile(after,finalPath)||finalPath.isSymbolicLink())throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while capturing baseline');
    return {oid,mode:process.platform!=='win32'&&(opened.mode&0o111)?'100755':'100644'};
  }finally{await handle.close();}
}

async function ensureIgnore(file, rule, effective, verifyRoot) {
  if (await effective()) return { path: file, rule, changed: false };
  const lock = file + '.lock';
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('PROJECT_GIT_IGNORE_BUSY', 'Git ignore file is being edited; retry explicitly'); throw error; }
  let lockIdentity, published = false;
  try {
    lockIdentity = await handle.stat();
    const stat = await exists(file);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw fail('PROJECT_GIT_IGNORE_CONFLICT', 'Git ignore file is not a regular file');
    const original = stat ? await fs.readFile(file) : Buffer.alloc(0);
    if (await effective()) return { path: file, rule, changed: false };
    const newline = original.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
    const separator = original.length && original[original.length - 1] !== 10 ? newline : '';
    await handle.writeFile(Buffer.concat([original, Buffer.from(separator + rule + newline)]));
    if (stat) await handle.chmod(stat.mode & 0o777);
    await platformPersistence.syncFileHandle(handle);
    await verifyRoot();
    const now = await exists(file);
    if (Boolean(stat) !== Boolean(now) || (stat && (!sameIdentity(stat, now) || !original.equals(await fs.readFile(file))))) throw fail('PROJECT_GIT_IGNORE_CONFLICT', 'Git ignore file changed concurrently');
    // Standard Git lockfile publication: cooperative writers serialize on .lock;
    // non-cooperative writers are detected by the byte/identity comparison.
    if (!await ownsLock(lock, lockIdentity)) throw fail('PROJECT_GIT_IGNORE_CONFLICT', 'Git ignore lock ownership changed');
    await fs.rename(lock, file);
    published = true;
    return { path: file, rule, changed: true };
  } finally {
    try { if (!published) await removeOwnedLock(lock, lockIdentity); }
    finally { await handle.close(); }
  }
}

export function createProjectGitIO(){return Object.freeze({
 requireSupported(){requireCapability('safe-file-io');requireCapability('durable-persistence');},
 exists,captureFile,ensureIgnore,
 async directoryIdentity(directory){const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==directory)throw fail('PROJECT_IDENTITY_CONFLICT','Project directory identity changed');return {dev:String(stat.dev),ino:String(stat.ino)};},
 canonicalDirectory:directory=>fs.realpath(directory),
 listDirectory:directory=>fs.readdir(directory,{withFileTypes:true}),
 readText:file=>fs.readFile(file,'utf8'),
 createScratch:()=>fs.mkdtemp(path.join(os.tmpdir(),'nozeli-project-git-')),
 removeScratch:scratch=>fs.rm(scratch,{recursive:true,force:true}),
 async allocateRepository(ownGit,marker,operationId){await fs.mkdir(ownGit);await fs.writeFile(marker,operationId,{flag:'wx'});const handle=await fs.open(marker,'r');try{await platformPersistence.syncFileHandle(handle);}finally{await handle.close();}},
 async publishInitialIndex(ownGit,baselineIndex,verifyRoot){
        const indexLock = path.join(ownGit, 'index.lock');
        const lockHandle = await fs.open(indexLock, 'wx', 0o600);
        let lockIdentity, published = false;
        try {
          lockIdentity = await lockHandle.stat();
          await lockHandle.writeFile(await fs.readFile(baselineIndex));
          await lockHandle.sync();
          await verifyRoot();
          if (!await ownsLock(indexLock, lockIdentity)) throw fail('PROJECT_GIT_INDEX_CONFLICT', 'Index lock ownership changed');
          if (!await exists(path.join(ownGit, 'index'))) {
            await fs.rename(indexLock, path.join(ownGit, 'index'));
            published = true;
          }
        } finally {
          try { if (!published) await removeOwnedLock(indexLock, lockIdentity); }
          finally { await lockHandle.close(); }
        }

 },
});}
