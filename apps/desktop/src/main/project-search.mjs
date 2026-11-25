import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MATCHES = 1000;
const normalize = text => text.replace(/\r\n?/g, '\n');
const digest = text => createHash('sha256').update(text).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const check = signal => { if (signal?.aborted) throw fail('ABORT_ERR', '搜索已取消。'); };
const documents = /\.(pdf|docx|pptx|xlsx)$/i;
const unsupported = /\.(doc|ppt|xls|odt|ods|odp|rtf|epub)$/i;
const secret = /^(?:\.git|\.nozeli|\.ccb|\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.docker|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;

export function resolveSearchRipgrep() {
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) throw fail('SEARCH_RUNTIME', '当前平台没有捆绑搜索程序。');
  try {
    // Resolve the actual target package, never npm_config_arch, PATH or a user executable.
    return require.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`);
  } catch { throw fail('SEARCH_RUNTIME', '捆绑的 ripgrep 搜索程序缺失，请修复应用安装。'); }
}

function safeRel(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\0\r\n]/.test(value) || path.posix.isAbsolute(value)) return null;
  const rel = value.replace(/^\.\//, '');
  if (rel.split('/').some(p => !p || p === '.' || p === '..' || secret.test(p))) return null;
  return rel;
}
function environment() {
  const env = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  if (process.platform === 'win32') for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

// Streaming framing with backpressure. Both framing and diagnostics have bounds;
// a broken runtime is an error, not an empty successful search.
async function run(binary, args, { root, signal, input, delimiter = '\n', consume }) {
  check(signal);
  const child = spawn(binary, ['--no-config', ...args], { cwd: root, env: environment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', stopped = false, spawnError;
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, killed) => resolve({ code, killed }));
  });
  child.stderr.on('data', b => { stderr = (stderr + b.toString('utf8')).slice(0, 4096); });
  child.stdin.on('error', () => {}); // EPIPE after bounded termination is expected.
  child.stdin.end(input);
  let pending = Buffer.alloc(0);
  const separator = delimiter.charCodeAt(0);
  try {
    for await (const chunk of child.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0, end;
      while ((end = pending.indexOf(separator, start)) !== -1) {
        if (end - start > 32 * 1024 * 1024) throw fail('SEARCH_OUTPUT_LIMIT', '搜索输出行超过安全上限。');
        if (await consume(pending.subarray(start, end).toString('utf8')) === false) { stopped = true; child.kill(); break; }
        start = end + 1;
      }
      if (stopped) break;
      pending = pending.subarray(start);
      if (pending.length > 32 * 1024 * 1024) throw fail('SEARCH_OUTPUT_LIMIT', '搜索输出行超过安全上限。');
    }
    if (!stopped && pending.length) await consume(pending.toString('utf8'));
    const result = await closed;
    check(signal);
    if (spawnError) throw fail('SEARCH_RUNTIME', '无法启动捆绑搜索程序。');
    if (!stopped && result.code !== 0 && result.code !== 1) {
      const invalid = /regex parse error|regex syntax error|unclosed|invalid escape/i.test(stderr);
      throw fail(invalid ? 'SEARCH_REGEX' : 'SEARCH_FAILED', invalid ? '正则表达式无效。' : '搜索程序执行失败（文件权限、规则或运行环境异常）。');
    }
  } finally {
    child.kill();
    await closed;
    signal?.removeEventListener('abort', abort);
  }
}

async function locate(host, project, rel) {
  const located = await host.resolveFile(project, rel);
  if (located.missing || !located.abs) throw fail('SEARCH_MISSING', '文件已不存在。');
  let current = project.root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw fail('SEARCH_SYMLINK', '搜索不读取符号链接。');
  }
  const root = await fs.realpath(project.root), real = await fs.realpath(located.abs), relative = path.relative(root, real);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fail('SEARCH_ESCAPE', '文件已离开项目目录。');
  return located.abs;
}
async function assertNoDirtyDraft(host, projectId, relPath) {
  const draft = await host.readDraftRecord?.(projectId, relPath);
  if (draft?.draftError || draft && draft.status !== 'saved') throw fail('SEARCH_DIRTY_DRAFT', '此文件存在未保存或不可读取的恢复草稿；未搜索旧磁盘内容，请打开文件处理草稿后重试。');
}

async function readText(host, project, rel) {
  await assertNoDirtyDraft(host, project.id, rel);
  const abs = await locate(host, project, rel);
  const handle = await fs.open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw fail('SEARCH_SIZE', '文件超过 8 MiB 文本搜索上限或不是普通文件。');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const after = await handle.stat({ bigint: true });
    await locate(host, project, rel);
    const current = await fs.lstat(abs, { bigint: true });
    if (offset !== bytes.length || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(k => before[k] !== after[k] || after[k] !== current[k])) throw fail('SEARCH_CHANGED', '搜索期间文件已变化，请重新搜索。');
    await assertNoDirtyDraft(host, project.id, rel);
    if (bytes.includes(0)) throw fail('SEARCH_BINARY', '二进制文件不提供文本搜索。');
    try { return normalize(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw fail('SEARCH_ENCODING', '文件不是 UTF-8 文本，未搜索其内容。'); }
  } finally { await handle.close(); }
}
function matchArgs(options) {
  return [options.caseSensitive ? '--case-sensitive' : '--ignore-case', ...(options.regex ? [] : ['--fixed-strings']), ...(options.wholeWord ? ['--word-regexp'] : []), '--regexp', options.query];
}
function globs(value) { return value.split(/[\n,]/).map(s => s.trim()).filter(Boolean); }

export class ProjectSearchEngine {
  constructor({ host, readDocument }) { this.host = host; this.readDocument = readDocument; }

  async search({ projectId, query, mode = 'files', caseSensitive = false, regex = false, wholeWord = false, include = '', exclude = '', overlays = [], signal, onBatch = () => {} }) {
    if (typeof query !== 'string' || query.length > 256 || !query.trim() || !['files', 'content'].includes(mode) || typeof include !== 'string' || typeof exclude !== 'string' || include.length > 4096 || exclude.length > 4096 || [caseSensitive, regex, wholeWord].some(v => typeof v !== 'boolean')) throw fail('SEARCH_INPUT', '搜索参数无效（查询上限为 256 字符）。');
    check(signal);
    const binary = resolveSearchRipgrep(), project = await this.host.requireProject(projectId);
    const root = await fs.realpath(project.root), view = await this.host.navigationView?.(projectId, true);
    const hidden = view?.hidden ?? [], paths = [], issues = [];
    let issueOverflow = false, truncated = false, count = 0, batch = [];
    const issue = (relPath, message) => {
      if (issues.length < 100) issues.push({ ...(relPath ? { relPath } : {}), message: String(message).slice(0, 300) });
      else if (!issueOverflow) { issueOverflow = true; issues.push({ message: '其他文件也未能完成搜索；问题数量超过 100 条。' }); }
    };
    const visible = rel => !hidden.some(p => rel === p || rel.startsWith(p + '/')) || view?.showHidden === true;
    // rg prints platform separators (Windows: backslashes); force the
    // portable separator so discovery feeds safeRel a portable rel path.
    const args = ['--files', '--null', '--no-require-git', '--hidden', '--path-separator', '/', '--glob', '!**/node_modules/**'];
    for (const glob of globs(include)) args.push('--glob', glob);
    for (const glob of globs(exclude)) args.push('--glob', '!' + glob.replace(/^!/, ''));
    // Apply hard exclusions after user globs: they cannot be re-enabled.
    for (const name of ['.git', '.nozeli', '.ccb', '.env', '.env.*', '.ssh', '.aws', '.gnupg', '.docker', '.npmrc', '.netrc', '.pypirc', '.git-credentials', 'credentials*', 'secret*', '*.pem', '*.key', '*.p12', '*.pfx']) args.push('--glob', '!**/' + name, '--glob', '!**/' + name + '/**');
    const options = { query, caseSensitive, regex, wholeWord };
    // Validate regex even for an empty project and distinguish invalid/no results.
    await run(binary, [...matchArgs(options), '--json', '-'], { root, signal, input: '', consume: () => {} });
    await run(binary, [...args, '.'], { root, signal, delimiter: '\0', consume: value => { const rel = safeRel(value); if (rel && visible(rel)) paths.push(rel); } });
    const overlayMap = new Map();
    for (const overlay of overlays) { const rel = safeRel(overlay?.relPath); if (rel) overlayMap.set(rel, overlay); }
    const emit = async hit => {
      if (count === MAX_MATCHES) { truncated = true; return false; }
      count++; batch.push(hit);
      if (count === 1 || batch.length >= 50) { await onBatch(batch); batch = []; check(signal); }
      return true;
    };
    if (mode === 'files') {
      const matches = [];
      // NUL is used for discovery; filename matching uses JSON line records so
      // Unicode is handled by the same pinned engine as content matching.
      const byLine = paths.filter(p => !/[\r\n]/.test(p));
      await run(binary, [...matchArgs(options), '--json', '-'], { root, signal, input: byLine.join('\n'), consume: raw => {
        const event = JSON.parse(raw); if (event.type !== 'match') return;
        const rel = byLine[event.data.line_number - 1]; if (rel) matches.push(rel);
      } });
      const needle = caseSensitive ? query : query.toLowerCase();
      const rank = rel => { const name = path.posix.basename(caseSensitive ? rel : rel.toLowerCase()); return name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3; };
      matches.sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));
      for (const relPath of matches) {
        check(signal);
        try { await locate(this.host, project, relPath); } catch (error) { issue(relPath, error.message); continue; }
        if (!await emit({ relPath, kind: 'file' })) break;
      }
    } else {
      const textCandidates = [], extracted = [];
      for (const rel of paths) {
        check(signal);
        if (overlayMap.has(rel)) { extracted.push(rel); continue; }
        try { await assertNoDirtyDraft(this.host, projectId, rel); }
        catch (error) { issue(rel, error.message); continue; }
        if (documents.test(rel)) { extracted.push(rel); continue; }
        if (unsupported.test(rel)) { issue(rel, '该文档格式暂不支持内容搜索。'); continue; }
        textCandidates.push(rel);
      }
      const matched = new Set();
      // Bound each stdin prefilter group by bytes, not file count. Normalizing
      // before matching also preserves anchors for CRLF, CR and BOM sources.
      // Matched files are read again before publishing, so offsets/digest always
      // describe the same verified snapshot rather than the discovery version.
      let parts = [], ranges = [], groupBytes = 0, nextLine = 1;
      const filterGroup = async () => {
        if (!parts.length) return;
        let cursor = 0;
        await run(binary, [...matchArgs(options), '--json', '-'], { root, signal, input: parts.join(''), consume: raw => {
          const event = JSON.parse(raw); if (event.type !== 'match') return;
          const line = event.data.line_number;
          while (cursor + 1 < ranges.length && line >= ranges[cursor + 1].line) cursor++;
          matched.add(ranges[cursor].rel);
        } });
        parts = []; ranges = []; groupBytes = 0; nextLine = 1;
      };
      for (const rel of textCandidates) {
        check(signal);
        let text;
        try { text = await readText(this.host, project, rel); }
        catch (error) { issue(rel, error.message); continue; }
        const size = Buffer.byteLength(text) + 1;
        if (groupBytes + size > MAX_BYTES) await filterGroup();
        ranges.push({ line: nextLine, rel }); parts.push(text + '\n'); groupBytes += size;
        nextLine++;
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) nextLine++;
      }
      await filterGroup();
      for (const relPath of [...extracted.filter(rel => overlayMap.has(rel)), ...matched, ...extracted.filter(rel => !overlayMap.has(rel))]) {
        check(signal);
        let text, kind = 'text', source = 'disk', segments;
        try {
          const overlay = overlayMap.get(relPath);
          if (overlay) {
            if (overlay.blocked || typeof overlay.text !== 'string') { issue(relPath, overlay.reason || '当前未保存文档没有可搜索文本；未使用旧磁盘内容。'); continue; }
            await locate(this.host, project, relPath);
            text = normalize(overlay.text); kind = overlay.kind || 'text'; source = 'buffer'; segments = overlay.segments;
          } else if (documents.test(relPath)) {
            await locate(this.host, project, relPath);
            await assertNoDirtyDraft(this.host, projectId, relPath);
            let reader = this.readDocument;
            if (!reader) {
              if (process.versions.electron) throw fail('SEARCH_RUNTIME', 'Electron 内容搜索需要独立进程文档读取器。');
              reader = (await import('./search-document-text.mjs')).searchDocumentText;
            }
            const result = await reader({ host: this.host, projectId, relPath, signal });
            await assertNoDirtyDraft(this.host, projectId, relPath);
            text = normalize(result.text); kind = result.kind; segments = result.segments;
          } else text = await readText(this.host, project, relPath);
          if (Buffer.byteLength(text) > MAX_BYTES) { issue(relPath, '提取或缓冲文本超过 8 MiB 搜索上限。'); continue; }
          const textDigest = digest(text), bytes = Buffer.from(text);
          const lineStarts = [0];
          for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
          await run(binary, [...matchArgs(options), '--json', '-'], { root, signal, input: bytes, consume: async raw => {
            const event = JSON.parse(raw); if (event.type !== 'match') return;
            const data = event.data, lineBytes = data.lines.text !== undefined ? Buffer.from(data.lines.text) : Buffer.from(data.lines.bytes, 'base64');
            const lineStart = lineStarts[data.line_number - 1];
            let previousByte = 0, previousColumn = 0;
            for (const match of data.submatches) {
              const column = previousColumn + lineBytes.subarray(previousByte, match.start).toString('utf8').length;
              const matchText = lineBytes.subarray(match.start, match.end).toString('utf8');
              previousByte = match.end; previousColumn = column + matchText.length;
              const from = lineStart + column, to = from + matchText.length;
              if (matchText.length > 4096) { issue(relPath, '单个匹配超过 4096 字符，未返回该匹配。'); continue; }
              const segment = segments?.find(s => from >= s.from && from < s.to);
              const location = {};
              if (Number.isInteger(segment?.page)) location.page = segment.page;
              if (typeof segment?.sheetName === 'string') location.sheetName = segment.sheetName;
              if (Number.isInteger(segment?.row)) location.row = segment.row;
              if (Number.isInteger(segment?.column)) location.sheetColumn = segment.column;
              const previewStart = Math.max(lineStart, from - 100);
              if (!await emit({ relPath, kind, source, line: data.line_number, column: column + 1, from, to, preview: text.slice(previewStart, Math.min(lineStarts[data.line_number] === undefined ? text.length : lineStarts[data.line_number] - 1, from + 200)), matchText, digest: textDigest, ...location })) return false;
            }
          } });
        } catch (error) {
          if (signal?.aborted || ['SEARCH_RUNTIME', 'SEARCH_FAILED', 'SEARCH_REGEX', 'SEARCH_OUTPUT_LIMIT'].includes(error.code)) throw error;
          issue(relPath, error.message);
        }
        if (truncated) break;
      }
    }
    check(signal);
    if (batch.length) await onBatch(batch);
    return { truncated, issues };
  }
}
