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
const PROVIDERS = ['codex', 'claude', 'pi'];
const DEFAULTS = { files: 40, entries: 300, records: 600, bytes: 512 * 1024, lineBytes: 256 * 1024 };
const bounded = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
const version = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const textParts = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(p => ['text', 'input_text', 'output_text'].includes(p?.type) && typeof p.text === 'string').map(p => p.text).join('\n') : '';
function metadata(provider, row) {
  if (provider === 'codex' && row.type === 'session_meta') return { cwd: row.payload?.cwd, id: row.payload?.id };
  if (provider === 'pi' && row.type === 'session' && (row.version === undefined || [1, 2, 3].includes(row.version))) return { cwd: row.cwd, id: row.id };
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
  if (provider === 'pi' && row.type !== 'message') return [];
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
};
const omittedTypes = new Set(['system', 'credentials', 'credential', 'auth', 'authentication']);
const supportedParts = new Set(['text', 'input_text', 'output_text', 'image', 'image_url', 'input_image', 'output_image', 'tool_use', 'tool_result', 'toolCall', 'thinking', 'redacted_thinking']);
function unsupportedRecord(provider, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'unknown_envelope';
  if (omittedTypes.has(row.type)) return null;
  if (provider === 'pi' && row.type === 'session' && row.version !== undefined && ![1, 2, 3].includes(row.version)) return 'unsupported_session_version';
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
    if (provider === 'pi' && row.type !== 'message' || provider === 'claude' && !['user', 'assistant'].includes(row.type)) return 'unknown_envelope';
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
  return { files: 0, entries: 0, records: 0, bytes: 0, matchedProjects: 0, unconfirmed: 0, unsupported: [], errors: [], budgetExhausted: false, scope: 'exact-canonical-cwd', contentScope: 'text-only;system,credentials,and-known-nontext-excluded', exhaustive: false, traversalComplete: false };
}

export function createProviderHistoryReader({ projectRoot, projectIdentity = projectRoot, home = os.homedir(), providerRoots = {}, budgets = {}, ticketTtlMs = 15 * 60 * 1000, now = Date.now, fault } = {}) {
  if (!path.isAbsolute(projectRoot || '') || typeof projectIdentity !== 'string' || !projectIdentity) throw new Error('Host project identity and absolute projectRoot required');
  const root = path.resolve(projectRoot);
  const roots = { codex: path.join(home, '.codex', 'sessions'), claude: path.join(home, '.claude', 'projects'), pi: path.join(home, '.pi', 'agent', 'sessions'), ...providerRoots };
  const limits = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, bounded(budgets[k], v, v * 8)]));
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
  async function safeOpen(file, provider) {
    const base = path.resolve(roots[provider]);
    const relative = path.relative(base, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside_root');
    if (await realpath(base) !== base || await realpath(file) !== file) throw new Error('unconfirmed_path');
    return openHistoryFile(file, { fault });
  }
  const descriptor = s => ({
    provider: s.provider,
    sourcePath: path.relative(path.resolve(roots[s.provider]), s.file).split(path.sep).join('/'),
    sourceVersion: s.stamp,
    versionKind: 'filesystem-stat:dev,ino,size,mtimeMs,ctimeMs;not-a-content-digest',
  });
  const stream = (file, provider, stamp) => ({ file, provider, stamp, offset: 0, lineOrdinal: 0, pending: Buffer.alloc(0), dropping: false, eof: false, meta: null, incomplete: false });
  async function line(s, cov) {
    for (;;) {
      const newline = s.pending.indexOf(10);
      if (newline >= 0 || s.eof && s.pending.length) {
        const end = newline >= 0 ? newline : s.pending.length;
        const byteOffset = s.offset - s.pending.length;
        const lineOrdinal = ++s.lineOrdinal;
        const value = s.pending.subarray(0, end);
        s.pending = s.pending.subarray(newline >= 0 ? end + 1 : end);
        cov.records++;
        if (s.dropping || value.length > limits.lineBytes) { if(!s.dropping)cov.unsupported.push({ provider:s.provider,reason:'record_too_large' });s.dropping=false;s.incomplete=true;return { skipped:true }; }
        try { return { row: JSON.parse(value.toString('utf8')), byteOffset, lineOrdinal }; } catch { s.incomplete = true; cov.errors.push({ provider: s.provider, code: 'malformed_jsonl' }); return { skipped: true }; }
      }
      if (s.eof) return null;
      if (cov.bytes >= limits.bytes) return undefined;
      const handle = await safeOpen(s.file, s.provider);
      try {
        if (version(await handle.stat()) !== s.stamp) throw new Error('stale');
        const buffer = Buffer.alloc(Math.min(16384, limits.bytes - cov.bytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, s.offset);
        s.offset += bytesRead; cov.bytes += bytesRead;
        if (!bytesRead) s.eof = true;
        else s.pending = Buffer.concat([s.pending, buffer.subarray(0, bytesRead)]);
        if (s.pending.length > limits.lineBytes && s.pending.indexOf(10) < 0) {
          if(!s.dropping){s.incomplete=true;cov.unsupported.push({provider:s.provider,reason:'record_too_large'});}
          s.pending=Buffer.alloc(0);s.dropping=true;
        }
      } finally { await handle.close(); }
    }
  }
  async function nextFile(state, cov) {
    while (state.stack.length && cov.entries < limits.entries) {
      const frame = state.stack[state.stack.length - 1];
      if (!frame.handle) {
        let canonical;
        try { canonical = await realpath(frame.dir); } catch (error) { cov.errors.push({ provider: frame.provider, code: error.code || 'directory_error' }); state.stack.pop(); continue; }
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
        if (frame.depth < 5) state.stack.push({ dir: file, provider: frame.provider, depth: frame.depth + 1 });
        else cov.unsupported.push({ provider: frame.provider, reason: 'directory_depth_limit' });
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) return { file, provider: frame.provider };
    }
    return null;
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
    cov.budgetExhausted = hasMore && items.length < count;
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
      cov.exhaustive = !hasMore && !state.scan.incomplete; cov.budgetExhausted = hasMore;
      return { status: 'ok', descriptor: descriptor(src), provider: src.provider, sessionId: src.meta.id, records: result, hasMore, nextCursor: hasMore ? issue('read', state) : null, coverage: cov, untrusted: true };
    } catch (error) { cov.errors.push({ provider: src.provider, code: error.code || error.message }); return fail(error.message === 'stale' || ['ENOENT', 'SOURCE_CHANGED'].includes(error.code) ? 'stale' : error.code === 'IDENTITY_UNSUPPORTED' ? 'unsupported' : 'read_error'); }
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
  return {
    search: (args, host) => host === undefined ? search(args) : deliver('search', args, host),
    read: (args, host) => host === undefined ? read(args) : deliver('read', args, host),
    close,
  };
}
