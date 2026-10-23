import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { renderArchifyDiagram, canonicalDiagramSpec } from '../src/agents/managed/archify-diagram.mjs';
import { prepareHtmlReport } from '../src/agents/managed/html-report.mjs';
import { checkRenderOutput } from '../src/agents/managed/archify-vendor/scripts/check-render-output.mjs';

const fixture = async type => JSON.parse(await readFile(new URL(`./fixtures/archify/${type}.json`, import.meta.url), 'utf8'));
const parse = svg => new DOMParser({ onError: error => { throw new Error(String(error)); } }).parseFromString(svg, 'image/svg+xml');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

for (const type of ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']) {
  test(`${type}: genuine geometry survives self-contained frozen report publication`, async () => {
    const spec = await fixture(type), before = structuredClone(spec);
    const result = await renderArchifyDiagram({ type, spec });
    const document = parse(result.svg), root = document.documentElement;
    assert.deepEqual(spec, before, 'rendering must not mutate author input');
    assert.equal(root.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(root.getAttribute('role'), 'img');
    assert.equal(root.getElementsByTagName('title')[0].textContent, spec.meta.title);
    assert.ok(root.getElementsByTagName('desc')[0].textContent.includes('→'), 'relationships have an accessible explanation');
    const viewBox = root.getAttribute('viewBox').split(/\s+/).map(Number);
    assert.ok(viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0);
    assert.ok(root.getElementsByTagName('marker').length >= 4, 'direction markers are retained');
    assert.ok(root.getElementsByTagName('pattern').length > 0, 'background grid definitions are retained');
    assert.equal(root.getElementsByTagName('script').length, 0);
    assert.equal(root.getElementsByTagName('foreignObject').length, 0);
    const rules = root.getElementsByTagName('style')[0].textContent;
    assert.match(rules, /\.c-backend\s*\{[^}]*fill:/, 'semantic fills must travel with standalone SVG');
    assert.match(rules, /prefers-color-scheme/);
    assert.match(rules, /@media print/);
    assert.equal(result.validation.ok, true);
    assert.equal(result.validation.visualReview, 'pending');
    assert.equal(result.specDigest, sha(result.specText));
    assert.deepEqual(JSON.parse(result.specText), spec);
    const frozen = await prepareHtmlReport('<!doctype html><html lang="en"><head><title>Diagram evidence</title></head><body><figure><img src="diagram.svg" alt="Relationship explanation"><figcaption>Observed relationships</figcaption></figure></body></html>', {
      readAsset: async rel => { assert.equal(rel, 'diagram.svg'); return { bytes: Buffer.from(result.svg), mediaType: 'image/svg+xml' }; },
    });
    assert.equal(frozen.manifest.assets.length, 1);
    assert.match(frozen.html, /data:image\/svg\+xml/);
    assert.match(result.svg, /Copyright \(c\) 2026 tt-a1i/);
    assert.match(result.svg, /Permission is hereby granted/);
  });
}

test('architecture coordinates and routes respond to spec rather than a static illustration', async () => {
  const spec = { schema_version: 1, diagram_type: 'architecture', meta: { title: 'Storage path', quality_profile: 'showcase' }, components: [
    { id: 'api', type: 'backend', label: 'API', pos: [40, 80], size: [120, 60] },
    { id: 'store', type: 'database', label: 'Store', pos: [380, 80], size: [120, 60] },
  ], connections: [{ from: 'api', to: 'store', label: 'write' }] };
  const first = await renderArchifyDiagram({ type: 'architecture', spec });
  spec.components[1].pos[0] = 600;
  const second = await renderArchifyDiagram({ type: 'architecture', spec });
  const box = svg => parse(svg).getElementById('node-store').getElementsByTagName('rect')[0];
  assert.notEqual(box(first.svg).getAttribute('x'), box(second.svg).getAttribute('x'));
  const routes = svg => Array.from(parse(svg).getElementsByTagName('path')).filter(node => /a-default/.test(node.getAttribute('class'))).map(node => node.getAttribute('d'));
  assert.notDeepEqual(routes(first.svg), routes(second.svg));
  assert.notEqual(first.specDigest, second.specDigest);
  assert.equal(first.generatorDigest, second.generatorDigest);
});

test('layout validation rejects overlapping nodes and unknown relationship endpoints', async () => {
  const spec = await fixture('architecture');
  spec.components[1].pos = [...spec.components[0].pos];
  await assert.rejects(renderArchifyDiagram({ type: 'architecture', spec }), /overlap|collid|clearance|cross/i);
  const unknown = await fixture('sequence'); unknown.messages[0].to = 'nonexistent';
  await assert.rejects(renderArchifyDiagram({ type: 'sequence', spec: unknown }), /unknown|not found|exist|participant/i);
});

test('schema and pure JSON admission reject unsafe/lossy values before rendering', async () => {
  await assert.rejects(renderArchifyDiagram({ type: 'unknown', spec: {} }), /Unsupported/);
  assert.throws(() => canonicalDiagramSpec({ n: NaN }), /finite JSON/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => canonicalDiagramSpec(cycle), /complexity/);
  const wrong = await fixture('workflow'); wrong.nodes[0].col = -1;
  await assert.rejects(renderArchifyDiagram({ type: 'workflow', spec: wrong }), /schema validation/);
  const remote = await fixture('architecture'); remote.components[0].brand = 'https://example.com';
  await assert.rejects(renderArchifyDiagram({ type: 'architecture', spec: remote }), /built-in|offline/i);
});

test('reentrant renders and canonical identity are independent of key insertion order', async () => {
  const spec = await fixture('architecture');
  const reordered = Object.fromEntries(Object.entries(spec).reverse());
  const [a, b] = await Promise.all([renderArchifyDiagram({ type: 'architecture', spec }), renderArchifyDiagram({ type: 'architecture', spec: reordered })]);
  assert.equal(a.specDigest, b.specDigest);
  assert.equal(a.svg, b.svg);
});

test('real render-output checker rejects a corrupted generated directed relationship', async () => {
  const rendered = await renderArchifyDiagram({ type: 'architecture', spec: await fixture('architecture') });
  assert.equal(checkRenderOutput(rendered.svg).ok, true);
  const document = parse(rendered.svg);
  const arrow = Array.from(document.getElementsByTagName('path')).find(node => node.hasAttribute('marker-end') && /\ba-default\b/.test(node.getAttribute('class')));
  assert.ok(arrow, 'exercise a genuine renderer-generated directed relationship, not a decorative path');
  arrow.setAttribute('d', 'M 10 10 L 200 200');
  const result = checkRenderOutput(new XMLSerializer().serializeToString(document.documentElement));
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.name === 'orthogonal_arrows').ok, false);
});

test('fixed vendor and adapter bytes match the shipped provenance manifest', async () => {
  const root = new URL('../src/agents/managed/archify-vendor/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('SOURCES.json', root), 'utf8'));
  for (const entry of manifest.files) assert.equal(sha(await readFile(new URL(entry.path, root))), entry.sha256, entry.path);
  const closure = manifest.files.filter(entry => entry.path !== 'generator-identity.mjs').map(entry => ({ path: entry.path, sha256: entry.sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.equal(sha(JSON.stringify(closure)), manifest.generatorDigest);
  assert.equal(manifest.version, '2.16.0-dev.0');
});
