// Point-anchor regression: host-level stale guards and domain point/selection
// semantics for the 2026-10-26 right-click 在此备注/在此讨论 contract.
// Covers: the four point kinds validate and persist version-bound anchors;
// malformed anchors are rejected; material provenance / cross-file / wrong-kind
// mismatches refuse instead of rebinding; edits resolve text points honestly
// (ambiguous at-point insertion stays unresolved, never guessed); point kinds
// carry NO quote and NO fabricated screenshot; tag.material keeps
// locationVerified false for points with the explicit reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DesktopHost } from '../src/main/host.mjs';
import { resolveTextPointAnchor, anchorText } from '../src/domain/tag-anchors.mjs';

const fixtures = path.resolve(import.meta.dirname, 'fixtures');
const code = async name => fs.readFile(path.join(fixtures, name));

async function boot(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-point-guards-'));
  const project = path.join(root, 'project'); await fs.mkdir(project, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(project, name), bytes);
  const host = new DesktopHost(path.join(root, 'profile'));
  const id = (await host.pick(project)).project.id;
  t.after(async () => { await host.storage.db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { host, id, root, project };
}
const rejects = async (promise, codeMatch, label) => {
  try { await promise; } catch (error) { assert.match(error.code || '', codeMatch, label + ': ' + error.message); return error; }
  throw Error(label + ' should have been rejected');
};


test('an EMPTY document is still a document: offset 0 is a valid version-bound point',async t=>{
  const { host, id } = await boot(t, { 'empty.txt': Buffer.from('', 'utf8') });
  const source = await host.readFile(id, 'empty.txt');
  assert.equal(source.digest, createHash('sha256').update('').digest('hex'), 'empty material digest');
  const { annotation } = await host.addAnnotation(id, { relPath: 'empty.txt', kind: 'text-point', anchor: { start: 0, end: 0, quote: '' }, materialDigest: source.digest, note: 'empty doc point' });
  assert.deepEqual(annotation.anchor, { start: 0, end: 0, quote: '' }, 'offset 0 zero-length anchor persists on the empty document');
  const listed = (await host.listAnnotations(id, 'empty.txt')).annotations.find(item => item.id === annotation.id);
  assert.equal(listed.resolution.locationStatus, 'exact', 'empty-document point resolves exactly');
  assert.equal(listed.sourceChanged, false);
  const location = annotation.information?.location;
  assert.equal(location?.label, '第 1 行第 1 列位置', 'host labels the empty-document position');
  assert(!location?.context?.quote, 'no fabricated quote');
  assert(!(annotation.information?.assets || []).some(asset => String(asset.role || '').includes('screenshot')), 'no screenshot asset');
  // Typing into the empty doc maps the point honestly (recorded affinity).
  const { mapTextPointAnchor, textChangeSet } = await import('../src/domain/tag-anchors.mjs');
  const typed = mapTextPointAnchor({ start: 0, end: 0, quote: '' }, '', 'hello', textChangeSet('', 'hello'));
  assert.equal(typed.locationStatus, 'exact', 'insertion at the empty-document point maps exactly');
});
test('text points resolve honestly: shifts map deterministically, replacements orphan, nothing is guessed from quotes', () => {
  const before = 'alpha beta gamma', offset = 'alpha '.length, point = { start: offset, end: offset, quote: '' };
  const leading = resolveTextPointAnchor(point, before, 'prefix ' + before);
  assert.equal(leading.locationStatus, 'exact', 'insertion before the point shifts it');
  assert.equal(leading.anchor.start, offset + 'prefix '.length);
  assert.equal(resolveTextPointAnchor(point, before, before).locationStatus, 'exact', 'unchanged material stays exact');
  // An EXTERNAL diff inserting exactly at the point carries no affinity
  // evidence: the point stays pending (point-ambiguous), never guesses a side.
  const atPoint = resolveTextPointAnchor(point, before, before.slice(0, offset) + 'INSERTED ' + before.slice(offset));
  assert.equal(atPoint.anchor, null, 'external at-point insertion leaves the anchor pending');
  assert.equal(atPoint.method, 'point-ambiguous');
  const midWord = { start: 'alpha be'.length, end: 'alpha be'.length, quote: '' };
  const replaced = resolveTextPointAnchor(midWord, before, 'alpha REPLACED gamma');
  assert.equal(replaced.anchor, null, 'replacement strictly containing the point never rebinds');
  assert.equal(replaced.locationStatus, 'orphaned');
  assert.equal(replaced.locationStatus, 'orphaned');
  assert.equal(resolveTextPointAnchor(midWord, before, 'alpha gamma').locationStatus, 'orphaned', 'deletion strictly containing the point orphans it');
  assert.notEqual(leading.method, 'unique-quote', 'points never fall back to quote guessing');
});

test('the four point kinds persist normalized version-bound anchors without quotes or screenshots', async t => {
  const text = '第一行位置文字\nsecond line for point\n';
  const { host, id } = await boot(t, {
    'note.txt': Buffer.from(text, 'utf8'),
    'sample.pdf': await code('pdf/nozeli-sample.zh.pdf'),
    'pipeline.png': await code('tex/pipeline.png'),
    'slides.pptx': await code('ppt/compatibility.pptx'),
  });
  const sources = {};
  for (const rel of ['note.txt', 'sample.pdf', 'pipeline.png', 'slides.pptx']) sources[rel] = await host.readFile(id, rel);
  // ppt-* annotation packages build from the CURRENT pptist draft snapshot
  // (the record the app's PPT viewer maintains); seed it for this digest.
  {const {createHash}=await import('node:crypto');const digest=sources['slides.pptx'].digest;await host.storage.putRecovery(id,'ppt:'+createHash('sha256').update('slides.pptx\0'+digest).digest('hex'),{schema:'nozeli-pptist-draft-v1',engine:'pptist',sourceDigest:digest,model:{slides:[{id:'slide-1',elements:[]}],theme:{},viewportSize:1000,viewportRatio:0.5625,title:'guards fixture'}});}
  const cases = [
    { relPath: 'note.txt', kind: 'text-point', anchor: { start: 4, end: 4, quote: '' } },
    { relPath: 'sample.pdf', kind: 'pdf-point', anchor: { page: 1, rotation: 0, space: 'rendered-page-normalized', x: 0.42, y: 0.6 } },
    { relPath: 'pipeline.png', kind: 'image-point', anchor: { space: 'image-normalized', width: 720, height: 300, x: 0.3, y: 0.7 } },
    { relPath: 'slides.pptx', kind: 'ppt-point', anchor: { space: 'pptx-slide-normalized', slideId: 'slide-1', layout: 'layout-signature-1', x: 0.5, y: 0.5 } },
  ];
  const created = [];
  for (const input of cases) {
    const { annotation } = await host.addAnnotation(id, { ...input, materialDigest: sources[input.relPath].digest, note: '位置备注 ' + input.kind });
    created.push(annotation);
    assert.deepEqual(annotation.anchor, input.anchor, input.kind + ' stores the exact normalized anchor');
    assert(!annotation.anchor.quote, input.kind + ' carries no quote');
    const assets = annotation.information?.assets || [];
    assert(!assets.some(asset => String(asset.role || '').includes('screenshot')), input.kind + ' never fabricates a screenshot attachment');
    const context = annotation.information?.location?.context;
    assert(!context || !context.quote, input.kind + ' context has no fake quote');
    if (input.kind === 'text-point') {
      assert(context && typeof context.before === 'string' && typeof context.after === 'string', 'text-point context provides accurate nearby text');
      assert(context.before.endsWith(text.slice(0, 4)), 'nearby context is computed from the frozen material');
    }
  }
  // tag.material (the real host material handoff) keeps points non-verifiable
  // as object mappings and never claims a quote-backed location.
  for (const annotation of created) {
    const material = await host.tagMaterial(id, { relPath: annotation.relPath, annotationId: annotation.id });
    assert.equal(material.kind, annotation.kind);
    assert.equal(material.execution.locationVerified, false, 'point kinds stay locationVerified=false');
    assert(material.execution.reasons.some(reason => reason.includes('位置点') || reason.includes('上下文')), 'the explicit point reason is present');
    assert(!material.information?.location?.context?.quote, 'material handoff exposes no fabricated quote');
  }
});

test('malformed point anchors are rejected instead of normalized into guesses', async t => {
  const { host, id } = await boot(t, {
    'note.txt': Buffer.from('plain text file\n', 'utf8'),
    'sample.pdf': await code('pdf/nozeli-sample.zh.pdf'),
    'pipeline.png': await code('tex/pipeline.png'),
    'slides.pptx': await code('ppt/compatibility.pptx'),
  });
  const digest = {};
  for (const rel of ['note.txt', 'sample.pdf', 'pipeline.png', 'slides.pptx']) digest[rel] = (await host.readFile(id, rel)).digest;
  const attempt = (relPath, kind, anchor) => host.addAnnotation(id, { relPath, kind, anchor, materialDigest: digest[relPath], note: 'x' });
  await rejects(attempt('note.txt', 'text-point', { start: 2, end: 5, quote: '' }), /INVALID_ANCHOR/, 'non-zero-length text point');
  await rejects(attempt('note.txt', 'text-point', { start: 2, end: 2, quote: 'quoted' }), /INVALID_ANCHOR/, 'text point must not smuggle a quote');
  await rejects(attempt('note.txt', 'text-point', { start: 2, end: 2, quote: '', extra: 1 }), /INVALID_ANCHOR/, 'unknown text point fields');
  await rejects(attempt('sample.pdf', 'pdf-point', { page: 1, rotation: 0, space: 'rendered-page-normalized', x: 1.5, y: 0.5 }), /INVALID_ANCHOR/, 'out-of-range normalized x');
  await rejects(attempt('sample.pdf', 'pdf-point', { page: 0, rotation: 0, space: 'rendered-page-normalized', x: 0.5, y: 0.5 }), /INVALID_ANCHOR/, 'page zero');
  await rejects(attempt('sample.pdf', 'pdf-point', { page: 1, rotation: 0, space: 'pixel-space', x: 0.5, y: 0.5 }), /INVALID_ANCHOR/, 'wrong coordinate space');
  await rejects(attempt('pipeline.png', 'image-point', { space: 'image-normalized', width: 999, height: 300, x: 0.5, y: 0.5 }), /ANCHOR_MISMATCH/, 'image identity dimensions must match the frozen original');
  await rejects(attempt('slides.pptx', 'ppt-point', { space: 'pptx-slide-normalized', layout: 'layout', x: -0.1, y: 0.5 }), /INVALID_ANCHOR/, 'negative ppt coordinate');
  await rejects(attempt('slides.pptx', 'ppt-point', { space: 'pptx-slide-normalized', slideId: 's', layout: 'l', x: 0.5, y: 1.2 }), /INVALID_ANCHOR/, 'ppt y beyond 1');
  // Wrong-kind routes: the point must belong to the format it claims.
  await rejects(attempt('note.txt', 'pdf-point', { page: 1, rotation: 0, space: 'rendered-page-normalized', x: 0.5, y: 0.5 }), /ANCHOR_MISMATCH/, 'pdf point on a text file');
  await rejects(attempt('sample.pdf', 'text-point', { start: 1, end: 1, quote: '' }), /ANCHOR_MISMATCH/, 'text point on a PDF');
});

test('stale material never rebinds: provenance, cross-file and cross-project guards', async t => {
  const { host, id } = await boot(t, {
    'a.txt': Buffer.from('alpha file material\n', 'utf8'),
    'b.txt': Buffer.from('beta file material\n', 'utf8'),
  });
  const a = await host.readFile(id, 'a.txt'), b = await host.readFile(id, 'b.txt');
  await rejects(host.addAnnotation(id, { relPath: 'b.txt', kind: 'text-point', anchor: { start: 2, end: 2, quote: '' }, materialDigest: a.digest, note: 'x' }), /ANCHOR_MISMATCH/, "a's frozen material cannot anchor b");
  await rejects(host.addAnnotation(id, { relPath: 'a.txt', kind: 'text-point', anchor: { start: 2, end: 2, quote: '' }, materialDigest: 'f'.repeat(64), note: 'x' }), /MATERIAL_MISSING|ANCHOR_MISMATCH|INVALID_/, 'unknown digest is refused without creating an annotation');
  const { annotation } = await host.addAnnotation(id, { relPath: 'a.txt', kind: 'text-point', anchor: { start: 2, end: 2, quote: '' }, materialDigest: a.digest, note: 'origin' });
  // updateAnnotation re-validates the digest identity: a stale/foreign digest is refused.
  await rejects(host.updateAnnotation(id, annotation.id, { relPath: 'a.txt', materialDigest: b.digest, note: 'hijack', expectedUpdatedAt: annotation.updatedAt }), /ANCHOR_MISMATCH/, 'update cannot swap the frozen material');
  // A second project must not see or resolve the first project's point.
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-point-other-'));
  await fs.writeFile(path.join(otherRoot, 'a.txt'), 'alpha file material\n');
  const other = new DesktopHost(path.join(otherRoot, 'profile'));
  const otherId = (await other.pick(otherRoot)).project.id;
  try {
    assert.equal((await other.listAnnotations(otherId, 'a.txt')).annotations.length, 0, 'cross-project isolation');
  } finally { await other.storage.db.close(); await fs.rm(otherRoot, { recursive: true, force: true }); }
});

test('edited sources resolve through the point contract, and ambiguous edits surface 待定位 rather than guesses', async t => {
  const text = 'keep this line intact\nsecond line follows\n';
  const { host, id, project } = await boot(t, { 'edit.txt': Buffer.from(text, 'utf8') });
  const source = await host.readFile(id, 'edit.txt');
  const offset = text.indexOf('intact') + 3;
  const { annotation } = await host.addAnnotation(id, { relPath: 'edit.txt', kind: 'text-point', anchor: { start: offset, end: offset, quote: '' }, materialDigest: source.digest, note: 'point' });
  let listed = (await host.listAnnotations(id, 'edit.txt')).annotations.find(item => item.id === annotation.id);
  assert.equal(listed.resolution.locationStatus, 'exact', 'unmodified source resolves exactly');
  assert.equal(listed.sourceChanged, false);
  // Insert BEFORE the point: honest exact shift.
  await fs.writeFile(path.join(project, 'edit.txt'), 'new leading line\n' + text);
  listed = (await host.listAnnotations(id, 'edit.txt')).annotations.find(item => item.id === annotation.id);
  assert.equal(listed.sourceChanged, true, 'edit marks the source changed');
  const shifted = listed.resolution;
  assert(shifted.locationStatus === 'exact' || shifted.locationStatus === 'estimated', 'mapped resolution is honest, not missing');
  // An edit REPLACING the content the point sits inside (diff strictly
  // contains the offset) must orphan the point to 待定位 — never rebind into
  // content that merely looks similar.
  await fs.writeFile(path.join(project, 'edit.txt'), text.slice(0, text.indexOf('intact')) + 'REPLACED-SEGMENT' + text.slice(text.indexOf('intact') + 'intact'.length));
  listed = (await host.listAnnotations(id, 'edit.txt')).annotations.find(item => item.id === annotation.id);
  assert.notEqual(listed.resolution.locationStatus, 'exact', 'point inside a replaced span is not exact');
  assert(['orphaned', 'unresolved'].includes(listed.resolution.locationStatus), 'replaced span surfaces 待定位: ' + listed.resolution.locationStatus);
  // The material handoff refuses to claim a verified location for the stale point.
  const material = await host.tagMaterial(id, { relPath: 'edit.txt', annotationId: annotation.id });
  assert.equal(material.execution.locationVerified, false);
  assert(material.execution.reasons.some(reason => reason.includes('位置不确定') || reason.includes('版本已变化') || reason.includes('位置点')), 'stale point reasons are explicit');
});

test('anchorText normalization keeps point offsets LF-normalized before validation', () => {
  const crlf = 'one\r\ntwo\r\n', normalized = anchorText(crlf);
  assert.equal(normalized.indexOf('\r'), -1);
  const point = { start: 3, end: 3, quote: '' };
  const shifted = resolveTextPointAnchor(point, normalized, 'one\ntwo extra\n');
  assert.notEqual(shifted.method, 'invalid-source', 'CRLF material is normalized before point resolution');
});
