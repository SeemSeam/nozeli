import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProjectSearchEngine, resolveSearchRipgrep } from '../src/main/project-search.mjs';
import { dependencyIncluded } from '../tools/local-release.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const host = {
    async requireProject(id) { assert.equal(id, 'project'); return { id, root }; },
    async resolveFile(project, rel) {
      const abs = path.resolve(project.root, rel), relative = path.relative(root, abs);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('escaped');
      try { await fs.lstat(abs); return { abs, rel }; } catch (e) { if (e.code === 'ENOENT') return { abs, rel, missing: true }; throw e; }
    },
    async navigationView() { return { hidden: ['hidden'], showHidden: false }; },
  };
  const engine = new ProjectSearchEngine({ host });
  return {
    root, host, engine,
    async seed(rel, text) { const abs = path.join(root, rel); await fs.mkdir(path.dirname(abs), { recursive: true }); await fs.writeFile(abs, text); return abs; },
    async search(options) { const hits = []; const result = await engine.search({ projectId: 'project', query: '中', onBatch: batch => hits.push(...batch), ...options }); return { ...result, hits }; },
  };
}

test('bundled target resolver ignores user architecture and package pruning keeps only target', () => {
  const prior = process.env.npm_config_arch;
  process.env.npm_config_arch = 'untrusted';
  try { assert.match(resolveSearchRipgrep().split(path.sep).join('/'), new RegExp(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/rg`)); }
  finally { if (prior === undefined) delete process.env.npm_config_arch; else process.env.npm_config_arch = prior; }
  assert.equal(dependencyIncluded({}, '@vscode/ripgrep-linux-x64/bin/rg', { platform: 'linux', arch: 'x64' }), true);
  assert.equal(dependencyIncluded({}, '@vscode/ripgrep-win32-x64/bin/rg.exe', { platform: 'linux', arch: 'x64' }), false);
});

test('short Chinese filenames and content report LF UTF16 coordinates and normalized digest', async t => {
  const f = await fixture(t), text = '前言\r\n😀中文 中\r\n';
  await f.seed('目录/中文.md', text);
  assert.deepEqual((await f.search({ mode: 'files' })).hits.map(h => h.relPath), ['目录/中文.md']);
  const result = await f.search({ mode: 'content' });
  assert.equal(result.hits.length, 2);
  const hit = result.hits[0], normalized = text.replace(/\r\n?/g, '\n');
  assert.equal(hit.line, 2); assert.equal(hit.column, 3); assert.equal(hit.from, 5); assert.equal(hit.to, 6);
  assert.equal(hit.source, 'disk'); assert.equal(hit.kind, 'text'); assert.equal(hit.matchText, '中');
  assert.equal(hit.digest, createHash('sha256').update(normalized).digest('hex'));
});

test('filename discovery has no 10000 traversal ceiling', async t => {
  const f = await fixture(t);
  for (let start = 0; start < 10005; start += 100) await Promise.all(Array.from({ length: Math.min(100, 10005 - start) }, (_, j) => f.seed(`files/${String(start + j).padStart(5, '0')}.txt`, '')));
  await f.seed('zz-final/终点.md', '');
  const result = await f.search({ mode: 'files', query: '终' });
  assert.deepEqual(result.hits.map(h => h.relPath), ['zz-final/终点.md']);
  assert.equal(result.truncated, false);
});

test('live overlay suppresses old disk matches and shares Rust regex semantics', async t => {
  const f = await fixture(t);
  await f.seed('a.txt', 'old needle'); await f.seed('b.txt', 'old needle');
  const overlays = [{ relPath: 'a.txt', text: '😀 新内容 AA aa', kind: 'text' }, { relPath: 'b.txt', blocked: true, reason: '未保存文档不可提取' }];
  const old = await f.search({ mode: 'content', query: 'needle', overlays });
  assert.equal(old.hits.length, 0); assert.match(old.issues[0].message, /不可提取/);
  const fresh = await f.search({ mode: 'content', query: '新\\p{Han}+', regex: true, overlays });
  assert.equal(fresh.hits[0].source, 'buffer'); assert.equal(fresh.hits[0].matchText, '新内容'); assert.equal(fresh.hits[0].column, 4);
  assert.equal((await f.search({ mode: 'content', query: 'AA', caseSensitive: true, overlays })).hits.length, 1);
});

test('ignore rules work outside Git, include/exclude and hidden/internal/credential paths never leak', async t => {
  const f = await fixture(t);
  await f.seed('.gitignore', 'ignored/\n');
  for (const rel of ['ignored/a.txt', 'hidden/a.txt', '.git/a.txt', '.nozeli/a.txt', '.ccb/a.txt', '.env', 'credentials.json', 'safe.txt', 'drop.txt', 'nested/keep.md']) await f.seed(rel, 'needle');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-search-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'external.txt'), 'needle');
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(outside, 'external.txt'), path.join(f.root, 'external.txt'));
    await fs.symlink(path.join(f.root, 'safe.txt'), path.join(f.root, 'internal-link.txt'));
  }
  const result = await f.search({ mode: 'content', query: 'needle', include: '*.txt,*.md', exclude: 'drop.txt' });
  assert.deepEqual(result.hits.map(h => h.relPath).sort(), ['nested/keep.md', 'safe.txt']);
  f.host.navigationView = async () => ({ hidden: [], showHidden: true });
  const all = await f.search({ mode: 'files', query: 'credentials', include: '**/*' });
  assert.equal(all.hits.length, 0);
});

test('regex errors differ from successful empty results and unsupported extraction is explicit', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.search({ mode: 'content', query: 'absent' })).hits, []);
  await assert.rejects(f.search({ mode: 'content', query: '[', regex: true }), e => e.code === 'SEARCH_REGEX');
  await f.seed('legacy.doc', 'needle'); await f.seed('broken.docx', 'not a zip');
  const result = await f.search({ mode: 'content', query: 'needle' });
  assert.equal(result.hits.length, 0);
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.some(i => i.relPath === 'legacy.doc' && /不支持/.test(i.message)));
  assert.ok(result.issues.some(i => i.relPath === 'broken.docx'));
});

test('whole word Rust regex and explicit 1000 match truncation', async t => {
  const f = await fixture(t);
  await f.seed('words.txt', 'cat scatter CAT\n');
  assert.equal((await f.search({ mode: 'content', query: 'cat', wholeWord: true })).hits.length, 2);
  await f.seed('many.txt', 'needle\n'.repeat(1002));
  const result = await f.search({ mode: 'content', query: 'needle' });
  assert.equal(result.hits.length, 1000); assert.equal(result.truncated, true);
});

test('cancellation before and during streamed batches rejects and releases active child', async t => {
  const f = await fixture(t), already = new AbortController();
  already.abort();
  await assert.rejects(f.search({ mode: 'content', signal: already.signal }), e => e.code === 'ABORT_ERR');
  await f.seed('many.txt', 'needle\n'.repeat(2000));
  const controller = new AbortController(); let batches = 0;
  await assert.rejects(f.engine.search({ projectId: 'project', mode: 'content', query: 'needle', signal: controller.signal, onBatch() { batches++; controller.abort(); } }), e => e.code === 'ABORT_ERR');
  assert.equal(batches, 1);
  assert.equal((await f.search({ mode: 'files', query: 'many' })).hits.length, 1);
});

test('disk prefilter uses normalized LF and matches anchors after lone CR', async t => {
  const f = await fixture(t);
  await f.seed('mac-lines.txt', '\uFEFFfirst\rneedle\rlast');
  const result = await f.search({ mode: 'content', query: '^needle$', regex: true });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].line, 2);
  assert.equal(result.hits[0].from, 6);
  assert.equal(result.hits[0].matchText, 'needle');
});

test('injected document reader supplies matches and document location metadata', async t => {
  const f = await fixture(t);
  await f.seed('sheet.xlsx', 'fixture handled by injected reader');
  let calls = 0;
  const engine = new ProjectSearchEngine({ host: f.host, async readDocument(input) {
    calls++; assert.equal(input.projectId, 'project'); assert.equal(input.relPath, 'sheet.xlsx');
    return { text: '表一!B3\tneedle', kind: 'sheet', segments: [{ from: 0, to: 12, sheetName: '表一', row: 3, column: 2 }] };
  } });
  const hits = [];
  await engine.search({ projectId: 'project', query: 'needle', mode: 'content', onBatch: batch => hits.push(...batch) });
  assert.equal(calls, 1); assert.equal(hits.length, 1);
  assert.equal(hits[0].sheetName, '表一'); assert.equal(hits[0].row, 3); assert.equal(hits[0].sheetColumn, 2);
  assert.equal(hits[0].column, 7); assert.equal(hits[0].kind, 'sheet');
});

test('persisted dirty or unreadable drafts suppress stale disk; live overlays and saved records remain searchable', async t => {
  const f = await fixture(t);
  for (const rel of ['dirty.txt', 'broken.txt', 'saved.txt', 'overlay.txt', 'dirty.pdf']) await f.seed(rel, 'old needle');
  const drafts = new Map([
    ['dirty.txt', { status: 'dirty', text: 'changed' }], ['broken.txt', { draftError: 'unreadable' }],
    ['saved.txt', { status: 'saved', text: 'old needle' }], ['overlay.txt', { status: 'dirty', text: 'changed' }],
    ['dirty.pdf', { status: 'dirty' }],
  ]);
  f.host.readDraftRecord = async (_projectId, rel) => drafts.get(rel) ?? null;
  const result = await f.search({ query: 'needle', mode: 'content', overlays: [{ relPath: 'overlay.txt', kind: 'text', text: 'live needle' }] });
  assert.deepEqual(result.hits.map(h => h.relPath).sort(), ['overlay.txt', 'saved.txt']);
  assert.deepEqual(result.issues.map(i => i.relPath).sort(), ['broken.txt', 'dirty.pdf', 'dirty.txt']);
  assert.ok(result.issues.every(i => /草稿/.test(i.message)));
  assert.equal(result.hits.find(h => h.relPath === 'overlay.txt').source, 'buffer');
});
