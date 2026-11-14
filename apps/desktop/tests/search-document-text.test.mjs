import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {DesktopHost} from '../src/main/host.mjs';
import {wordText} from '../src/main/word-anchors.mjs';
import {searchDocumentText} from '../src/main/search-document-text.mjs';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const escape = value => value.replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[ch]));
const hash = text => createHash('sha256').update(text).digest('hex');
const relationships = entries => `<Relationships xmlns="${REL}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
async function packageBytes(main, contentType, entries) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${contentType}"/></Types>`);
  zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', main]]));
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({type:'nodebuffer', compression:'DEFLATE'});
}
const docx = (text = '标题😀\r\n第二段 needle') => packageBytes('word/document.xml', 'wordprocessingml.document.main+xml', {
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${text.split(/\r\n?|\n/).map(line => `<w:p><w:r><w:t xml:space="preserve">${escape(line)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
});
async function pptx(texts = ['Second file, first page 😀', 'First file, second page needle']) {
  // Physical filenames are deliberately the reverse of presentation order.
  return packageBytes('ppt/presentation.xml', 'presentationml.presentation.main+xml', {
    'ppt/presentation.xml': `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relationships([['rId1', 'slide', 'slides/slide1.xml'], ['rId2', 'slide', 'slides/slide2.xml']]),
    ...Object.fromEntries(texts.map((text, index) => [`ppt/slides/slide${2-index}.xml`, `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escape(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`])),
  });
}
async function xlsx() {
  return packageBytes('xl/workbook.xml', 'spreadsheetml.sheet.main+xml', {
    'xl/workbook.xml': `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml']]),
    'xl/sharedStrings.xml': `<sst xmlns="${S}" count="1" uniqueCount="1"><si><r><t>shared </t></r><r><t>needle😀</t></r></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+2</f><v>3</v></c></row><row r="2"><c r="C2" t="inlineStr"><is><t>inline&#13;&#10;next</t></is></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
  });
}
function pdf(texts = ['Page one needle', 'Page two needle']) {
  // A real generated PDF, including cross-reference offsets and embedded text
  // streams; no committed binary fixture and no parser mocks.
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const text of texts) {
    const pageId = objects.length, streamId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET` : '';
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${texts.length} >>`;
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(source));
    source += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(source);
}
async function fixture(t, filename, bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-search-document-'));
  const root = path.join(dir, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, filename), bytes);
  const host = new DesktopHost(path.join(dir, 'profile'));
  t.after(async () => { await host.storage.db.close(); await fs.rm(dir, {recursive:true, force:true}); });
  const {project} = await host.pick(root);
  return {host, projectId:project.id, relPath:filename, root};
}
function positions(result, needle) {
  const from = result.text.indexOf(needle);
  assert(from >= 0);
  assert.equal(result.text.slice(from, from + needle.length), needle);
  assert.equal(result.digest, hash(result.text));
  assert(!result.text.includes('\r'));
  return from;
}

test('DOCX extraction reuses Word anchor space, normalized UTF-16 and digest without source writes', async t => {
  const bytes = await docx();
  const f = await fixture(t, '中文.docx', bytes);
  const result = await searchDocumentText(f);
  assert.equal(result.kind, 'word');
  assert.equal(result.text, '标题😀\n第二段 needle');
  assert.equal(result.text, await wordText(bytes));
  assert.equal(positions(result, '第二段'), 5);
  assert.deepEqual(await fs.readFile(path.join(f.root, f.relPath)), bytes);
});

test('PDF actual text streams retain page segments and normalized digest', async t => {
  const f = await fixture(t, 'pages.pdf', pdf());
  const result = await searchDocumentText(f);
  assert.equal(result.kind, 'pdf');
  assert.equal(result.text, 'Page one needle\nPage two needle');
  const from = positions(result, 'Page two');
  assert.deepEqual(result.segments, [{from:0, to:15, page:1}, {from, to:result.text.length, page:2}]);
});

test('PPTX uses presentation relationship order, not lexical slide filenames', async t => {
  const f = await fixture(t, 'slides.pptx', await pptx());
  const result = await searchDocumentText(f);
  assert.equal(result.kind, 'ppt');
  assert.equal(result.text, 'Second file, first page 😀\nFirst file, second page needle');
  const from = positions(result, 'First file');
  assert.deepEqual(result.segments, [{from:0, to:from-1, page:1}, {from, to:result.text.length, page:2}]);
});

test('XLSX collects shared, inline, cached formula and boolean cells with worksheet coordinates', async t => {
  const f = await fixture(t, 'cells.xlsx', await xlsx());
  const result = await searchDocumentText(f);
  assert.equal(result.kind, 'sheet');
  assert.equal(result.text, '数据!A1\tshared needle😀\n数据!B1\t3\t=1+2\n数据!C2\tinline\nnext\nOther!A1\tTRUE');
  positions(result, 'needle😀');
  assert.deepEqual(result.segments.map(({sheetName, row, column}) => ({sheetName, row, column})), [
    {sheetName:'数据', row:1, column:1}, {sheetName:'数据', row:1, column:2},
    {sheetName:'数据', row:2, column:3}, {sheetName:'Other', row:1, column:1},
  ]);
  assert.equal(result.text.slice(result.segments[0].from, result.segments[0].to), '数据!A1\tshared needle😀');
});

for (const extension of ['docx', 'pptx', 'xlsx', 'pdf']) {
  test(`${extension}: corrupt input produces an explicit extraction error, not binary plaintext`, async t => {
    const f = await fixture(t, `broken.${extension}`, Buffer.from('not a document needle'));
    await assert.rejects(searchDocumentText(f), error => error.code === 'INVALID_DOCUMENT');
  });
}

test('blank PDF and textless Office packages explicitly report missing searchable text', async t => {
  for (const [name, bytes] of [['scan.pdf', pdf([''])], ['empty.docx', await docx('')], ['empty.pptx', await pptx(['', ''])]]) {
    const f = await fixture(t, name, bytes);
    await assert.rejects(searchDocumentText(f), error => error.code === 'NO_TEXT');
  }
});

test('cancellation, unsupported legacy Office, host path validation and input limits remain explicit', async t => {
  const f = await fixture(t, 'valid.docx', await docx());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchDocumentText({...f, signal:controller.signal}), error => error.code === 'ABORT_ERR');
  await fs.writeFile(path.join(f.root, 'legacy.doc'), 'legacy');
  await assert.rejects(searchDocumentText({...f, relPath:'legacy.doc'}), error => error.code === 'UNSUPPORTED');
  await assert.rejects(searchDocumentText({...f, relPath:'../outside.docx'}));
  await fs.symlink(path.join(f.root, 'valid.docx'), path.join(f.root, 'linked.docx'));
  await assert.rejects(searchDocumentText({...f, relPath:'linked.docx'}), error => error.code === 'SYMLINK');
  await fs.writeFile(path.join(f.root, 'large.pdf'), Buffer.alloc(32 * 1024 * 1024 + 1));
  await assert.rejects(searchDocumentText({...f, relPath:'large.pdf'}), error => error.code === 'TOO_LARGE');
});

test('malformed XML, entities and external package relationships are rejected', async t => {
  const examples = [];
  const word = await JSZip.loadAsync(await docx());
  word.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body></w:document>`);
  examples.push(['broken.docx', await word.generateAsync({type:'nodebuffer'})]);
  word.file('word/document.xml', `<!DOCTYPE document [<!ENTITY needle "EXPANDED">]><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&needle;</w:t></w:r></w:p></w:body></w:document>`);
  examples.push(['entity.docx', await word.generateAsync({type:'nodebuffer'})]);
  const slides = await JSZip.loadAsync(await pptx());
  slides.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="${REL}"><Relationship Id="rId2" Type="${R}/slide" Target="https://example.invalid/slide.xml" TargetMode="External"/></Relationships>`);
  examples.push(['external.pptx', await slides.generateAsync({type:'nodebuffer'})]);
  const sheet = await JSZip.loadAsync(await xlsx());
  sheet.file('xl/sharedStrings.xml', `<sst xmlns="${S}"><si><t>only one</t></si></sst>`);
  sheet.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="s"><v>99</v></c></row></sheetData></worksheet>`);
  examples.push(['index.xlsx', await sheet.generateAsync({type:'nodebuffer'})]);
  for (const [name, bytes] of examples) {
    const f = await fixture(t, name, bytes);
    await assert.rejects(searchDocumentText(f), error => error.code === 'INVALID_DOCUMENT');
  }
});

test('ZIP expansion and output caps reject documents without silently returning prefixes', async t => {
  const word = await JSZip.loadAsync(await docx());
  word.file('unused.bin', Buffer.alloc(128 * 1024 * 1024 + 1));
  const expanded = await fixture(t, 'expanded.docx', await word.generateAsync({type:'nodebuffer', compression:'DEFLATE'}));
  await assert.rejects(searchDocumentText(expanded), error => error.code === 'TOO_LARGE');
  const output = await fixture(t, 'output.docx', await docx('x'.repeat(8 * 1024 * 1024 + 1)));
  await assert.rejects(searchDocumentText(output), error => error.code === 'TOO_LARGE');
});

test('isolated standalone Node reader matches direct extraction for all generated formats', async t => {
  const {createSearchDocumentReader} = await import('../src/main/search-document-process.mjs');
  const readDocument = createSearchDocumentReader({command:process.execPath});
  for (const [name, bytes] of [['isolated.docx', await docx()], ['isolated.pdf', pdf()], ['isolated.pptx', await pptx()], ['isolated.xlsx', await xlsx()]]) {
    const f = await fixture(t, name, bytes);
    assert.deepEqual(await readDocument(f), await searchDocumentText(f));
    assert.deepEqual(await fs.readFile(path.join(f.root, f.relPath)), bytes);
  }
});

test('isolated reader propagates extraction errors without an in-process fallback', async t => {
  const {createSearchDocumentReader} = await import('../src/main/search-document-process.mjs');
  const readDocument = createSearchDocumentReader({command:process.execPath});
  const f = await fixture(t, 'corrupt.pdf', Buffer.from('not a document'));
  await assert.rejects(readDocument(f), error => error.code === 'INVALID_DOCUMENT');
});

test('isolated reader reports runtime crash, spawn failure, and malformed output explicitly', async t => {
  const {createSearchDocumentReader} = await import('../src/main/search-document-process.mjs');
  const f = await fixture(t, 'valid.docx', await docx());
  const crash = createSearchDocumentReader({command:process.execPath, args:['-e', 'process.exit(23)', '--']});
  await assert.rejects(crash(f), error => error.code === 'DOCUMENT_WORKER_FAILED');
  const malformed = createSearchDocumentReader({command:process.execPath, args:['-e', 'process.stdout.write("invalid protocol")', '--']});
  await assert.rejects(malformed(f), error => error.code === 'DOCUMENT_WORKER_FAILED');
  const missing = createSearchDocumentReader({command:path.join(f.root, 'missing-node')});
  await assert.rejects(missing(f), error => error.code === 'DOCUMENT_WORKER_FAILED');
});

test('isolated reader cancels a running runtime and settles after process closure', async t => {
  const {createSearchDocumentReader} = await import('../src/main/search-document-process.mjs');
  const f = await fixture(t, 'valid.docx', await docx());
  const controller = new AbortController();
  const readDocument = createSearchDocumentReader({command:process.execPath, args:['-e', 'setInterval(() => {}, 1000)', '--']});
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(readDocument({...f, signal:controller.signal}), error => error.code === 'ABORT_ERR');
  } finally { clearTimeout(timer); }
});
