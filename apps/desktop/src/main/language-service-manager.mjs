import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node';

const require = createRequire(import.meta.url);
const SERVER_ENTRY = require.resolve('typescript-language-server/lib/cli.mjs');
const SUPPORTED = /\.(?:[cm]?js|jsx|ts|tsx)$/i;
const MAX_TEXT = 8 * 1024 * 1024;

function lspPosition(text, line, column) {
  const lines = text.split('\n');
  const lineIndex = Math.max(0, Math.min(lines.length - 1, Number.isInteger(line) ? line : 0));
  const character = Math.max(0, Math.min(lines[lineIndex].length, Number.isInteger(column) ? column : 0));
  return { line: lineIndex, character };
}
function uriPath(uri, root) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  try {
    const file = decodeURIComponent(new URL(uri).pathname);
    const relative = path.relative(root, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : null;
  } catch { return null; }
}
function normalizeLocation(item, root) {
  if (!item || typeof item !== 'object') return item;
  const target = item.targetUri ? { ...item, uri: item.targetUri, range: item.targetSelectionRange || item.targetRange } : item;
  return target.uri ? { ...target, relPath: uriPath(target.uri, root) } : target;
}
function normalizeResponse(value, root) {
  if (Array.isArray(value)) return value.map(item => normalizeLocation(item, root));
  if (value?.items) return { ...value, items: value.items.map(item => normalizeLocation(item, root)) };
  if (value?.changes) return { ...value, changes: Object.fromEntries(Object.entries(value.changes).map(([uri, edits]) => [uri, { uri, relPath: uriPath(uri, root), edits }])) };
  return normalizeLocation(value, root);
}
function wordAt(text, line, character) {
  const value = text.split('\n')[line] || '';
  const match = /[A-Za-z_$][\w$]*/g;
  let item;
  while ((item = match.exec(value))) if (item.index <= character && item.index + item[0].length >= character) return { name: item[0], line, start: item.index, end: item.index + item[0].length };
  return null;
}

function protectChildStdin(stream) {
  if (!stream || stream.__nozeliSafeWrite) return stream;
  const write = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    let charset = encoding;
    let done = callback;
    if (typeof encoding === 'function') { done = encoding; charset = undefined; }
    const settled = typeof done === 'function' ? () => done() : undefined;
    try {
      return charset === undefined ? write(chunk, settled) : write(chunk, charset, settled);
    } catch {
      settled?.();
      return false;
    }
  };
  Object.defineProperty(stream, '__nozeliSafeWrite', { value: true });
  stream.on('error', () => {});
  return stream;
}

export class LanguageServiceManager {
  constructor({ host, userDataDir, onEvent = () => {}, spawnImpl = spawn } = {}) {
    this.host = host;
    this.userDataDir = path.resolve(userDataDir);
    this.onEvent = onEvent;
    this.spawnImpl = spawnImpl;
    this.session = null;
    this.projectId = null;
    this.sequence = 0;
  }

  async logPath(projectId) {
    const dir = path.join(await this.host.storage.localDirectory(projectId),'lsp');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${projectId}-${++this.sequence}.log`);
  }

  async start(projectId) {
    if (this.session?.projectId === projectId && this.session.ready) return this.session;
    await this.stop();
    const project = await this.host.requireProject(projectId);
    const logFile = await this.logPath(projectId);
    const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = this.spawnImpl(process.env.NOZELI_LSP_NODE || process.env.NODE || 'node', [SERVER_ENTRY, '--stdio'], {
      cwd: project.root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    protectChildStdin(child.stdin);
    child.stderr?.pipe(log);
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    const session = { projectId, root: project.root, child, connection, logFile, ready: false, documents: new Map(), versions: new Map() };
    this.session = session;
    // A provider can close stdin before queued JSON-RPC writes finish. Keep
    // that stream error from becoming an unhandled rejection and tear down
    // the connection before a later project restart can reuse it.
    child.stdin?.on('error', () => {});
    connection.onError(() => {});
    child.once('error', error => this.event({ projectId, type: 'exit', code: null, signal: null, message: error.message, logFile }));
    child.once('exit', (code, signal) => {
      if (this.session === session) {
        session.ready = false;
        this.event({ projectId, type: 'exit', code, signal, message: 'TypeScript language server exited.', logFile });
        this.session = null;
      }
      try { session.connection.dispose(); } catch {}
      log.end();
    });
    connection.onNotification('textDocument/publishDiagnostics', params => {
      if (params?.uri) this.event({ projectId, type: 'diagnostics', uri: params.uri, relPath: uriPath(params.uri, session.root), diagnostics: params.diagnostics || [] });
    });
    connection.listen();
    try {
      await connection.sendRequest('initialize', {
        processId: process.pid,
        clientInfo: { name: 'Nozeli', version: '0.1.0' },
        rootUri: pathToFileURL(project.root).href,
        workspaceFolders: [{ uri: pathToFileURL(project.root).href, name: project.name || path.basename(project.root) }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, willSave: false, didSave: false, willSaveWaitUntil: false },
            completion: { completionItem: { snippetSupport: false } },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: {}, references: {}, rename: {}, formatting: {}, publishDiagnostics: { relatedInformation: true },
          },
          workspace: { workspaceFolders: true },
        },
        initializationOptions: {},
      });
      connection.sendNotification('initialized', {});
      session.ready = true;
      this.event({ projectId, type: 'ready', cwd: project.root, logFile });
      return session;
    } catch (error) {
      await this.stop(session);
      throw Object.assign(new Error(`TypeScript language server initialization failed: ${error.message}`), { code: 'LSP_UNAVAILABLE', logFile });
    }
  }

  event(payload) { try { this.onEvent(payload); } catch {} }

  async document(session, projectId, relPath, text, version) {
    if (typeof relPath !== 'string' || !SUPPORTED.test(relPath)) throw Object.assign(new Error('Only TypeScript/JavaScript project files are supported by the P0 server.'), { code: 'LSP_UNSUPPORTED' });
    if (typeof text !== 'string' || text.length > MAX_TEXT) throw Object.assign(new Error('Document text is too large.'), { code: 'LSP_TEXT_LIMIT' });
    const project = await this.host.requireProject(projectId);
    const located = await this.host.resolveFile(project, relPath);
    if (located.missing || !located.abs) throw Object.assign(new Error('Project document does not exist.'), { code: 'NOT_A_FILE' });
    const uri = pathToFileURL(located.abs).href;
    const current = session.versions.get(uri);
    const nextVersion = Number.isInteger(version) ? version : (current || 0) + 1;
    if (!session.documents.has(uri)) {
      session.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: /\.tsx?$/i.test(relPath) ? 'typescript' : 'javascript', version: nextVersion, text } });
      session.documents.set(uri, relPath);
    } else if (current !== nextVersion || session._texts?.get(uri) !== text) {
      session.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: nextVersion }, contentChanges: [{ text }] });
    }
    session._texts ||= new Map(); session._texts.set(uri, text); session.versions.set(uri, nextVersion);
    return { uri, version: nextVersion, text };
  }

  async sync(input) {
    const session = await this.start(input.projectId);
    return this.document(session, input.projectId, input.relPath, input.text, input.version);
  }
  async importDefinition(projectId, relPath, text, line, character, result) {
    const locations = Array.isArray(result) ? result : result ? [result] : [];
    if (locations.some(item => item?.relPath && item.relPath !== relPath)) return result;
    const symbol = wordAt(text, line, character); if (!symbol) return result;
    const sourceLine = text.split('\n')[line] || '';
    const imported = /(?:import|export)[^'"`]*from\s*['"`]([^'"`]+)['"`]|require\s*\(\s*['"`]([^'"`]+)['"`]/.exec(sourceLine);
    const requestPath = imported?.[1] || imported?.[2];
    if (!requestPath?.startsWith('.')) return result;
    const project = await this.host.requireProject(projectId);
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), requestPath));
    const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx'].map(ext => base.endsWith(ext) ? null : base + ext), ...['.ts', '.tsx', '.js', '.jsx'].map(ext => `${base}/index${ext}`)].filter(Boolean);
    for (const candidate of candidates) {
      try {
        const located = await this.host.resolveFile(project, candidate); if (located.missing) continue;
        const file = await this.host.readFile(projectId, candidate); const pattern = new RegExp(`(?:export\\s+)?(?:function|class|const|let|var|interface|type)\\s+${symbol.name}\\b`); const match = pattern.exec(file.text);
        if (!match) continue;
        const before = file.text.slice(0, match.index); const startLine = before.split('\n').length - 1; const startCharacter = match.index - before.lastIndexOf('\n') - 1;
        return [{ uri: pathToFileURL(located.abs).href, relPath: candidate, range: { start: { line: startLine, character: startCharacter }, end: { line: startLine, character: startCharacter + symbol.name.length } } }];
      } catch {}
    }
    return result;
  }

  async request(input) {
    const session = await this.start(input.projectId);
    const document = await this.document(session, input.projectId, input.relPath, input.text, input.version);
    const position = lspPosition(input.text, input.line, input.column);
    const params = { textDocument: { uri: document.uri }, position };
    let result;
    switch (input.action) {
      case 'completion': result = await session.connection.sendRequest('textDocument/completion', { ...params, context: { triggerKind: 1 } }); break;
      case 'hover': result = await session.connection.sendRequest('textDocument/hover', params); break;
      case 'definition': result = await session.connection.sendRequest('textDocument/definition', params); break;
      case 'references': result = await session.connection.sendRequest('textDocument/references', { ...params, context: { includeDeclaration: true } }); break;
      case 'rename': result = await session.connection.sendRequest('textDocument/rename', { ...params, newName: input.newName }); break;
      case 'format': result = await session.connection.sendRequest('textDocument/formatting', { textDocument: { uri: document.uri }, options: input.options || { tabSize: 2, insertSpaces: true } }); break;
      default: throw Object.assign(new Error('Unknown LSP action.'), { code: 'INVALID_PAYLOAD' });
    }
    const normalized = normalizeResponse(result, session.root);
    return input.action === 'definition' ? this.importDefinition(input.projectId, input.relPath, input.text, input.line, input.column, normalized) : normalized;
  }

  async stop(expected = null) {
    const session = expected || this.session;
    if (!session) return;
    if (this.session === session) this.session = null;
    try { if (session.ready) await session.connection.sendRequest('shutdown'); } catch {}
    try { session.connection.sendNotification('exit'); } catch {}
    try { session.connection.dispose(); } catch {}
    try { session.child.kill(); } catch {}
    session.ready = false;
    this.event({ projectId: session.projectId, type: 'stopped', logFile: session.logFile });
  }

  async stopProject(projectId){if(this.session?.projectId===projectId)await this.stop(this.session);}
  async stopAll() { await this.stop(); }
  status() { return this.session ? { projectId: this.session.projectId, ready: this.session.ready, logFile: this.session.logFile, cwd: this.session.root } : { ready: false }; }
}

export { uriPath };
