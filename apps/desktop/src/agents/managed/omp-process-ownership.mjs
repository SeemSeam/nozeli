// OMP process identity uses kernel facts and exact NUL-delimited arguments.
import fs from 'node:fs/promises';
import path from 'node:path';
import {processStamp} from './process-ownership.mjs';
import {reapGroup,recoverOwned} from '../../platform/owned-processes.mjs';
const homeKeys=['NOZELI_AGENT_DIR','PI_CODING_AGENT_DIR'];
export async function ompGroupRecord(pid,home){return {pid,home,stamp:await processStamp(pid),kind:'omp-rpc'};}
export const reapOwnedOmpGroup=(record,options)=>reapGroup(record,homeKeys,options);
export const recoverOmpProvider=(record,root)=>recoverOwned(record,root,homeKeys,cmd=>((cmd.includes('--mode')&&cmd.includes('rpc'))||cmd.includes('--session-dir'))&&cmd.some(v=>v.includes('omp')||v.includes('pi-coding-agent')));

// 从 session 文件头部读 session id（首行 JSON {type:'session',id}；上游 session-storage 头部格式）。
export async function readSessionHeaderId(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, bytesRead);
    // 上游 journal 首行可为 title 槽（session-storage.ts:567 parseTitleSlotFromContent）；
    // 会话头在其后的首条 JSON 行。
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object' && entry.type === 'session' && typeof entry.id === 'string') return entry.id;
        if (entry?.type === 'message' || entry?.type === 'title') continue;
      } catch { /* 跳过非 JSON 行 */ }
    }
    return undefined;
  } finally { await handle.close(); }
}

// 在私有 sessions 目录按 id 精确 pin 会话文件：0 或多个命中都拒绝（不猜 latest）。
export async function pinSessionFileById(sessionsDir, sessionId) {
  let names;
  try { names = await fs.readdir(sessionsDir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const matches = [];
  for (const name of names.filter(n => n.endsWith('.jsonl')).sort()) {
    const full = path.join(sessionsDir, name);
    if ((await readSessionHeaderId(full)) === sessionId) matches.push(full);
  }
  return matches.length === 1 ? matches[0] : null;
}
