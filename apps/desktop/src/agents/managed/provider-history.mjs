import os from 'node:os';
import path from 'node:path';
import { opendir, realpath, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { openHistoryFile } from './provider-history-file.mjs';

// Read-only wire formats, not authorization or a resumable agent context:
// Codex: github.com/openai/codex codex-rs/protocol/src/protocol.rs (SessionMeta/RolloutItem).
// Claude: github.com/anthropics/claude-agent-sdk-python src/claude_agent_sdk/_internal/sessions.py.
// Pi: github.com/earendil-works/pi packages/coding-agent/src/core/session-manager.ts
// (SessionHeader v1-v3, SessionMessageEntry); default ~/.pi/agent/sessions.
// OMP: github.com/can1357/oh-my-pi packages/coding-agent/src/session/session-entries.ts
// (its own SessionHeader v1-v3 and optional leading title slot).
const PROVIDERS = ['codex', 'claude', 'pi', 'omp'];
const DEFAULTS = { files: 40, entries: 300, records: 600, bytes: 512 * 1024, lineBytes: 256 * 1024 };
const CATALOG_LIMITS = { files: 1800, entries: 15000, records: 4000, bytes: 20 * 1024 * 1024 };
const FREEZE_TEXT_BYTES = 128 * 1024;
const FREEZE_SOURCE_BYTES = 8 * 1024 * 1024;
const HANDOFF_TAIL_BYTES = 256 * 1024;
const FREEZE_ROWS = 20_000;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const bounded = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
// Keep prose and its qualifiers, not the flattened Markdown/tooling around it.
function previewProse(body){
  const lines=[];
  let fence='';
  for(const raw of body.split('\n')){
    const line=raw.trim(),marker=/^(`{3,}|~{3,})/.exec(line)?.[0];
    if(marker){if(!fence)fence=marker;else if(marker[0]===fence[0]&&marker.length>=fence.length)fence='';continue;}
    if(fence||!line||/^#{1,6}\s|^\|/.test(line)||line.split('|').length>=4)continue;
    const prose=line.replace(/^\s*(?:[-*+]\s+|>\s*)/,'')
      .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
      .replace(/`+([^`]+)`+/g,(_,value)=>/[\\/]/.test(value)?'':value)
      .replace(/\*\*|__|~~/g,'').replace(/\s+/g,' ').trim();
    if(prose)lines.push(prose);
    if(lines.join(' ').length>=140)break;
  }
  const text=lines.join(' ');
  if(text.length<=140)return text;
  const cutoff=Math.max(...['。','！','？','；','. '].map(mark=>text.lastIndexOf(mark,138)));
  return cutoff>=65?text.slice(0,cutoff+1):text.slice(0,139).replace(/[\uD800-\uDBFF]$/,'')+'…';
}
const version = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const failHistory = (code, message) => { throw Object.assign(new Error(message), { code }); };
const supportedSessionVersion = row => row.version === undefined || [1, 2, 3].includes(row.version);
const sessionTree = provider => provider === 'pi' || provider === 'omp';
const textParts = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(p => ['text', 'input_text', 'output_text'].includes(p?.type) && typeof p.text === 'string').map(p => p.text).join('\n') : '';
function metadata(provider, row) {
  if (provider === 'codex' && row.type === 'session_meta') return { cwd: row.payload?.cwd, id: row.payload?.id };
  if (provider === 'pi' && row.type === 'session' && supportedSessionVersion(row)) return { cwd: row.cwd, id: row.id };
  if (provider === 'omp' && row.type === 'session' && supportedSessionVersion(row)) return { cwd: row.cwd, id: row.id };
  if (provider === 'claude' && ['user', 'assistant'].includes(row.type) && typeof row.sessionId === 'string') return { cwd: row.cwd, id: row.sessionId };
  return null;
}
function records(provider, row) {
  const time = row.timestamp ?? row.message?.timestamp ?? null;
  if (provider === 'codex') {
    const p = row.payload;
    if (row.type !== 'response_item' || !p) return [];
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      const text = textParts(p.content);
      return text ? [{ role: p.role, category: 'message', time, text }] : [];
    }
    if (p.type === 'function_call_output' && typeof p.output === 'string') return [{ role: 'tool', category: 'tool_result', time, text: p.output }];
    return [];
  }
  if (sessionTree(provider) && row.type !== 'message') return [];
  if (provider === 'claude' && (!['user', 'assistant'].includes(row.type) || row.isMeta)) return [];
  const msg = row.message;
  if (!msg || !['user', 'assistant', 'toolResult'].includes(msg.role)) return [];
  const result = [];
  const text = textParts(msg.content);
  if (text) result.push({ role: msg.role === 'toolResult' ? 'tool' : msg.role, category: msg.role === 'toolResult' ? 'tool_result' : 'message', time, text });
  if (provider === 'claude' && Array.isArray(msg.content)) for (const part of msg.content) {
    if (part?.type === 'tool_result') {
      const output = textParts(part.content);
      if (output) result.push({ role: 'tool', category: 'tool_result', time, text: output });
    }
  }
  return result;
}
const ignoredEnvelopes = {
  codex: new Set(['session_meta', 'turn_context', 'event_msg']),
  claude: new Set(['system', 'summary', 'progress', 'file-history-snapshot', 'queue-operation', 'last-prompt', 'custom-title', 'tag', 'agent-name', 'agent-color', 'ai-title', 'pr-link', 'link-pr', 'attribution-snapshot']),
  pi: new Set(['session', 'model_change', 'thinking_level_change', 'compaction', 'branch_summary', 'custom', 'label', 'session_info', 'usage', 'custom_message', 'context_edit']),
  omp: new Set(['session', 'title', 'title_change', 'model_change', 'model_usage', 'thinking_level_change', 'service_tier_change', 'compaction', 'branch_summary', 'reset_boundary', 'custom', 'custom_message', 'label', 'session_init', 'credential_pin', 'ttsr_injection', 'mode_change']),
};
const omittedTypes = new Set(['system', 'credentials', 'credential', 'auth', 'authentication']);
const supportedParts = new Set(['text', 'input_text', 'output_text', 'image', 'image_url', 'input_image', 'output_image', 'tool_use', 'tool_result', 'toolCall', 'thinking', 'redacted_thinking']);
function unsupportedRecord(provider, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'unknown_envelope';
  if (omittedTypes.has(row.type)) return null;
  if (sessionTree(provider) && row.type === 'session' && !supportedSessionVersion(row)) return 'unsupported_session_version';
  if (ignoredEnvelopes[provider].has(row.type)) return null;
  let message;
  if (provider === 'codex') {
    if (row.type !== 'response_item' || !row.payload) return 'unknown_envelope';
    const p = row.payload;
    if (['function_call', 'custom_tool_call', 'reasoning', 'web_search_call', 'local_shell_call', 'image_generation_call', 'compaction'].includes(p.type)) return null;
    if (p.type === 'function_call_output') return typeof p.output === 'string' ? null : 'unknown_tool_output';
    if (p.type !== 'message') return 'unknown_response_item';
    message = p;
  } else {
    if (sessionTree(provider) && row.type !== 'message' || provider === 'claude' && !['user', 'assistant'].includes(row.type)) return 'unknown_envelope';
    if (provider === 'claude' && row.isMeta) return null;
    message = row.message;
  }
  if (!message || typeof message !== 'object') return 'unknown_message';
  if (['system', 'developer', 'credentials', 'credential'].includes(message.role)) return null;
  if (!['user', 'assistant', 'toolResult'].includes(message.role)) return 'unknown_role';
  function contentReason(content) {
    if (typeof content === 'string') return null;
    if (!Array.isArray(content)) return 'unknown_content';
    for (const part of content) {
      if (!part || !supportedParts.has(part.type)) return 'unknown_content';
      if (['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text !== 'string') return 'unknown_text_content';
      if (part.type === 'tool_result' && contentReason(part.content)) return 'unknown_tool_output';
    }
    return null;
  }
  return contentReason(message.content);
}
function coverage() {
  return { files: 0, entries: 0, records: 0, bytes: 0, matchedProjects: 0, unconfirmed: 0, unsupported: [], errors: [], pageLimitReached: false, limitScope: 'response-page; use nextCursor while host allows reads', scope: 'exact-canonical-cwd', contentScope: 'text-only;system,credentials,and-known-nontext-excluded', exhaustive: false, traversalComplete: false };
}

// Do not infer a leaf from append order or merge messages from multiple branches.
function freezeBranch(provider) {
  let leaf = null;
  let unlinked = false;
  const seen = new Set();
  const ambiguous = () => { throw Object.assign(new Error('History is not a single verifiable transcript'),{code:'AMBIGUOUS_HISTORY',branchConflict:true}); };
  return {
    check(row) {
      if (provider === 'codex') {
        if (row.type === 'event_msg' && ['thread_rolled_back', 'rollback'].includes(row.payload?.type)) ambiguous();
        return;
      }
      const claude = provider === 'claude';
      if (!claude && (row.type === 'session' || provider === 'omp' && row.type === 'title')) return;
      if (claude && (row.isSidechain || row.logicalParentUuid != null && row.logicalParentUuid !== row.parentUuid)) ambiguous();
      const id = claude ? row.uuid : row.id;
      const parent = claude ? row.parentUuid : row.parentId;
      const conversational = claude ? ['user', 'assistant'].includes(row.type) : row.type === 'message';
      if (id === undefined && parent === undefined) {
        if (conversational) {
          if (seen.size) ambiguous();
          unlinked = true;
        }
        return;
      }
      if (unlinked || typeof id !== 'string' || !id || seen.has(id) || parent !== leaf) ambiguous();
      if (provider === 'omp' && Object.hasOwn(row, 'activeLeafId') && row.activeLeafId !== id) ambiguous();
      seen.add(id);
      leaf = id;
    },
    scope: () => seen.size ? 'single-linked-chain;forks-rejected' : 'physical-order;no-branch-links-verified',
  };
}

function projectionOmission(provider, row, projected) {
  const message = provider === 'codex' ? row.payload : row.message;
  if (omittedTypes.has(row.type) || ['system', 'developer', 'credentials', 'credential'].includes(message?.role) ||
      provider === 'omp' && ['credential_pin', 'session_init'].includes(row.type)) return 'system_or_credentials';
  if (['compaction', 'branch_summary', 'reset_boundary', 'summary'].includes(row.type) || row.payload?.type === 'compaction') return 'context_boundaries_or_summaries';
  if (ignoredEnvelopes[provider].has(row.type) || provider === 'claude' && row.isMeta) return 'nontranscript_or_empty';
  const hasNontext = (content, toolResults = false) => Array.isArray(content) && content.some(part => part?.type === 'tool_result' && toolResults
    ? hasNontext(part.content) : !['text', 'input_text', 'output_text'].includes(part?.type));
  if (hasNontext(message?.content, provider === 'claude')) return 'nontext_content';
  return projected.length ? null : 'nontranscript_or_empty';
}

export function createProviderHistoryReader({ projectRoot, projectIdentity = projectRoot, home = os.homedir(), providerRoots = {}, budgets = {}, ticketTtlMs = 15 * 60 * 1000, now = Date.now, fault } = {}) {
  if (!path.isAbsolute(projectRoot || '') || typeof projectIdentity !== 'string' || !projectIdentity) throw new Error('Host project identity and absolute projectRoot required');
  const root = path.resolve(projectRoot);
  const roots = { codex: path.join(home, '.codex', 'sessions'), claude: path.join(home, '.claude', 'projects'), pi: path.join(home, '.pi', 'agent', 'sessions'), omp: path.join(home, '.omp', 'agent', 'sessions'), ...providerRoots };
  const limits = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, bounded(budgets[k], v, v * 8)]));
  const catalogLimits = Object.fromEntries(Object.entries(CATALOG_LIMITS).map(([k, v]) => [k, budgets[k] === undefined ? v : limits[k]]));
  const tickets = new Map();
  const responses = new Map();
  let closed = false;
  const initialProject = (async () => {
    try {
      const s = await lstat(root, { bigint: true });
      return s.isDirectory() && await realpath(root) === root ? `${s.dev}:${s.ino}` : null;
    } catch { return null; }
  })();
  function retire(key, ticket) {
    clearTimeout(ticket.timer);
    tickets.delete(key);
    return Promise.all(ticket.kind === 'search' ? ticket.data.stack.map(frame => frame.handle?.close().catch(() => {})) : []);
  }
  function consume(key) {
    clearTimeout(tickets.get(key)?.timer);
    tickets.delete(key);
  }
  function issue(kind, data) {
    if (closed) {
      if (kind === 'search') for (const frame of data.stack) frame.handle?.close().catch(() => {});
      return null;
    }
    for (const [key, value] of tickets) if (value.expires <= now()) retire(key, value);
    while (tickets.size >= 512) { const key = tickets.keys().next().value; retire(key, tickets.get(key)); }
    const token = randomBytes(24).toString('base64url');
    const ticket = { kind, data, identity: projectIdentity, expires: now() + ticketTtlMs };
    ticket.timer = setTimeout(() => retire(token, ticket), ticketTtlMs);
    ticket.timer.unref();
    tickets.set(token, ticket);
    return token;
  }
  function lookup(token, kind) {
    const ticket = typeof token === 'string' ? tickets.get(token) : null;
    return ticket?.kind === kind && ticket.identity === projectIdentity && ticket.expires > now() ? ticket.data : null;
  }
  async function projectStatus() {
    const initial = await initialProject;
    if (!initial) return 'unconfirmed_project';
    try {
      const s = await lstat(root, { bigint: true });
      return s.isDirectory() && `${s.dev}:${s.ino}` === initial && await realpath(root) === root ? null : 'stale_project';
    } catch { return 'stale_project'; }
  }
  async function belongs(cwd) {
    // Reject aliases/worktrees/missing or renamed roots rather than infer ownership.
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || path.resolve(cwd) !== root) return false;
    return !await projectStatus() && await realpath(cwd).catch(() => null) === root;
  }
  async function agentRecord(agent, name) {
    try {
      const file = await openHistoryFile(path.join(root,'.ccb','agents',agent,name));
      try {
        const bytes = Buffer.alloc(16385);
        const {bytesRead} = await file.read(bytes,0,bytes.length,0);
        return bytesRead < bytes.length ? JSON.parse(strictUtf8.decode(bytes.subarray(0,bytesRead))) : null;
      } finally { await file.close(); }
    } catch { return null; }
  }
  async function agentWorkspace(agent, runtime) {
    const expected=path.join(root,'.ccb','workspaces',agent);
    if(runtime?.schema_version!==2||runtime.record_type!=='agent_runtime'||runtime.agent_name!==agent||runtime.workspace_path!==expected)return null;
    const spec=await agentRecord(agent,'agent.json');
    if(spec?.schema_version!==2||spec.record_type!=='agent_spec'||spec.name!==agent||spec.workspace_mode!=='git-worktree')return null;
    const stat=await lstat(expected,{bigint:true}).catch(()=>null);
    if(!stat?.isDirectory()||await realpath(expected).catch(()=>null)!==expected)return null;
    return {cwd:expected,inode:`${stat.dev}:${stat.ino}`};
  }
  async function sourceBelongs(src) {
    if(!src.workspace)return belongs(src.meta.cwd);
    const runtime=await agentRecord(src.agent,'runtime.json');
    const workspace=await agentWorkspace(src.agent,runtime);
    return !await projectStatus()&&workspace?.cwd===src.meta.cwd&&workspace.inode===src.workspace.inode&&
      (!src.tailOnly||runtime.provider===src.provider&&runtime.session_id===src.meta.id);
  }
  async function agentStatus(agent, workspace) {
    if(!agent)return null;
    const row=await agentRecord(agent,'runtime.json');
    if(row?.schema_version!==2||row.record_type!=='agent_runtime'||row.agent_name!==agent||row.workspace_path!==(workspace?.cwd??root)||
       !PROVIDERS.includes(row.provider)||typeof row.state!=='string'||!/^[a-z][a-z_-]{0,31}$/.test(row.state)||
       typeof row.last_seen_at!=='string'||!Number.isFinite(Date.parse(row.last_seen_at)))return null;
    return {state:row.state,provider:row.provider,observedAt:new Date(row.last_seen_at).toISOString(),sessionId:row.session_id,authority:'recorded-not-live'};
  }
  function statusFor(snapshot, provider, sessionId) {
    if (!snapshot) return null;
    const {sessionId:reportedSession,...status}=snapshot;
    return {...status,sessionMatch:status.provider===provider&&reportedSession===sessionId};
  }
  async function safeOpen(file, provider, base = path.resolve(roots[provider])) {
    const relative = path.relative(base, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('outside_root');
    if (await realpath(base) !== base || await realpath(file) !== file) throw new Error('unconfirmed_path');
    const handle = await openHistoryFile(file, { fault });
    // The handle checks this path against its pinned descriptor at read/close.
    // Use bigint path stats here so tickets retain nanosecond version precision.
    return { ...handle, stat: () => lstat(file, { bigint: true }) };
  }
  const descriptor = s => ({
    provider: s.provider,
    sourcePath: path.relative(s.agent == null ? path.resolve(roots[s.provider]) : root, s.file).split(path.sep).join('/'),
    sourceVersion: s.stamp,
    versionKind: 'filesystem-stat:dev,ino,size,mtimeNs,ctimeNs;not-a-content-digest',
    ...(s.workspace&&{workspacePath:path.relative(root,s.workspace.cwd).split(path.sep).join('/')}),
    ...(s.tailOnly&&{selectionScope:'recent-dialogue-only'}),
  });
  const stream = (file, provider, stamp) => ({ file, provider, stamp, offset: 0, lineOrdinal: 0, pending: Buffer.alloc(0), dropping: false, eof: false, meta: null, incomplete: false });
  async function line(s, cov, { pinned, byteLimit = limits.bytes, chunkBytes = 16384 } = {}) {
    for (;;) {
      const newline = s.pending.indexOf(10);
      if (newline >= 0 || s.eof && s.pending.length) {
        const end = newline >= 0 ? newline : s.pending.length;
        const byteOffset = s.offset - s.pending.length;
        const lineOrdinal = ++s.lineOrdinal;
        const value = s.pending.subarray(0, end);
        s.pending = s.pending.subarray(newline >= 0 ? end + 1 : end);
        cov.records++;
        if (newline < 0) {
          s.incomplete = true;
          cov.errors.push({ provider: s.provider, code: 'unterminated_record' });
          if (!s.dropping && value.length > limits.lineBytes) cov.unsupported.push({ provider: s.provider, reason: 'record_too_large' });
          s.dropping = false;
          return { skipped: true };
        }
        if (s.dropping || value.length > limits.lineBytes) { if(!s.dropping)cov.unsupported.push({ provider:s.provider,reason:'record_too_large' });s.dropping=false;s.incomplete=true;return { skipped:true }; }
        try { return { row: JSON.parse(strictUtf8.decode(value)), byteOffset, lineOrdinal }; } catch { s.incomplete = true; cov.errors.push({ provider: s.provider, code: 'malformed_jsonl' }); return { skipped: true }; }
      }
      if (s.eof) {
        if (s.dropping) {
          s.dropping = false; s.incomplete = true;
          cov.errors.push({ provider: s.provider, code: 'unterminated_record' });
        }
        return null;
      }
      if (cov.bytes >= byteLimit) return undefined;
      const handle = pinned ?? await safeOpen(s.file, s.provider);
      try {
        if (version(await handle.stat()) !== s.stamp) throw new Error('stale');
        const buffer = Buffer.alloc(Math.min(chunkBytes, byteLimit - cov.bytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, s.offset);
        s.offset += bytesRead; cov.bytes += bytesRead;
        if (!bytesRead) s.eof = true;
        else s.pending = Buffer.concat([s.pending, buffer.subarray(0, bytesRead)]);
        if (s.pending.length > limits.lineBytes && s.pending.indexOf(10) < 0) {
          if(!s.dropping){s.incomplete=true;cov.unsupported.push({provider:s.provider,reason:'record_too_large'});}
          s.pending=Buffer.alloc(0);s.dropping=true;
        }
      } finally { if (!pinned) await handle.close(); }
    }
  }
  async function nextFile(state, cov, entryLimit = limits.entries) {
    while (state.stack.length && cov.entries < entryLimit) {
      const frame = state.stack[state.stack.length - 1];
      if (!frame.handle) {
        let canonical;
        try { canonical = await realpath(frame.dir); } catch (error) {
          if (!(frame.optional && error.code === 'ENOENT')) cov.errors.push({ provider: frame.provider, code: error.code || 'directory_error' });
          state.stack.pop(); continue;
        }
        if (canonical !== frame.dir) { cov.unconfirmed++; state.stack.pop(); continue; }
        frame.handle = await opendir(frame.dir).catch(error => { cov.errors.push({ provider: frame.provider, code: error.code || 'directory_error' }); return null; });
      }
      if (!frame.handle) { state.stack.pop(); continue; }
      const entry = await frame.handle.read();
      if (!entry) { await frame.handle.close(); state.stack.pop(); continue; }
      cov.entries++;
      const file = path.join(frame.dir, entry.name);
      if (entry.isSymbolicLink()) { cov.unconfirmed++; continue; }
      if (entry.isDirectory()) {
        if (frame.depth < 5) state.stack.push({ dir: file, provider: frame.provider, base: frame.base, agent: frame.agent, depth: frame.depth + 1 });
        else cov.unsupported.push({ provider: frame.provider, reason: 'directory_depth_limit' });
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) return { file, provider: frame.provider, base: frame.base, agent: frame.agent };
    }
    return null;
  }
  async function catalog({ limit, previews = false } = {}) {
    const items = [];
    if (closed || await projectStatus()) return { items, limited: false };
    const count = bounded(limit, 1500, 1500);
    const cov = coverage();
    const state = { stack: PROVIDERS.map(provider => ({ dir: path.resolve(roots[provider]), provider, agent: null, depth: 0, optional: true })) };
    const agents = path.join(root, '.ccb', 'agents');
    if (await realpath(agents).catch(error => {
      if (error.code !== 'ENOENT') cov.errors.push({ code: error.code || 'directory_error' });
      return null;
    }) === agents) {
      try {
        const dir = await opendir(agents);
        try {
          while (cov.entries < catalogLimits.entries) {
            const entry = await dir.read();
            if (!entry) break;
            cov.entries++;
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const stateDir = path.join(agents, entry.name, 'provider-state');
            for (const [provider, segments] of [['omp', ['omp', 'sessions']], ['pi', ['pi', 'sessions']], ['codex', ['codex', 'home', 'sessions']]]) {
              const base = path.join(stateDir, ...segments);
              state.stack.push({ dir: base, base, provider, agent: entry.name, depth: 0, optional: true });
            }
          }
        } finally { await dir.close(); }
      } catch (error) { cov.errors.push({ code: error.code || 'directory_error' }); }
    }

    // Rank files before spending the per-file metadata budget. Directory
    // enumeration order and transcript timestamps are not activity order.
    const candidates = [];
    try {
      for (let found; (found = await nextFile(state, cov, catalogLimits.entries));) {
        try {
          const stat = await lstat(found.file, { bigint: true });
          if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n) candidates.push({ ...found, stat });
        } catch (error) { cov.errors.push({ provider: found.provider, code: error.code || 'stat_error' }); }
      }
    } catch (error) { cov.errors.push({ code: error.code || 'directory_error' }); }
    finally { for (const frame of state.stack) await frame.handle?.close().catch(() => {}); }
    candidates.sort((a, b) => a.stat.mtimeNs === b.stat.mtimeNs
      ? (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) : a.stat.mtimeNs > b.stat.mtimeNs ? -1 : 1);

    let limited = Boolean(state.stack.length || cov.errors.length || cov.unsupported.length), eligible = 0;
    const statuses=new Map();
    const workspaces=new Map();
    for (const candidate of candidates) {
      if (cov.files >= catalogLimits.files || cov.records >= catalogLimits.records || cov.bytes >= catalogLimits.bytes) { limited = true; break; }
      cov.files++;
      const { file, provider, agent, base, stat } = candidate;
      const stamp = version(stat);
      let meta, recent, workspace, tailOnly=false, unavailable = stat.size > BigInt(FREEZE_SOURCE_BYTES) ? 'HISTORY_SCAN_LIMIT' : null;
      try {
        const handle = await safeOpen(file, provider, base);
        try {
          if (version(await handle.stat()) !== stamp) throw new Error('stale');
          const scan = stream(file, provider, stamp);
          const maxRows = provider === 'claude' ? 32 : provider === 'omp' ? 2 : 1;
          for (let index = 0; index < maxRows; index++) {
            if (cov.records >= catalogLimits.records) { limited = true; break; }
            const value = await line(scan, cov, { pinned: handle, byteLimit: catalogLimits.bytes, chunkBytes: 4096 });
            if (value === undefined) { limited = true; break; }
            if (!value) break;
            if (value.skipped) { limited ||= scan.incomplete; break; }
            const { row } = value;
            if (!row || typeof row !== 'object' || Array.isArray(row)) break;
            if (provider === 'omp' && index === 0 && row.type === 'title') continue;
            meta = metadata(provider, row);
            if (provider === 'omp' && meta && (row.parentSession !== undefined || row.continuationOf !== undefined ||
                row.additionalDirectories !== undefined && (!Array.isArray(row.additionalDirectories) || row.additionalDirectories.length))) unavailable = 'AMBIGUOUS_HISTORY';
            if (provider !== 'claude' || meta?.cwd !== undefined) break;
            if (index === maxRows - 1) limited = true;
          }
          if(agent&&meta?.cwd&&meta.cwd!==root){
            if(!workspaces.has(agent)){
              const runtime=await agentRecord(agent,'runtime.json');
              workspaces.set(agent,{runtime,workspace:await agentWorkspace(agent,runtime)});
            }
            const scoped=workspaces.get(agent);
            if(scoped.workspace?.cwd===meta.cwd){
              workspace=scoped.workspace;
              tailOnly=unavailable==='HISTORY_SCAN_LIMIT'&&provider==='codex'&&scoped.runtime.provider===provider&&scoped.runtime.session_id===meta.id;
              if(tailOnly)unavailable=null;
            }
          }
          // Inspect only the tail of eligible journals; full verification still runs on submission.
          if((previews||tailOnly)&&!unavailable&&eligible<450&&meta?.cwd===(workspace?.cwd??root)&&typeof meta.id==='string'){
            const size=Number(stat.size), length=Math.min(size,tailOnly?HANDOFF_TAIL_BYTES:16*1024), start=size-length;
            const bytes=Buffer.alloc(length);
            const {bytesRead}=await handle.read(bytes,0,length,start);
            const tail=bytes.subarray(0,bytesRead);
            recent=[];
            let end=tail.lastIndexOf(10);
            while(end>=0){
              const previous=end>0?tail.lastIndexOf(10,end-1):-1;
              if(previous<0&&start>0)break;
              try{
                const row=JSON.parse(strictUtf8.decode(tail.subarray(previous+1,end)));
                const linked=metadata(provider,row);
                if(linked&&(linked.id!==meta.id||linked.cwd!==meta.cwd)||tailOnly&&row?.type==='turn_context'&&row.payload?.cwd!=null&&row.payload.cwd!==meta.cwd){recent=[];break;}
                if(recent.length>=4){end=previous;continue;}
                const role=provider==='codex'?row?.payload?.role:row?.message?.role;
                if(role!=='user'&&role!=='assistant'){end=previous;continue;}
                for(const record of records(provider,row)){
                  if(!['user','assistant'].includes(record.role))continue;
                  const text=previewProse(record.text);
                  if(!text)continue;
                  const ms=typeof record.time==='number'?record.time:typeof record.time==='string'?Date.parse(record.time):NaN;
                  const date=new Date(ms);
                  recent.push({role:record.role,text,time:Number.isFinite(+date)?date.toISOString():null,byteOffset:start+previous+1});
                  break;
                }
              }catch{/* Ignore incomplete or unsupported preview records. */}
              end=previous;
            }
            recent.reverse();
            if(tailOnly&&!recent.length)unavailable='HISTORY_NO_TEXT';
          }
        } finally { await handle.close(); }
      } catch { limited = true; continue; }
      if (typeof meta?.id !== 'string' || !meta.id || meta.cwd !== (workspace?.cwd??root)) continue;
      if (items.length >= count) { limited = true; break; }
      const src = { file, provider, agent, base, stamp, meta, workspace, tailOnly, recent };
      if (!unavailable && eligible >= 450) { limited = true; continue; }
      const source = unavailable ? null : issue('catalog-source', src);
      if (!source && !unavailable) break;
      if (source) eligible++;
      const statusKey=JSON.stringify([agent,workspace?.cwd??root]);
      if(agent&&!statuses.has(statusKey))statuses.set(statusKey,await agentStatus(agent,workspace));
      const status=statusFor(statuses.get(statusKey),provider,meta.id);
      const time=previews?(recent?.reduce((latest,row)=>row.time&&(!latest||Date.parse(row.time)>Date.parse(latest))?row.time:latest,null)??null):stat.mtime.toISOString();
      items.push({ source, provider, agent, sessionId: meta.id, time, descriptor: descriptor(src), ...(previews&&{recent:(recent??[]).map(({role,text,time})=>({role,text,time}))}), ...(status && {agentStatus:status}), ...(unavailable && { unavailable }) });
    }
    if (closed || await projectStatus()) return { items: [], limited };
    if(previews)items.sort((a,b)=>(b.time??'').localeCompare(a.time??''));
    return { items, limited };
  }

  async function search({ query = '', provider, cursor, limit = 20 } = {}) {
    if (typeof query !== 'string' || query.length > 1000 || provider !== undefined && !PROVIDERS.includes(provider)) return { status: 'unsupported', items: [], hasMore: false, coverage: coverage() };
    const hasCursor = cursor !== undefined && cursor !== null;
    const state = hasCursor ? lookup(cursor, 'search') : { query, provider, stack: (provider ? [provider] : [...PROVIDERS]).reverse().map(p => ({ dir: path.resolve(roots[p]), provider: p, depth: 0 })), current: null };
    if (!state || state.query !== query || state.provider !== provider) return { status: 'invalid_cursor', items: [], hasMore: false, coverage: coverage() };
    // Continuations are single-use so concurrent/replayed calls cannot mutate the same scan.
    if (hasCursor) consume(cursor);
    const cov = coverage(); const items = []; const count = bounded(limit, 20, 50);
    const identityError = await projectStatus();
    if (identityError || closed) {
      for (const frame of state.stack) await frame.handle?.close().catch(() => {});
      return { status: closed ? 'closed' : identityError, items, hasMore: false, coverage: cov };
    }
    while (items.length < count && cov.records < limits.records && cov.bytes < limits.bytes && cov.entries < limits.entries) {
      if (!state.current) {
        if (cov.files >= limits.files) break;
        const found = await nextFile(state, cov);
        if (!found) break;
        cov.files++;
        try {
          const handle = await safeOpen(found.file, found.provider);
          try { state.current = stream(found.file, found.provider, version(await handle.stat())); } finally { await handle.close(); }
        } catch (error) { cov.errors.push({ provider: found.provider, code: error.code || error.message }); continue; }
      }
      const s = state.current;
      try {
        const value = await line(s, cov);
        if (value === undefined) break;
        if (value === null) {
          if (!s.meta) cov.unsupported.push({ provider: s.provider, reason: 'missing_supported_metadata' });
          state.current = null; continue;
        }
        if (!Object.hasOwn(value, 'row')) continue;
        if (!value.row || typeof value.row !== 'object' || Array.isArray(value.row)) { s.incomplete = true; cov.unsupported.push({ provider: s.provider, reason: 'unknown_envelope' }); continue; }
        const meta = metadata(s.provider, value.row);
        if (meta) {
          if (!await belongs(meta.cwd) || typeof meta.id !== 'string') { cov.unconfirmed++; state.current = null; continue; }
          if (s.meta && s.meta.id !== meta.id) { cov.unsupported.push({ provider: s.provider, reason: 'mixed_sessions' }); state.current = null; continue; }
          if (!s.meta) cov.matchedProjects++;
          s.meta = meta;
        }
        const unsupported = unsupportedRecord(s.provider, value.row);
        if (unsupported) { s.incomplete = true; cov.unsupported.push({ provider: s.provider, reason: unsupported }); continue; }
        if (!s.meta) continue;
        const candidates = records(s.provider, value.row);
        const recordIndex = candidates.findIndex(r => !query || r.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
        const match = candidates[recordIndex];
        if (match) {
          const source = issue('source', { file: s.file, provider: s.provider, stamp: s.stamp, meta: s.meta });
          const preview = [...match.text].slice(0, 240).join('');
          items.push({ source, descriptor: descriptor(s), provider: s.provider, sessionId: s.meta.id, time: match.time, preview,
            location: { byteOffset: value.byteOffset, lineOrdinal: value.lineOrdinal, recordIndex, textStart: 0, textEnd: preview.length, textOffsetUnit: 'utf16-code-unit' }, untrusted: true });
          // One search preview per session; read explicitly to inspect its remaining records.
          state.current = null;
        }
      } catch (error) { cov.errors.push({ provider: s.provider, code: error.code || error.message }); state.current = null; }
    }
    const hasMore = Boolean(state.current || state.stack.length);
    cov.traversalComplete = !hasMore;
    cov.exhaustive = false; // A preview stops at the first matching record of each session.
    cov.pageLimitReached = hasMore && items.length < count;
    cov.previewOnly = true;
    return { status: 'ok', items, hasMore, nextCursor: hasMore ? issue('search', state) : null, coverage: cov };
  }
  async function read({ source, cursor, maxBytes = 32768 } = {}) {
    const src = lookup(source, 'source'); const cov = coverage();
    const fail = status => ({ status, records: [], hasMore: false, coverage: cov });
    if (!src) return fail('invalid_source');
    const hasCursor = cursor !== undefined && cursor !== null;
    const state = hasCursor ? lookup(cursor, 'read') : { source, scan: stream(src.file, src.provider, src.stamp), queue: [] };
    if (!state || state.source !== source) return fail('invalid_cursor');
    if (hasCursor) consume(cursor);
    try {
      const identityError = await projectStatus();
      if (identityError || closed) return fail(closed ? 'closed' : identityError);
      if (!await belongs(src.meta.cwd)) return fail('stale');
      const handle = await safeOpen(src.file, src.provider);
      try { if (version(await handle.stat()) !== src.stamp) return fail('stale'); } finally { await handle.close(); }
      const result = []; let remaining = bounded(maxBytes, 32768, 128 * 1024);
      while (remaining > 0 && cov.records < limits.records) {
        if (state.queue.length) {
          const record = state.queue[0]; let used = 0; let end = 0;
          for (const char of record.text) { const size = Buffer.byteLength(char); if (used + size > remaining) break; used += size; end += char.length; }
          if (!end) {
            if (!result.length) return { status: 'byte_budget_too_small', requiredBytes: Buffer.byteLength([...record.text][0]), records: [], hasMore: true, nextCursor: issue('read', state), coverage: cov };
            break;
          }
          const { textOffset, ...publicRecord } = record;
          result.push({ ...publicRecord, text: record.text.slice(0, end),
            location: { ...record.location, textStart: textOffset, textEnd: textOffset + end, textOffsetUnit: 'utf16-code-unit' },
            continued: end < record.text.length, untrusted: true });
          remaining -= used;
          if (end === record.text.length) state.queue.shift(); else { record.text = record.text.slice(end); record.textOffset += end; }
          continue;
        }
        const value = await line(state.scan, cov);
        if (value === undefined || value === null) break;
        if (!Object.hasOwn(value, 'row')) continue;
        if (!value.row || typeof value.row !== 'object' || Array.isArray(value.row)) { state.scan.incomplete = true; cov.unsupported.push({ provider: src.provider, reason: 'unknown_envelope' }); continue; }
        const meta = metadata(src.provider, value.row);
        if (meta) {
          if (meta.id !== src.meta.id || !await belongs(meta.cwd)) return fail('stale');
          state.scan.meta = meta;
        }
        const unsupported = unsupportedRecord(src.provider, value.row);
        if (unsupported) { state.scan.incomplete = true; cov.unsupported.push({ provider: src.provider, reason: unsupported }); continue; }
        if (state.scan.meta) state.queue.push(...records(src.provider, value.row).map((record, recordIndex) => ({ ...record,
          location: { byteOffset: value.byteOffset, lineOrdinal: value.lineOrdinal, recordIndex }, textOffset: 0 })));
      }
      const hasMore = Boolean(state.queue.length || !state.scan.eof || state.scan.pending.length);
      cov.traversalComplete = !hasMore;
      cov.incomplete = state.scan.incomplete;
      cov.exhaustive = !hasMore && !state.scan.incomplete; cov.pageLimitReached = hasMore;
      if (src.provider === 'omp') cov.branchScope = 'physical-jsonl;not-a-selected-branch';
      return { status: 'ok', descriptor: descriptor(src), provider: src.provider, sessionId: src.meta.id, records: result, hasMore, nextCursor: hasMore ? issue('read', state) : null, coverage: cov, untrusted: true };
    } catch (error) { cov.errors.push({ provider: src.provider, code: error.code || error.message }); return fail(error.message === 'stale' || ['ENOENT', 'SOURCE_CHANGED'].includes(error.code) ? 'stale' : error.code === 'IDENTITY_UNSUPPORTED' ? 'unsupported' : 'read_error'); }
  }
  // Scan one pinned version, including rows past the output cap, so later
  // conflicting ownership or branch links can't validate a misleading prefix.
  async function freezeRecentCodex(source,kind,src,changed,ambiguous){
    const cov=coverage(),result=[];
    let textBytes=0, start, size;
    try{
      const handle=await safeOpen(src.file,src.provider,src.base);
      try{
        const stat=await handle.stat();
        if(version(stat)!==src.stamp)changed();
        size=Number(stat.size);
        const scan=stream(src.file,src.provider,src.stamp);
        const header=await line(scan,cov,{pinned:handle,byteLimit:limits.lineBytes+1});
        const meta=metadata('codex',header?.row??{});
        if(meta?.id!==src.meta.id||meta.cwd!==src.meta.cwd)ambiguous();
        start=size-Math.min(size,HANDOFF_TAIL_BYTES);
        const bytes=Buffer.alloc(size-start);
        const {bytesRead}=await handle.read(bytes,0,bytes.length,start);
        if(bytesRead!==bytes.length)changed();
        let end=bytes.lastIndexOf(10), capped=false;
        while(end>=0){
          const previous=end>0?bytes.lastIndexOf(10,end-1):-1;
          if(previous<0&&start>0)break;
          const offset=previous+1, raw=bytes.subarray(offset,end);end=previous;
          let row;
          try{row=JSON.parse(strictUtf8.decode(raw));}catch{cov.errors.push({code:'malformed_tail_record'});continue;}
          if(!row||typeof row!=='object')continue;
          if(row.type==='session_meta'||row.type==='turn_context'&&row.payload?.cwd!=null&&row.payload.cwd!==src.meta.cwd)ambiguous();
          if(capped||row.type!=='response_item'||row.payload?.type!=='message')continue;
          for(const record of records('codex',row)){
            const length=Buffer.byteLength(record.text);
            if(textBytes+length>FREEZE_TEXT_BYTES||result.length>=128){capped=true;break;}
            textBytes+=length;
            result.push({...record,time:Number.isFinite(record.time)||typeof record.time==='string'&&record.time.length<=128?record.time:null,
              location:{byteOffset:start+offset,recordIndex:0,textStart:0,textEnd:record.text.length,textOffsetUnit:'utf16-code-unit'},continued:false,untrusted:true});
          }
        }
        cov.textLimitReached=capped;
        if(version(await handle.stat())!==src.stamp)changed();
      }finally{await handle.close();}
    }catch(error){
      if(['SOURCE_CHANGED','ENOENT','ENOTDIR','ELOOP'].includes(error.code)||error.message==='unconfirmed_path')changed();
      throw error;
    }
    if(!await sourceBelongs(src))changed();
    if(lookup(source,kind)!==src)failHistory('INVALID_PAYLOAD','History source expired or was revoked during freeze');
    if(!result.length)failHistory('HISTORY_NO_TEXT','末尾范围内没有可交接的对话');
    result.reverse();
    Object.assign(cov,{files:1,matchedProjects:1,bytes:cov.bytes+size-start,records:result.length,textBytes,scope:'verified-ccb-workspace',incomplete:true,
      branchScope:'physical-jsonl-tail',branchScanComplete:false,limitScope:'recent-dialogue-only',
      range:{startByteOffset:result[0].location.byteOffset,endByteOffsetExclusive:size},
      omissions:[{reason:'earlier_history_not_scanned'},{reason:'tail_user_assistant_messages_only'},...(cov.textLimitReached?[{reason:'tail_evidence_limit'}]:[])]});
    return {provider:src.provider,agent:src.agent,sessionId:src.meta.id,descriptor:descriptor(src),records:result,coverage:cov};
  }

  async function freeze(source, kind, allowPreview=false) {
    const src = lookup(source, kind);
    if (!src) failHistory('INVALID_PAYLOAD', 'An active history source from this reader is required');
    const changed = () => failHistory('STALE_SOURCE', 'History source no longer matches the selected version');
    const ambiguous = () => failHistory('AMBIGUOUS_HISTORY', 'History has conflicting session or project metadata');
    if (!await sourceBelongs(src)) changed();
    if(src.tailOnly)return freezeRecentCodex(source,kind,src,changed,ambiguous);

    const cov = coverage();
    const branch = freezeBranch(src.provider);
    const omissions = new Map();
    const omit = reason => omissions.set(reason, (omissions.get(reason) ?? 0) + 1);
    const result = [];
    let textBytes = 0;
    let previewOnly=false;
    let textLimitReached = false;
    try {
      const handle = await safeOpen(src.file, src.provider, src.base);
      try {
        const stat = await handle.stat();
        if (version(stat) !== src.stamp) changed();
        if (stat.size > BigInt(FREEZE_SOURCE_BYTES)) failHistory('HISTORY_SCAN_LIMIT', 'History exceeds the freeze source byte limit');
        const scan = stream(src.file, src.provider, src.stamp);
        const scanner = { pinned: handle, byteLimit: Number(stat.size) + 1 };
        for (;;) {
          const value = await line(scan, cov, scanner);
          if (value === null) break;
          if (!value || cov.records > FREEZE_ROWS) failHistory('HISTORY_SCAN_LIMIT', 'History exceeds the freeze scan limit');
          if (value.skipped) continue;
          const { row, byteOffset, lineOrdinal } = value;
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            cov.unsupported.push({ provider: src.provider, reason: 'unknown_envelope' });
            continue;
          }

          const meta = metadata(src.provider, row);
          const header = src.provider === 'codex' ? row.type === 'session_meta' : sessionTree(src.provider) && row.type === 'session';
          if (header && (!meta || scan.meta)) ambiguous();
          if (src.provider === 'omp' && header && (row.parentSession !== undefined || row.continuationOf !== undefined ||
              row.additionalDirectories !== undefined && (!Array.isArray(row.additionalDirectories) || row.additionalDirectories.length))) ambiguous();
          if (src.provider === 'claude' && (Object.hasOwn(row, 'cwd') && row.cwd !== src.meta.cwd ||
              Object.hasOwn(row, 'sessionId') && row.sessionId !== src.meta.id)) ambiguous();
          if (meta && (header || Object.hasOwn(row, 'cwd'))) {
            if (!meta.id || meta.id !== src.meta.id || meta.cwd !== src.meta.cwd) ambiguous();
            scan.meta = meta;
          }
          if(!previewOnly)try{branch.check(row);}catch(error){
            if(!allowPreview||!error.branchConflict||!src.recent?.length)throw error;
            previewOnly=true;
          }
          if (header) continue;
          if (!scan.meta) { omit('before_session_metadata'); continue; }
          if(previewOnly)continue;

          const unsupported = unsupportedRecord(src.provider, row);
          if (unsupported) { cov.unsupported.push({ provider: src.provider, reason: unsupported }); continue; }
          const candidates = records(src.provider, row);
          const omitted = projectionOmission(src.provider, row, candidates);
          if (omitted) omit(omitted);
          if (!candidates.length) continue;
          const size = candidates.reduce((bytes, record) => bytes + Buffer.byteLength(record.text), 0);
          if (textLimitReached || textBytes + size > FREEZE_TEXT_BYTES) {
            textLimitReached = true;
            omit('decoded_text_limit');
            continue;
          }
          textBytes += size;
          result.push(...candidates.map((record, recordIndex) => ({ ...record,
            time: Number.isFinite(record.time) || typeof record.time === 'string' && record.time.length <= 128 ? record.time : null,
            location: { byteOffset, lineOrdinal, recordIndex, textStart: 0, textEnd: record.text.length, textOffsetUnit: 'utf16-code-unit' },
            continued: false, untrusted: true,
          })));
        }
        if (!scan.meta || cov.bytes !== Number(stat.size) || version(await handle.stat()) !== src.stamp) changed();
        if (!await sourceBelongs(src)) changed();
      } finally { await handle.close(); }
    } catch (error) {
      if (['stale', 'unconfirmed_path'].includes(error.message) || ['SOURCE_CHANGED', 'ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) changed();
      throw error;
    }
    if (!await sourceBelongs(src)) changed();
    if (lookup(source, kind) !== src) failHistory('INVALID_PAYLOAD', 'History source expired or was revoked during freeze');
    if(previewOnly){
      const excerpts=['user','assistant'].map(role=>src.recent.findLast(item=>item.role===role)).filter(Boolean).sort((a,b)=>a.byteOffset-b.byteOffset);
      return {provider:src.provider,agent:src.agent,sessionId:src.meta.id,descriptor:descriptor(src),
        records:excerpts.map(({role,time,text,byteOffset})=>({role,time,text,category:'preview_excerpt',location:{byteOffset},continued:false,untrusted:true})),
        coverage:{...cov,matchedProjects:1,incomplete:true,exhaustive:false,branchScanComplete:false,limitScope:'preview-excerpts-only',omissions:[{reason:'unverified_branch_history'}]}};
    }
    if (!result.length && kind === 'catalog-source') failHistory('HISTORY_NO_TEXT', 'Selected history has no importable text');

    for (const entry of cov.errors) omit(entry.code);
    for (const entry of cov.unsupported) omit(entry.reason);
    cov.errors = [...new Map(cov.errors.map(entry => [entry.code, entry])).values()];
    cov.unsupported = [...new Map(cov.unsupported.map(entry => [entry.reason, entry])).values()];
    Object.assign(cov, {
      files: 1, matchedProjects: 1, traversalComplete: true, exhaustive: !omissions.size,
      incomplete: Boolean(omissions.size), omissions: [...omissions].map(([reason, count]) => ({ reason, count })),
      textBytes, textLimitReached, branchScope: branch.scope(),
      branchScanComplete: !cov.errors.length && !cov.unsupported.some(entry => ['record_too_large', 'unknown_envelope'].includes(entry.reason)),
      limitScope: 'single-source;complete-jsonl-rows;chronological-text-prefix',
      limits: { decodedTextBytes: FREEZE_TEXT_BYTES, sourceBytes: FREEZE_SOURCE_BYTES, rows: FREEZE_ROWS, lineBytes: limits.lineBytes },
    });
    const status=kind==='catalog-source'?statusFor(await agentStatus(src.agent,src.workspace),src.provider,src.meta.id):null;
    if (!await sourceBelongs(src)) changed();
    if(src.workspace)cov.scope='verified-ccb-workspace';
    return { provider: src.provider, ...(kind === 'catalog-source' && { agent: src.agent }), ...(status&&{agentStatus:status}), sessionId: src.meta.id, descriptor: descriptor(src), records: result, coverage: cov };
  }

  // Host response budgets apply to the complete serialized result, not just text.
  // Retain a prepared page when it cannot be delivered: the original request can
  // retry without advancing its scan a second time, including after host persistence fails.
  async function deliver(kind, args = {}, host) {
    if (!Number.isSafeInteger(host.maxBytes) || host.maxBytes < 128) throw new RangeError('History response budget must reserve at least 128 bytes');
    if (closed) return { status: 'closed' };
    const identityError = await projectStatus();
    if (identityError) return { status: identityError };
    const normalized = kind === 'search'
      ? { query: args.query ?? '', provider: args.provider, cursor: args.cursor, limit: args.limit ?? 20 }
      : { source: args.source, cursor: args.cursor, maxBytes: args.maxBytes ?? 32768 };
    const initialSearchId = kind === 'search' && normalized.cursor == null ? host.requestId ?? null : null;
    const key = JSON.stringify([kind, initialSearchId, normalized]);
    for (const [id, entry] of responses) if (entry.expires <= now()) responses.delete(id);
    let entry = responses.get(key);
    if (!entry) {
      while (responses.size >= 64) responses.delete(responses.keys().next().value);
      entry = { expires: now() + ticketTtlMs };
      entry.pending = (kind === 'search' ? search(normalized) : read(normalized)).then(result => JSON.stringify(result));
      responses.set(key, entry);
    }
    let serialized;
    try { serialized = await entry.pending; } catch (error) { responses.delete(key); throw error; }
    if (closed) return { status: 'closed' };
    const currentIdentityError = await projectStatus();
    if (currentIdentityError) return { status: currentIdentityError };
    const result = JSON.parse(serialized);
    const sources = kind === 'read' && result.status === 'ok' ? [normalized.source] : (result.items || []).map(item => item.source);
    for (const source of sources) {
      const src = lookup(source, 'source');
      if (!src) return { status: 'invalid_source' };
      try {
        const handle = await safeOpen(src.file, src.provider);
        try { if (version(await handle.stat()) !== src.stamp) return { status: 'stale' }; } finally { await handle.close(); }
      } catch { return { status: 'stale' }; }
    }
    const requiredBytes = Buffer.byteLength(serialized);
    if (requiredBytes > host.maxBytes) return { status: 'response_budget_too_small', requiredBytes, retryable: true };
    // A fresh parse prevents consumer-side decorations from corrupting a replay.
    return result;
  }
  function close() {
    closed = true;
    responses.clear();
    return Promise.all([...tickets].map(([key, ticket]) => retire(key, ticket)));
  }
 // One boundary for direct and budgeted consumers; source tickets are never
 // repaired, and unknown fields cannot disappear during projection below.
 function argumentsFor(kind,args={}){
   const optional=kind==='search'?['query','provider','cursor','limit']:['cursor','maxBytes'];
   if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!optional.includes(key)&&!(kind==='read'&&key==='source')))throw Object.assign(Error('历史工具包含未知参数'),{code:'INVALID_PAYLOAD'});
   const normalized={...args};
   for(const key of optional)if(normalized[key]===null||(['cursor','provider'].includes(key)&&normalized[key]===''))delete normalized[key];
   return normalized;
 }
  return {
    search: (args, host) => host === undefined ? search(argumentsFor('search',args)) : deliver('search', argumentsFor('search',args), host),
    read: (args, host) => host === undefined ? read(argumentsFor('read',args)) : deliver('read', argumentsFor('read',args), host),
    catalog,
    freeze: source => freeze(source, 'source'),
    freezeSelected: (source,{allowPreview=false}={}) => freeze(source, 'catalog-source',allowPreview),
    close,
  };
}
