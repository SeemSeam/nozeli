import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareHtmlReport, readHtmlReportText, HTML_REPORT_LIMITS, HTML_REPORT_OBJECT_MAX_BYTES } from '../src/agents/managed/html-report.mjs';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80" role="img" lang="en"><title>Architecture</title><desc>Reader connects to host</desc><defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="currentColor"/></marker></defs><style>:root{--ink:#234;color:var(--ink)}@media(prefers-color-scheme:dark){text{fill:#eee}}</style><rect x="1" y="1" width="118" height="78" rx="4" fill="none" stroke="currentColor"/><path d="M10 40 L100 40" marker-end="url(#arrow)" stroke="currentColor"/><text x="10" y="20" font-family="sans-serif">Reader → host</text></svg>';
const bytes = Buffer.from(svg);
const sha = value => createHash('sha256').update(value).digest('hex');

test('preserves a rich semantic report, readable CSS, SVG styles, and derives metadata', async () => {
  const result = await prepareHtmlReport(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Delivery &amp; evidence</title><style>:root{color-scheme:light dark;--measure:76ch}body{max-width:var(--measure);margin:0 auto;padding:clamp(1rem,3vw,2rem);font-family:system-ui}main > section{display:grid;gap:1rem}pre{overflow-x:auto;white-space:pre}table{border-collapse:collapse}@media print{details{display:block}}@media(max-width:40rem){table{display:block;overflow:auto}}</style></head><body><main><h1>Complete</h1><p>Actual <strong>frozen</strong> delivery &amp; evidence.</p><section><details open><summary>Verification</summary><pre><code>a &lt; b\n  indented</code></pre><table><caption>Results</caption><thead><tr><th scope="col">Status</th></tr></thead><tbody><tr><td>Passed</td></tr></tbody></table></details><figure>${svg}<figcaption>Static architecture</figcaption></figure></section></main></body></html>`);
  assert.equal(result.title, 'Delivery & evidence');
  assert.match(result.html, /a &lt; b\n  indented/);
  assert.match(result.html, /marker-end="url\(#arrow\)"/);
  assert.match(result.manifest.semanticText, /Actual frozen delivery & evidence/);
  assert.match(result.manifest.semanticText, /Reader → host/);
  assert.equal(readHtmlReportText(result.html), result.manifest.semanticText);
  assert.ok(Object.isFrozen(result.manifest));
  assert.ok(Object.isFrozen(result.manifest.assets));
});

test('re-publication ingests a previously baked host baseline and re-bakes fresh', async () => {
  const first = await prepareHtmlReport('<h1>结论</h1><p>原报告。</p>');
  const revised = await prepareHtmlReport(first.html.replace('<p>原报告。</p>', '<p>修订后的报告。</p>'));
  assert.match(revised.html, /修订后的报告。/);
  assert.equal(revised.html.split('id="nozeli-reader-style"').length - 1, 1, 'exactly one host baseline after rebake');
  await assert.rejects(prepareHtmlReport('<p id="nozeli-reader-style">spoof</p>'), /reserved host reader style id/);
});

test('host freezes verified resources, deduplicates reads and emits offline image data only', async () => {
  let reads = 0;
  const result = await prepareHtmlReport('<h1>Image</h1><img src="images/diagram.svg" alt="Diagram"><img src="images/diagram.svg" alt="Same diagram">', { readAsset: async path => { reads++; assert.equal(path, 'images/diagram.svg'); return { bytes, mediaType: 'image/svg+xml', digest: sha(bytes) }; } });
  assert.equal(reads, 1);
  assert.equal(result.manifest.assets.length, 1);
  assert.equal(result.manifest.assets[0].digest, sha(bytes));
  assert.match(result.html, /src="data:image\/svg\+xml;base64,/);
  assert.ok(!result.html.includes('src="images/'));
  assert.match(result.manifest.semanticText, /Diagram/);
});

test('reference manifest uses host copies and deterministic order, never author capabilities', async () => {
  const original = { kind: 'artifact', relPath: 'proof.txt', digest: 'abc', byteLength: 3, mediaType: 'text/plain', nested: { version: 1 } };
  const result = await prepareHtmlReport('<h1 id="top">Proof</h1><a href="proof.txt">Proof file</a><a href="https://example.org">External</a><a href="#top">Top</a>', { resolveReference: async href => { await new Promise(resolve => setTimeout(resolve, href.startsWith('http') ? 0 : 5)); return href.startsWith('http') ? { kind: 'external', url: href } : original; } });
  original.nested.version = 2;
  assert.deepEqual(result.manifest.references.map(ref => ref.id), ['0', '1']);
  assert.equal(result.manifest.references[0].nested.version, 1);
  assert.ok(Object.isFrozen(result.manifest.references[0].nested));
  assert.match(result.html, /href="nozeli-report-ref:0"/);
  assert.match(result.html, /href="#top"/);
});

const attacks = [
  '<script>alert(1)</script>', '<img src="x.png" onerror="alert(1)" alt="x">', '<iframe srcdoc="x"></iframe>', '<frame>', '<form><input></form>', '<base href="https://evil.test">', '<object data="x"></object>', '<embed src="x">', '<meta http-equiv="refresh" content="0;url=https://evil.test">', '<link rel="stylesheet" href="x.css">', '<a href="javascript:alert(1)">go</a>', '<a href="jav&#97;script:alert(1)">go</a>', '<a href="file:///etc/passwd">go</a>', '<a href="data:text/html,hello">go</a>', '<img src="data:image/svg+xml,evil" alt="x">', '<img src="../escape.png" alt="x">', '<img src="%2e%2e/escape.png" alt="x">', '<img src="a\\b.png" alt="x">', '<img src="/etc/passwd" alt="x">', '<img src="NUL.png" alt="x">', '<img src="a.png:secret" alt="x">', '<p onclick="x">x</p>', '<p id="x" ID="y">x</p>', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>x</p></foreignObject></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="x"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.test/x.svg#x"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://evil.test/x)"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><g id="x"><use href="#x"/></g></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><use href="#missing"/></svg>', '<math><mtext>x</mtext></math>', '<?danger x?><p>x</p>', '<p><b>unterminated</p>', '<!--><script>x</script>-->',
];
for (const attack of attacks) test(`rejects active/unsupported HTML: ${attack.slice(0, 75)}`, async () => {
  await assert.rejects(prepareHtmlReport(`<h1>Result</h1>${attack}`, { readAsset: async () => ({ bytes, mediaType: 'image/svg+xml' }), resolveReference: async () => ({ kind: 'external' }) }), /HTML report rejected/);
});
for (const style of ['@import "https://evil.test/x.css";', '@font-face{font-family:x;src:url(x.woff)}', 'p{background:url(https://evil.test/x)}', 'p{background:u\\72l(https://evil.test/x)}', 'p{--x:url(https://evil.test/x);background:var(--x)}', 'p{behavior:url(x)}', 'p{width:expression(alert(1))}', 'p{animation:spin 1s}', 'p{background:image-set("x.png" 1x)}', '@keyframes spin{from{opacity:0}to{opacity:1}}', 'p{color:red;unknown-dangerous-property:yes}', 'p{background:url("data:image/png;base64,AA==")}']) test(`rejects active/network CSS: ${style}`, async () => {
  await assert.rejects(prepareHtmlReport(`<h1>Result</h1><style>${style}</style>`), /HTML report rejected/);
});

test('resource failures never leak callback messages or publish fallback content', async () => {
  await assert.rejects(prepareHtmlReport('<p>Result</p><img src="missing.svg" alt="important">', { readAsset: async () => { throw new Error('/secret/runtime/file'); } }), error => error.message === 'HTML report rejected: local resource is unavailable');
  await assert.rejects(prepareHtmlReport('<p>Result</p><a href="missing.txt">Evidence</a>', { resolveReference: async () => { throw new Error('/secret/runtime/file'); } }), error => error.message === 'HTML report rejected: reference is unavailable');
});

test('MIME, extension, bytes, and supplied digest must agree', async () => {
  for (const [src, supplied] of [['x.svg', { bytes, mediaType: 'text/html' }], ['x.png', { bytes, mediaType: 'image/svg+xml' }], ['x.svg', { bytes, digest: 'wrong' }], ['x.svg', { bytes: Buffer.from('<svg>broken') }]]) {
    await assert.rejects(prepareHtmlReport(`<h1>Result</h1><img src="${src}" alt="x">`, { readAsset: async () => supplied }), /HTML report rejected/);
  }
});

test('body, CSS, nesting, pixel, and asset budgets fail closed', async () => {
  assert.equal(HTML_REPORT_OBJECT_MAX_BYTES, 64 * 1024 * 1024);
  await assert.rejects(prepareHtmlReport(`<p>${'x'.repeat(HTML_REPORT_LIMITS.bodyBytes)}</p>`), /body byte budget/);
  await assert.rejects(prepareHtmlReport('<div>'.repeat(150) + 'x' + '</div>'.repeat(150)), /complexity budget/);
  await assert.rejects(prepareHtmlReport(`<h1>x</h1><style>/*${'x'.repeat(HTML_REPORT_LIMITS.cssBytes)}*/</style>`), /CSS byte budget/);
  const huge = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"><rect width="10000" height="10000"/></svg>');
  await assert.rejects(prepareHtmlReport('<p>x</p><img src="huge.svg" alt="huge">', { readAsset: async () => ({ bytes: huge }) }), /pixel budget/);
  await assert.rejects(prepareHtmlReport('<p>x</p>' + Array.from({ length: 129 }, (_, i) => `<img src="${i}.svg" alt="${i}">`).join(''), { readAsset: async () => ({ bytes }) }), /asset count budget/);
  await assert.rejects(prepareHtmlReport('<p>x</p><img src="huge.svg" alt="huge">', { readAsset: async () => ({ bytes: Buffer.alloc(HTML_REPORT_LIMITS.assetBytes + 1) }) }), /resource byte budget/);
});

test('preserves copyright comments and rejects browser relocation ambiguities', async () => {
  const result = await prepareHtmlReport(`<!-- MIT Copyright contributors --><h1>Diagram</h1>${svg}`);
  assert.match(result.html, /<!-- MIT Copyright contributors -->/);
  for (const invalid of ['<table><p>lost position</p></table>', '<table>relocated text</table>', '<html><head><h1>Hidden in head</h1></head><body>x</body></html>', '<html><body>x</body></html><p>extra root</p>']) await assert.rejects(prepareHtmlReport(invalid), /HTML report rejected/);
});

test('resource total budget is independent of markup and final object budgets', async () => {
  const large = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--${'x'.repeat(7 * 1024 * 1024)}--><rect width="1" height="1"/></svg>`);
  const one = await prepareHtmlReport('<h1>Large image</h1><img src="large.svg" alt="large">', { readAsset: async () => ({ bytes: large }) });
  assert.ok(Buffer.byteLength(one.html) > HTML_REPORT_LIMITS.bodyBytes, 'valid embedded resource is not subject to source markup cap');
  await assert.rejects(prepareHtmlReport('<h1>Too many bytes</h1>' + Array.from({ length: 5 }, (_, index) => `<img src="${index}.svg" alt="large">`).join(''), { readAsset: async () => ({ bytes: large }) }), /resource byte budget/);
});

test('rejects abrupt HTML comment mutation and plain Markdown publication', async () => {
  for (const html of ['<h1>x</h1><!--><script>x</script>-->', '<h1>x</h1><!---><script>x</script>-->', '# Markdown report\n\nNot HTML', 'ordinary text']) await assert.rejects(prepareHtmlReport(html), /HTML report rejected/);
});

test('admits static SVG geometry CSS in SVG context without bypassing CSS validation', async () => {
  const result = await prepareHtmlReport('<h1>Diagram</h1><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><style>rect{rx:8px;ry:6px}circle{cx:20px;cy:20px;r:5px}</style><rect width="100" height="60"/></svg>');
  assert.match(result.html, /rx:8px;ry:6px/);
  await assert.rejects(prepareHtmlReport('<h1>x</h1><style>rect{rx:8px}</style>'), /unsupported CSS property rx/);
  await assert.rejects(prepareHtmlReport('<h1>x</h1><svg xmlns="http://www.w3.org/2000/svg"><style>rect{rx:url(https://evil.test/x)}</style></svg>'), /HTML report rejected/);
});

test('resource and reference failures retain typed host causes without exposing paths', async () => {
  const cause = Object.assign(new Error('/secret/runtime/provenance'), { code: 'REPORT_RESOURCE_NOT_DECLARED' });
  await assert.rejects(prepareHtmlReport('<h1>x</h1><img src="x.svg" alt="x">', { readAsset: async () => { throw cause; } }), error => error.name === 'HtmlReportValidationError' && error.code === 'HTML_REPORT_RESOURCE_UNAVAILABLE' && error.cause === cause && !error.message.includes('/secret'));
  await assert.rejects(prepareHtmlReport('<h1>x</h1><a href="x.txt">x</a>', { resolveReference: async () => { throw cause; } }), error => error.code === 'HTML_REPORT_REFERENCE_UNAVAILABLE' && error.cause === cause && !error.message.includes('/secret'));
});

test('preserves CSS escaped string tokens rather than injecting declarations', async () => {
  const source = String.raw`p::before{content:"safe\22 ; color: red; \22 tail";color:blue}`;
  const result = await prepareHtmlReport(`<h1>CSS tokens</h1><style>${source}</style>`);
  assert.ok(result.html.includes(source));
  const inline = String.raw`content:'safe\27 ; color:red; \27 tail';color:blue`;
  const inlineResult = await prepareHtmlReport(`<h1>CSS tokens</h1><p style="${inline}">Text</p>`);
  assert.match(inlineResult.html, /\\27 ; color:red; \\27 tail/);
});

test('SVG use expansion follows href over xlink:href regardless of attribute order', async () => {
  for (const attrs of ['href="#cycle" xlink:href="#safe"', 'xlink:href="#safe" href="#cycle"']) await assert.rejects(prepareHtmlReport(`<h1>x</h1><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g id="safe"/><g id="cycle"><use ${attrs}/></g></svg>`), /cyclic SVG reference/);
  const result = await prepareHtmlReport('<h1>x</h1><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g id="safe"/><g id="cycle"><use href="#safe" xlink:href="#cycle"/></g></svg>');
  assert.match(result.html, /href="#safe"/);
});

test('inline SVG identities obey document-global namespace including HTML nodes', async () => {
  await assert.rejects(prepareHtmlReport(`<h1 id="arrow">Collision</h1>${svg}`), /duplicate or empty document id/);
  await assert.rejects(prepareHtmlReport(`<h1>Repeated inline graph</h1>${svg}${svg}`), /duplicate or empty document id/);
  await assert.rejects(prepareHtmlReport('<h1 id="same">x</h1><p id="same">y</p>'), /duplicate or empty document id/);
});

test('CSS URL casing cannot escape the validated SVG-local fragment scope', async () => {
  const first = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="100" height="100" fill="url(#paint)"/></svg>';
  for (const source of ['<rect width="100" height="100" style="fill:URL(#paint)"/>', '<style>rect{fill:URL(#paint)}</style><rect width="100" height="100"/>', '<rect width="100" height="100" fill="UrL(#paint)"/>']) await assert.rejects(prepareHtmlReport(`<p>Independent diagrams</p>${first}<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${source}</svg>`), /missing SVG fragment reference/);
});
