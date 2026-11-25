import JSZip from 'jszip';
import {decodeRecoveryBytes, recoveryPptModel} from '../domain/office-recovery.mjs';
import {validateWord} from './word-package.mjs';
import {validateSheet} from './sheet-package.mjs';

export async function validateSheetSnapshot(raw) {
  if (!(raw instanceof Uint8Array) || !raw.byteLength || raw.byteLength > 160 * 1024 * 1024) throw new Error('表格恢复数据无效。');
  const data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(raw));
  if (data?.schema !== 'nozeli-sheet-recovery-v1' || !Array.isArray(data.sheets) || !data.sheets.length || data.sheets.some(sheet => !sheet || typeof sheet !== 'object' || Array.isArray(sheet)) || !Array.isArray(data.original) || !data.original.length || data.original.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('表格恢复快照无效。');
  await validateSheet(Buffer.from(data.original));
}

// Validate the actual exported package before retaining it; a ZIP signature alone
// is not evidence that the Office engine produced a usable document.
export async function normalizeOfficeRecovery(kind, candidate) {
  if (!['word','sheet','ppt'].includes(kind)) return candidate;
  if (kind === 'sheet' && candidate?.sheetSnapshot) {
    await validateSheetSnapshot(decodeRecoveryBytes(candidate.sheetSnapshot));
    return {sheetSnapshot:candidate.sheetSnapshot};
  }
  const bytes = decodeRecoveryBytes(candidate?.bytes);
  const buffer = Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (kind === 'word') await validateWord(buffer);
  else if (kind === 'sheet') await validateSheet(buffer);
  else {
    const zip = await JSZip.loadAsync(buffer);
    const files = Object.values(zip.files).filter(file => !file.dir);
    if (files.length > 10000 || files.reduce((sum,file) => sum + (file._data?.uncompressedSize || 0),0) > 512 * 1024 * 1024) throw new Error('PPTX 恢复文件解压尺寸超过安全限制。');
    const presentation = zip.file('ppt/presentation.xml');
    if (!zip.file('[Content_Types].xml') || !presentation || !files.some(file => /^ppt\/slides\/slide\d+\.xml$/.test(file.name))) throw new Error('PPTX 恢复文件缺少演示文稿。');
    const xml = await presentation.async('string');
    if (!xml.includes('http://schemas.openxmlformats.org/presentationml/2006/main') || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('PPTX 恢复文件无效。');
    // A marked source read is the untouched original file, captured because the
    // initial import failed and no editor ever existed: there is no model to
    // demand and none may ride along, because these bytes are not editing
    // proof. Unmarked byte-only candidates still have to prove their edits.
    if (candidate?.sourceRead === true) {
      if (candidate.model !== undefined) throw new Error('PPTX 原件保留不能携带编辑模型。');
      return {bytes:candidate.bytes, sourceRead:true};
    }
    return {bytes:candidate.bytes, model:recoveryPptModel(candidate?.model)};
  }
  return {bytes:candidate.bytes};
}
