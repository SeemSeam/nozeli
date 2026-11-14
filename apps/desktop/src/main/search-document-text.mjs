import {createHash} from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import {DOMParser} from '@xmldom/xmldom';
import {wordText} from './word-anchors.mjs';
import {validateWord} from './word-package.mjs';
import {validateSheet} from './sheet-package.mjs';

// Search is read-only and deliberately bounded: no OCR, formula evaluation,
// layout rendering, external relationships, or conversion of legacy Office files.
const INPUT_LIMIT = 32 * 1024 * 1024;
const XML_LIMIT = 16 * 1024 * 1024;
const TEXT_LIMIT = 8 * 1024 * 1024; // UTF-16 code units, including location labels.
const PAGE_LIMIT = 2000;
const CELL_LIMIT = 100000;
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const check = signal => { if (signal?.aborted) fail('ABORT_ERR', '文档搜索已取消。'); };
const normalize = text => text.replace(/\r\n?/g, '\n');
const elements = (node, ns, name) => Array.from(node.getElementsByTagNameNS(ns, name));

function collector() {
  const chunks = [], segments = [];
  let size = 0, hasText = false;
  return {
    add(value, location) {
      const text = normalize(value);
      if (size + text.length + (chunks.length ? 1 : 0) > TEXT_LIMIT) fail('TOO_LARGE', '文档提取文字超过 8 Mi UTF-16 搜索限制，未返回截断正文。');
      if (chunks.length) size++;
      const from = size;
      chunks.push(text);
      size += text.length;
      hasText ||= Boolean(text.trim());
      if (location !== undefined) segments.push({from, to: size, ...(typeof location === 'number' ? {page: location} : location)});
    },
    result(kind) {
      if (!hasText) fail('NO_TEXT', '文档没有可提取文字（扫描件需 OCR，当前不支持）。');
      const text = chunks.join('\n');
      return {text, kind, digest: createHash('sha256').update(text).digest('hex'), ...(segments.length ? {segments} : {})};
    },
  };
}

async function zipPackage(bytes, kind) {
  // Match the host import validators; the search expansion cap is stricter for PPTX.
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) fail('INVALID_DOCUMENT', 'Office 文件不是有效的 ZIP 包。');
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(file => !file.dir);
  if (files.length > 10000 || files.reduce((sum, file) => sum + (file._data?.uncompressedSize || 0), 0) > 128 * 1024 * 1024) fail('TOO_LARGE', 'Office 解压尺寸超过搜索安全限制（10000 项 / 128 MiB）。');
  if (!zip.file('[Content_Types].xml')) fail('INVALID_DOCUMENT', 'Office 包缺少内容类型。');
  if (files.some(file => /\.xml$/i.test(file.name) && (file._data?.uncompressedSize || 0) > XML_LIMIT)) fail('TOO_LARGE', 'Office XML 部件超过 16 MiB 搜索限制。');
  if (kind === 'word') await validateWord(bytes);
  if (kind === 'sheet') await validateSheet(bytes);
  return zip;
}

async function xmlPart(zip, name) {
  const file = zip.file(name);
  if (!file || file.dir) fail('INVALID_DOCUMENT', `Office 包缺少 ${name}。`);
  if ((file._data?.uncompressedSize || 0) > XML_LIMIT) fail('TOO_LARGE', 'Office XML 部件超过 16 MiB 搜索限制。');
  const source = await file.async('string');
  if (Buffer.byteLength(source) > XML_LIMIT) fail('TOO_LARGE', 'Office XML 部件超过 16 MiB 搜索限制。');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail('INVALID_DOCUMENT', '不支持 Office XML 实体声明。');
  let broken = false;
  const doc = new DOMParser({onError: () => { broken = true; }}).parseFromString(source, 'application/xml');
  if (broken || !doc.documentElement) fail('INVALID_DOCUMENT', `Office XML 无效：${name}。`);
  return doc;
}

function relatedPart(rels, id, base, suffix) {
  const rel = elements(rels, REL, 'Relationship').find(node => node.getAttribute('Id') === id);
  const target = rel?.getAttribute('Target');
  if (!target || rel.getAttribute('TargetMode') === 'External' || !rel.getAttribute('Type').endsWith(suffix) || /[\\?#\0]/.test(target)) fail('INVALID_DOCUMENT', 'Office 文档关系无效或指向外部。');
  const name = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`${base}/${target}`);
  if (!name.startsWith(`${base}/`) || name.split('/').includes('..')) fail('INVALID_DOCUMENT', 'Office 部件路径越界。');
  return name;
}

async function pptText(bytes, signal) {
  const zip = await zipPackage(bytes, 'ppt');
  const presentation = await xmlPart(zip, 'ppt/presentation.xml');
  const rels = await xmlPart(zip, 'ppt/_rels/presentation.xml.rels');
  const slides = elements(presentation, P, 'sldId');
  if (!slides.length) fail('INVALID_DOCUMENT', 'PPTX 缺少幻灯片。');
  if (slides.length > PAGE_LIMIT) fail('TOO_LARGE', 'PPTX 超过 2000 页搜索限制。');
  const out = collector();
  for (let i = 0; i < slides.length; i++) {
    check(signal);
    const name = relatedPart(rels, slides[i].getAttributeNS(R, 'id'), 'ppt', '/slide');
    const slide = await xmlPart(zip, name);
    const paragraphs = elements(slide, A, 'p').map(paragraph => {
      const pieces = [];
      const visit = node => {
        if (node.namespaceURI === A && node.localName === 't') pieces.push(node.textContent);
        else if (node.namespaceURI === A && node.localName === 'br') pieces.push('\n');
        else for (const child of Array.from(node.childNodes || [])) visit(child);
      };
      visit(paragraph);
      return pieces.join('');
    });
    out.add(paragraphs.join('\n'), i + 1);
  }
  return out.result('ppt');
}

async function sheetText(bytes, signal) {
  // The existing renderer adapter requires browser globals and ExcelJS and mutates
  // a parse-only ZIP. Use the host validator and read OOXML cached values instead.
  // Labels expose worksheet/cell coordinates; formulas are never recalculated.
  const zip = await zipPackage(bytes, 'sheet');
  const workbook = await xmlPart(zip, 'xl/workbook.xml');
  const rels = await xmlPart(zip, 'xl/_rels/workbook.xml.rels');
  const sheets = elements(workbook, S, 'sheet');
  if (sheets.length > PAGE_LIMIT) fail('TOO_LARGE', 'XLSX 超过 2000 工作表搜索限制。');
  const shared = zip.file('xl/sharedStrings.xml') ? elements(await xmlPart(zip, 'xl/sharedStrings.xml'), S, 'si').map(si => elements(si, S, 't').map(t => t.textContent).join('')) : [];
  const out = collector();
  let cellCount = 0;
  for (const sheet of sheets) {
    check(signal);
    const name = relatedPart(rels, sheet.getAttributeNS(R, 'id'), 'xl', '/worksheet');
    const doc = await xmlPart(zip, name);
    for (const cell of elements(doc, S, 'c')) {
      check(signal);
      if (++cellCount > CELL_LIMIT) fail('TOO_LARGE', 'XLSX 超过 100000 单元格搜索限制。');
      const address = cell.getAttribute('r');
      const match = /^([A-Z]+)([1-9]\d*)$/.exec(address);
      const col = match?.[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      if (!match || Number(match[2]) > 10000 || col > 1000) fail('TOO_LARGE', 'XLSX 超出已验证范围（10000 行 / 1000 列）。');
      const type = cell.getAttribute('t');
      let value = elements(cell, S, 'v')[0]?.textContent ?? '';
      if (type === 's') {
        if (!/^\d+$/.test(value) || Number(value) >= shared.length) fail('INVALID_DOCUMENT', 'XLSX 共享字符串索引无效。');
        value = shared[Number(value)];
      } else if (type === 'inlineStr') value = elements(cell, S, 't').map(t => t.textContent).join('');
      else if (type === 'b') value = value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value;
      const formula = elements(cell, S, 'f')[0]?.textContent;
      if (formula) value += `${value ? '\t' : ''}=${formula}`;
      if (value.trim()) out.add(`${sheet.getAttribute('name')}!${address}\t${value}`, {sheetName: sheet.getAttribute('name'), row: Number(match[2]), column: col});
    }
  }
  return out.result('sheet');
}

async function pdfText(bytes, signal) {
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  check(signal);
  // PDF.js Node API uses its in-process fake worker (no Web Worker). Supplying
  // bytes only, and no resource URLs, prevents network reads of fonts/CMaps.
  const task = getDocument({data: new Uint8Array(bytes), isEvalSupported: false,
    useWorkerFetch: false, disableAutoFetch: true, disableStream: true,
    disableFontFace: true, useSystemFonts: false, useWasm: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    enableXfa: false, stopAtErrors: true, verbosity: 0});
  const abort = () => { void task.destroy().catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    const pdf = await task.promise;
    if (pdf.numPages > PAGE_LIMIT) fail('TOO_LARGE', 'PDF 超过 2000 页搜索限制。');
    const out = collector();
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      check(signal);
      const page = await pdf.getPage(pageNo);
      try {
        const stream = page.streamTextContent().getReader();
        const pieces = [];
        let length = 0;
        try {
          while (true) {
            check(signal);
            const {value, done} = await stream.read();
            if (done) break;
            for (const item of value.items) {
              if (typeof item.str !== 'string') continue;
              const text = item.str + (item.hasEOL ? '\n' : '');
              if ((length += text.length) > TEXT_LIMIT) fail('TOO_LARGE', 'PDF 页面文字超过搜索限制。');
              pieces.push(text);
            }
          }
        } finally { await stream.cancel().catch(() => {}); }
        out.add(pieces.join('').trimEnd(), pageNo);
      } finally { page.cleanup(); }
    }
    return out.result('pdf');
  } finally {
    signal?.removeEventListener('abort', abort);
    await task.destroy();
  }
}

/** Read-only disk extraction. Offsets and segments are normalized-LF UTF-16.
 * Returns {text, kind:'pdf'|'word'|'ppt'|'sheet', digest, segments?}.
 * Segments: {from,to,page} for PDF/PPT; {from,to,sheetName,row,column} for
 * worksheet cells (1-based row/column, labels included in the text range).
 * Throws errors with code: ABORT_ERR, NO_TEXT, TOO_LARGE, UNSUPPORTED,
 * INVALID_DOCUMENT, or the original host access/path error. No partial text.
 */
export async function searchDocumentText({host, projectId, relPath, signal}) {
  check(signal);
  const project = await host.requireProject(projectId);
  const located = await host.resolveFile(project, relPath);
  if (located.missing) fail('NOT_FOUND', '搜索文档不存在。');
  const extension = path.posix.extname(located.rel).toLowerCase();
  if (!['.pdf', '.docx', '.pptx', '.xlsx'].includes(extension)) fail('UNSUPPORTED', '正文搜索仅支持 PDF、DOCX、PPTX、XLSX；不支持旧版 Office、OCR 或外部转换。');
  check(signal);
  const raw = await host.readSource(located.abs);
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  check(signal);
  if (bytes.length > INPUT_LIMIT) fail('TOO_LARGE', '文档超过 32 MiB 搜索输入限制。');
  try {
    let result;
    if (extension === '.pdf') result = await pdfText(bytes, signal);
    else if (extension === '.pptx') result = await pptText(bytes, signal);
    else if (extension === '.xlsx') result = await sheetText(bytes, signal);
    else {
      const zip = await zipPackage(bytes, 'word');
      await xmlPart(zip, 'word/document.xml');
      check(signal);
      const out = collector();
      out.add(await wordText(bytes));
      result = out.result('word');
    }
    check(signal);
    return result;
  } catch (error) {
    check(signal);
    if (['ABORT_ERR', 'NO_TEXT', 'TOO_LARGE', 'UNSUPPORTED', 'INVALID_DOCUMENT'].includes(error.code)) throw error;
    throw Object.assign(new Error(`文档文字提取失败：${error.message}`, {cause: error}), {code: 'INVALID_DOCUMENT'});
  }
}
