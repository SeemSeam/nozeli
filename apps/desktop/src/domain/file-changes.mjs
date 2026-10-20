import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileTags } from './file-tags.mjs';
import { anchorText, textChangeSet } from './tag-anchors.mjs';
import { changeRecord, mapAttribution, publicChanges, externalActor } from './document-changes.mjs';
import { textDigest } from './document-versions.mjs';

const MAX_LEDGER = 32 * 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const digest = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export class ChangeFileError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const corrupt = () => { throw new ChangeFileError('CHANGE_HISTORY_CORRUPT', '修改记录损坏，原记录已保留；未覆盖文档。'); };
export class FileChanges {
  constructor(root) { this.root = root; this.directory = path.join(root, '.nozeli', 'changes'); this.keys = new FileTags(root); }
  location(rel) { return path.join(this.directory, this.keys.key(rel) + '.json'); }
  async directories(create = false) {
    for (const dir of [path.join(this.root, '.nozeli'), this.directory]) {
      if (create) await fs.mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(dir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) return false;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ChangeFileError('SYMLINK', '修改记录目录不可为链接。');
    }
    return true;
  }
  async read(rel) {
    const file = this.location(rel);
    if (!await this.directories()) return null;
    const linkStat=await fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!linkStat)return null;
    if(!linkStat.isFile()||linkStat.isSymbolicLink()||linkStat.size>MAX_LEDGER)corrupt();
    let handle;
    try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if (error.code === 'ENOENT') return null; if (error.code === 'ELOOP') corrupt(); throw error; }
    let raw;
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_LEDGER) corrupt(); raw = await handle.readFile('utf8'); }
    finally { await handle.close(); }
    let value; try { value = JSON.parse(raw); } catch { corrupt(); }
    if (value?.format !== 'nozeli.file-changes' || value.schemaVersion !== 1) throw new ChangeFileError('SCHEMA_UNSUPPORTED', '修改记录版本未知，未覆盖。');
    this.validate(value, rel);
    return value;
  }
  validate(value, rel) {
    if (value.relPath !== rel || !uuid(value.docId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !digest(value.digest) || typeof value.text !== 'string' || value.text !== anchorText(value.text) || !Array.isArray(value.events) || !Array.isArray(value.spans) || !Array.isArray(value.points) || !Array.isArray(value.attempts)) corrupt();
    if (value.textDigest != null && (!digest(value.textDigest) || value.textDigest !== textDigest(value.text))) corrupt();
    if (value.textSpace != null && !['utf16-lf-text','docx-main-text'].includes(value.textSpace)) corrupt();
    if(value.operationReceipts!=null){
      if(!Array.isArray(value.operationReceipts))corrupt();
      const operations=new Set();
      for(const receipt of value.operationReceipts){
        if(!receipt||receipt.unchanged!==true||typeof receipt.operationId!=='string'||!/^[a-f0-9]{64}$/.test(receipt.operationId)||operations.has(receipt.operationId)||typeof receipt.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(receipt.fingerprint)||!Number.isSafeInteger(receipt.revision)||receipt.revision<0||receipt.revision>value.revision||typeof receipt.afterDigest!=='string'||!digest(receipt.afterDigest)||typeof receipt.actor?.id!=='string'||!['user','agent1','agent2','external'].includes(receipt.actor.kind))corrupt();
        operations.add(receipt.operationId);
      }
    }
    const ids = new Set();
    for (const event of value.events) {
      if (!uuid(event.id) || ids.has(event.id) || !Number.isSafeInteger(event.revision) || event.revision < 1 || event.revision > value.revision || typeof event.actor?.id !== 'string' || !['user','agent1','agent2','external'].includes(event.actor.kind) || typeof event.actor.name !== 'string' || typeof event.actor.mark !== 'string' || !Number.isFinite(Date.parse(event.time)) || !digest(event.beforeDigest) || !digest(event.afterDigest) || !Array.isArray(event.edits) || event.edits.some(edit => !['from','to','newFrom','newTo'].every(key=>Number.isSafeInteger(edit[key])&&edit[key]>=0) || edit.to < edit.from || edit.newTo < edit.newFrom || typeof edit.removed !== 'string' || typeof edit.insert !== 'string' || edit.removed.length !== edit.to - edit.from || edit.insert.length !== edit.newTo - edit.newFrom)) corrupt();
      ids.add(event.id);
      if (['beforeTextDigest','afterTextDigest'].some(key => event[key] != null && (typeof event[key] !== 'string' || !digest(event[key])))) corrupt();
    }
    if (value.events.length !== value.revision || value.events.some((event,i) => event.revision !== i + 1 || i && event.beforeDigest !== value.events[i-1].afterDigest) || value.events.length && value.events.at(-1).afterDigest !== value.digest) corrupt();
    if (value.events.some((event,i) => i && event.beforeTextDigest != null && value.events[i-1].afterTextDigest != null && event.beforeTextDigest !== value.events[i-1].afterTextDigest)
      || value.events.length && value.textDigest != null && value.events.at(-1).afterTextDigest != null && value.events.at(-1).afterTextDigest !== value.textDigest) corrupt();
    let end = 0;
    for (const span of value.spans) { if (!ids.has(span.eventId) || !Number.isSafeInteger(span.from) || !Number.isSafeInteger(span.to) || span.from < end || span.to <= span.from || span.to > value.text.length) corrupt(); end = span.to; }
    if (value.points.some(point => !ids.has(point.eventId) || !Number.isSafeInteger(point.from) || point.from < 0 || point.from > value.text.length)) corrupt();
    if (value.pending) {
      const candidate = value.pending.candidate;
      if (!candidate || candidate.pending || candidate.docId !== value.docId || candidate.revision !== value.revision + 1 || value.pending.beforeDigest !== value.digest) corrupt();
      this.validate(candidate, rel);
    }
  }
  async withLock(rel, work) {
    await this.directories(true);
    const file = this.location(rel) + '.lock';
    let held;
    for (let i=0;i<2;i++) {
      try { held = await fs.open(file, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Recover only an identifiable dead host's lock. An unidentifiable or
        // living writer is a conflict, never permission to erase its journal.
        const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) corrupt();
        let old; try { old = JSON.parse(await fs.readFile(file,'utf8')); } catch { corrupt(); }
        if (!Number.isSafeInteger(old.pid) || old.pid < 1) corrupt();
        let alive = true; try { process.kill(old.pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
        if (alive || i) throw new ChangeFileError('CHANGE_HISTORY_BUSY', '另一个程序正在写此文档，当前内容已保留。');
        await fs.unlink(file);
      }
    }
    try { await held.writeFile(JSON.stringify({ pid: process.pid })); await held.sync(); return await work(); }
    finally { await held.close(); await fs.unlink(file); }
  }
  async write(rel, value) {
    this.validate(value, rel);
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > MAX_LEDGER) throw new ChangeFileError('CHANGE_HISTORY_FULL', '修改记录已达32MiB上限，草稿已保留，请先归档历史。');
    await this.directories(true);
    const temp = path.join(this.directory, '.pending-' + randomUUID());
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600); await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp, this.location(rel));
      if (process.platform !== 'win32') { const dir = await fs.open(this.directory,'r'); try { await dir.sync(); } finally { await dir.close(); } }
    } finally { await handle?.close(); await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
    return value;
  }
  initial(rel, text, digest, metadata = {}) { return { format:'nozeli.file-changes',schemaVersion:1,...metadata,relPath:rel,docId:randomUUID(),revision:0,digest,text:anchorText(text),textDigest:textDigest(anchorText(text)),spans:[],points:[],events:[],attempts:[],pending:null }; }
  async observe(rel, text, digest, metadata = {}) {
    text = anchorText(text);
    let value = await this.read(rel);
    if (!value) return this.write(rel, this.initial(rel, text, digest, metadata));
    if (metadata.textSpace && value.textSpace !== metadata.textSpace) throw new ChangeFileError('CHANGE_HISTORY_SPACE','正文位置格式不同，原记录已保留；未覆盖文档。');
    if (value.pending) {
      if (digest === value.pending.candidate.digest) value = await this.write(rel, value.pending.candidate);
      else {
        const attempt = { beforeDigest:value.pending.beforeDigest,candidate:{...value.pending.candidate,attempts:[]}, outcome: digest === value.digest ? 'not-written' : 'source-diverged', observedAt: new Date().toISOString() };
        value = await this.write(rel, { ...value, pending:null, attempts:[...value.attempts, attempt] });
      }
    }
    if (value.digest !== digest) {
      const candidate = this.candidate(value, text, digest, textChangeSet(value.text, text), externalActor, { type:'external' });
      value = await this.write(rel, candidate);
    } else if (value.text !== text) corrupt();
    return value;
  }
  candidate(value, text, digest, changes, actor, context = {}) {
    const event = changeRecord(value.text, text, changes, { id:randomUUID(),actor,time:new Date().toISOString(),revision:value.revision+1,beforeDigest:value.digest,afterDigest:digest,...context });
    event.beforeTextDigest = textDigest(value.text); event.afterTextDigest = textDigest(anchorText(text));
    const mapped = mapAttribution(value.spans, value.points, changes, event);
    return { ...value, revision:value.revision+1,text:anchorText(text),textDigest:event.afterTextDigest,digest,...mapped,events:[...value.events,event],pending:null };
  }
  async prepare(rel, value, candidate) {
    if ((await this.read(rel))?.revision !== value.revision) throw new ChangeFileError('CONFLICT', '修改记录版本已变化。');
    await this.write(rel, { ...value, pending:{ beforeDigest:value.digest, candidate } });
  }
  async finish(rel, candidate) {
    const value = await this.read(rel);
    if (value?.pending?.candidate.events.at(-1).id !== candidate.events.at(-1).id) throw new ChangeFileError('CONFLICT','待确认修改记录已变化。');
    return this.write(rel, candidate);
  }
  async all() {
    if (!await this.directories()) return [];
    const result = [];
    for (const name of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const stat=await fs.lstat(path.join(this.directory,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_LEDGER)corrupt();
      const handle = await fs.open(path.join(this.directory,name), constants.O_RDONLY | (constants.O_NOFOLLOW??0));
      let probe; try { const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_LEDGER)corrupt();probe=JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
      if (path.basename(this.location(probe.relPath)) !== name) corrupt();
      result.push(await this.read(probe.relPath));
    }
    return result;
  }
}
export { publicChanges };
