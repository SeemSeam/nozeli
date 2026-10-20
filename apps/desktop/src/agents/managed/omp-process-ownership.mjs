// OMP 进程归属与后代清点（P1 生产模块，worker1 2026-10-15）。
// 复用共享 processStamp（通用 /proc stat+boot_id）；OMP 专属过滤按 PI_CODING_AGENT_DIR 与
// omp 可执行标记——共享 reapOwnedGroup/recoverProvider 按 CODEX_HOME/app-server 校验，对 OMP
// 会静默清点为空（不可复用），故此处独立实现；非 Linux 平台诚实返回未验证，不假签确认。
import fs from 'node:fs/promises';
import path from 'node:path';
import { processStamp } from './process-ownership.mjs';

export async function ompGroupRecord(pid, home) {
  const stamp = await processStamp(pid);
  return { pid, home, stamp, kind: 'omp-rpc' };
}

// 后代清点+清收：同进程组、env 含 PI_CODING_AGENT_DIR=<home>、cmdline 含 omp。
// Linux 实证路径；其他平台返回 verified:false（不假签）。
export async function reapOwnedOmpGroup(record) {
  if (process.platform !== 'linux' || !record?.stamp) return { descendantsReaped: 0, verified: false, platform: process.platform };
  if (typeof record.stamp !== 'string' || !/^[a-f0-9-]{36}:\d+$/.test(record.stamp)) return { descendantsReaped: 0, verified: false, platform: process.platform };
  const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!record.stamp.startsWith(boot + ':')) return { descendantsReaped: 0, verified: true, reason: 'previous-boot', platform: 'linux' };
  const touched = new Set();
  for (let attempt = 0; attempt < 25; attempt++) {
    const leader = await processStamp(record.pid);
    if (leader && leader !== record.stamp) throw new Error('omp provider group identity reused');
    const members = [];
    let retryScan = false;
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
        const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (parts[0] === 'Z' || Number(parts[2]) !== record.pid) continue;
        const env = (await fs.readFile(`/proc/${entry}/environ`)).toString().split('\0');
        if (!env.includes(`NOZELI_AGENT_DIR=${record.home}`) && !env.includes(`PI_CODING_AGENT_DIR=${record.home}`)) {
          if (!(await processStamp(Number(entry)))) continue;
          if (!env.some(Boolean) && attempt < 5) { retryScan = true; break; }
          continue; // 同组但非本 provider 家族（如页面辅助进程）：不清收，只计数外
        }
        members.push({ pid: Number(entry), stamp: `${boot}:${parts[19]}` });
      } catch (error) {
        if (error.code === 'EACCES') { if (!(await processStamp(Number(entry)))) continue; if (attempt < 5) { retryScan = true; break; } }
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
      }
    }
    if (retryScan) { await new Promise(r => setTimeout(r, 20)); continue; }
    if (!members.length) return { descendantsReaped: touched.size, verified: true, platform: 'linux' };
    for (const member of members) {
      if (await processStamp(member.pid) !== member.stamp) continue;
      try { process.kill(member.pid, attempt < 10 ? 'SIGTERM' : 'SIGKILL'); touched.add(member.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('owned omp provider descendants did not exit');
}

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


// OMP 进程记录恢复（restore 路径；对齐共享 recoverProvider 语义但按 PI_CODING_AGENT_DIR+omp rpc 标记校验）。
export async function recoverOmpProvider(record, root, attempt = 0) {
  if (process.platform !== 'linux') throw new Error('omp orphan identity recovery is verified on Linux only');
  const rel = path.relative(path.join(root, 'agents'), record.home);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('provider home outside owned agents root');
  if (!record.stamp) throw new Error('provider process identity missing');
  if (typeof record.stamp !== 'string' || !/^[a-f0-9-]{36}:\d+$/.test(record.stamp)) throw new Error('provider process identity invalid');
  const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!record.stamp.startsWith(boot + ':')) return { pid: record.pid, status: 'previous-boot', descendantsReaped: 0, verified: true };
  const stamp = await processStamp(record.pid);
  if (!stamp) return { pid: record.pid, status: 'already-exited', ...await reapOwnedOmpGroup(record) };
  if (stamp !== record.stamp) throw new Error('provider PID identity reused');
  let env, cmd;
  try {
    env = (await fs.readFile(`/proc/${record.pid}/environ`)).toString().split('\0');
    cmd = (await fs.readFile(`/proc/${record.pid}/cmdline`)).toString().split('\0');
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code) && !(await processStamp(record.pid))) return { pid: record.pid, status: 'exited-during-check', ...await reapOwnedOmpGroup(record) };
    if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code) && attempt < 5) { await new Promise(r => setTimeout(r, 20)); return recoverOmpProvider(record, root, attempt + 1); }
    throw error;
  }
  if (await processStamp(record.pid) !== record.stamp) return recoverOmpProvider(record, root);
  const isOmpRpc = (env.includes(`NOZELI_AGENT_DIR=${record.home}`) || env.includes(`PI_CODING_AGENT_DIR=${record.home}`)) && ((cmd.includes('--mode') && cmd.includes('rpc')) || cmd.includes('--session-dir')) && cmd.some(v => v.includes('omp') || v.includes('pi-coding-agent'));
  if (!isOmpRpc) {
    if (attempt < 5 && (!env.some(Boolean) || !cmd.some(Boolean))) { await new Promise(r => setTimeout(r, 20)); return recoverOmpProvider(record, root, attempt + 1); }
    throw new Error('omp provider identity cannot be verified');
  }
  const signal = sig => { try { process.kill(-record.pid, sig); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  signal('SIGTERM');
  for (let i = 0; i < 20; i++) { if (await processStamp(record.pid) !== record.stamp) return { pid: record.pid, status: 'stopped', ...await reapOwnedOmpGroup(record) }; await new Promise(r => setTimeout(r, 100)); }
  signal('SIGKILL');
  for (let i = 0; i < 20; i++) { if (await processStamp(record.pid) !== record.stamp) return { pid: record.pid, status: 'killed', ...await reapOwnedOmpGroup(record) }; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('owned omp provider did not exit');
}
