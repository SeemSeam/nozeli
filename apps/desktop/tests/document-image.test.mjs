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
    assert.equal(rootRef.mime, 'image/png');
    const digest = rootRef.digest;
    const stored = await readFile(path.resolve(fx.root, rootRef.relRef));
    assert.equal(digestBytes(stored), digest);
    // Re-pasting identical content is idempotent: same file, never overwritten.
    const again = await fx.host.pasteDocumentImage(fx.projectId, { relPath: 'paper.md', bytes: realPng.toString('base64') });
    assert.equal(again.digest, digest);
    const nested = await fx.host.pasteDocumentImage(fx.projectId, { relPath: 'notes/deep/note.md', bytes: jpegBytes.toString('base64') });
    assert.equal(nested.mime, 'image/png');
    // A different image with the same visible name never collides: names are digests.
    assert.notEqual(nested.digest, digest);
    // Refs resolve back to the same bytes from both documents.
    for (const [relPath, ref, expected] of [['paper.md', rootRef.relRef, realPng], ['notes/deep/note.md', nested.relRef, jpegBytes]]) {
      const loaded = await fx.host.readDocumentImage(fx.projectId, { relPath, ref });
      assert.deepEqual(Buffer.from(loaded.bytes, 'base64'), expected);
    }
  } finally { await fx.cleanup(); }
});

test('paste rejects unknown documents, invalid or unsupported image data', async () => {
  const fx = await scratch();
  try {
    await seed(fx.root, 'paper.md', '# 标题\n');
    await assert.rejects(fx.host.pasteDocumentImage(fx.projectId, { relPath: 'missing.md', bytes: realPng.toString('base64') }), {code:'NOT_FOUND'});
    await assert.rejects(fx.host.pasteDocumentImage(fx.projectId, { relPath: 'paper.md', bytes: brokenBytes.toString('base64') }), {code:'INVALID_IMAGE'});
    await assert.rejects(fx.host.pasteDocumentImage(fx.projectId, { relPath: 'paper.md', bytes: '' }), {code:'INVALID_IMAGE'});
    const tooBig = Buffer.alloc(9 * 1024 * 1024);
    await assert.rejects(fx.host.pasteDocumentImage(fx.projectId, { relPath: 'paper.md', bytes: tooBig.toString('base64') }), {code:'INVALID_IMAGE'});
    // The failing pastes must leave no stray material files behind.
    const { readdir } = await import('node:fs/promises');
    const visible = (await readdir(fx.root, {recursive:true})).filter(rel=>rel.split(path.sep).every(part=>!part.startsWith('.')));
    assert.deepEqual(visible, ['paper.md']);
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
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: '../outside.png' }), {code:'INVALID_REF'});
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: '.nozeli/tags/secret.json' }), {code:'INVALID_REF'});
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: 'https://example.com/a.png' }), {code:'INVALID_REF'});
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: 'paper.md' }), {code:'UNSUPPORTED_IMAGE'});
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: 'missing.png' }), {code:'NOT_FOUND'});
    await assert.rejects(fx.host.readDocumentImage(fx.projectId, { relPath: 'paper.md', ref: '.nozeli/materials/' + '0'.repeat(64) }), {code:'INVALID_REF'});
    const retained = await fx.host.readDocumentImage(fx.projectId, {relPath:'paper.md',ref:pasted.relRef});
    assert.deepEqual(Buffer.from(retained.bytes,'base64'),realPng);
  } finally { await fx.cleanup(); }
});
