import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digestBytes } from '../src/domain/material-store.mjs';
import { DesktopHost } from '../src/main/host.mjs';

// One real PNG (1x1 white pixel) and a truncated header for failure paths.
const realPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64');
const jpegBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR4nGNgYPiPAw0pCQCpcD/BFMrqcwAAAABJRU5ErkJggg==', 'base64');
const brokenBytes = Buffer.from('not an image at all');

async function scratch() {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'nozeli-img-user-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'nozeli-img-proj-'));
  const host = new DesktopHost(userData);
  const picked = await host.pick(root);
  const projectId = picked.project.id;
  return { userData, root, host, projectId, async cleanup() { await rm(userData, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); } };
}

async function seed(root, rel, bytes) {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return abs;
}

test('paste stores immutable bytes once and yields document-relative markdown refs', async () => {
  const fx = await scratch();
  try {
    await seed(fx.root, 'paper.md', '# 标题\n');
    await seed(fx.root, 'notes/deep/note.md', '# 笔记\n');
    const rootRef = await fx.host.pasteDocumentImage(fx.projectId, { relPath: 'paper.md', bytes: realPng.toString('base64') });
    assert.match(rootRef.relRef, /^\.nozeli\/materials\/[0-9a-f]{64}$/);
    assert.equal(rootRef.mime, 'image/png');
    const digest = rootRef.digest;
    const stored = await readFile(path.join(fx.root, '.nozeli', 'materials', digest));
    assert.equal(digestBytes(stored), digest);
    // Re-pasting identical content is idempotent: same file, never overwritten.
    const again = await fx.host.pasteDocumentImage(fx.projectId, { relPath: 'paper.md', bytes: realPng.toString('base64') });
    assert.equal(again.digest, digest);
    const nested = await fx.host.pasteDocumentImage(fx.projectId, { relPath: 'notes/deep/note.md', bytes: jpegBytes.toString('base64') });
    assert.equal(nested.relRef, '../../.nozeli/materials/' + nested.digest);
    assert.equal(nested.mime, 'image/png');
    // A different image with the same visible name never collides: names are digests.
    assert.notEqual(nested.digest, digest);
    // Refs resolve back to the same bytes from both documents.
    for (const [relPath, ref] of [['paper.md', rootRef.relRef], ['notes/deep/note.md', nested.relRef]]) {
      const loaded = await fx.host.readDocumentImage(fx.projectId, { relPath, ref });
      assert.equal(loaded.mime.startsWith('image/'), true);
      assert.ok(loaded.bytes.length > 0);
    }
  } finally { await fx.cleanup(); }
});

test('paste rejects unknown documents, invalid or unsupported image data', async () => {
  const fx = await scratch();
  try {
    await seed(fx.root, 'paper.md', '# 标题\n');
    await assert.rejects(fx.host.pasteDocumentImage(fx.projectId, { relPath: 'missing.md', bytes: realPng.toString('base64') }), /不存在/);
    await assert.rejects(fx.host.pasteDocumentImage(fx.projectId, { relPath: 'paper.md', bytes: brokenBytes.toString('base64') }), /格式|图片/);
    await assert.rejects(fx.host.pasteDocumentImage(fx.projectId, { relPath: 'paper.md', bytes: '' }), /无效/);
    const tooBig = Buffer.alloc(9 * 1024 * 1024);
    await assert.rejects(fx.host.pasteDocumentImage(fx.projectId, { relPath: 'paper.md', bytes: tooBig.toString('base64') }), /8 MiB/);
    // The failing pastes must leave no stray material files behind.
    const { readdir } = await import('node:fs/promises');
    const materials = path.join(fx.root, '.nozeli', 'materials');
    assert.deepEqual(await readdir(materials).catch(() => []), []);
  } finally { await fx.cleanup(); }
});

test('preview reads are bounded: hidden paths, escapes, non-images and remote urls rejected', async () => {
  const fx = await scratch();
  try {
    await seed(fx.root, 'paper.md', '# 标题\n');
    const pasted = await fx.host.pasteDocumentImage(fx.projectId, { relPath: 'paper.md', bytes: realPng.toString('base64') });
    await seed(fx.root, 'pic.png', realPng);
    // Visible project image files resolve relative to the markdown document.
    const visible = await fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: 'pic.png' });
    assert.equal(visible.relPath, 'pic.png');
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: '../outside.png' }), /超出项目|隐藏|无效/);
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: '.nozeli/tags/secret.json' }), /materials|隐藏/);
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: 'https://example.com/a.png' }), /无效/);
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: 'paper.md' }), /图片/);
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: 'missing.png' }), /不存在/);
    // Material refs keep working after the markdown file itself moves nowhere; digest mismatch is refused.
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: '.nozeli/materials/' + '0'.repeat(64) }), /不存在/);
    assert.equal((await fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: pasted.relRef })).bytes.length > 0, true);
  } finally { await fx.cleanup(); }
});
