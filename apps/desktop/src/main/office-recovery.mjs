import JSZip from 'jszip';
import {decodeRecoveryBytes, recoveryPptModel} from '../domain/office-recovery.mjs';
import {validateWord} from './word-package.mjs';
import {validateSheet} from './sheet-package.mjs';

// Validate the actual exported package before retaining it; a ZIP signature alone
// is not evidence that the Office engine produced a usable document.
export async function normalizeOfficeRecovery(kind, candidate) {
  if (!['word','sheet','ppt'].includes(kind)) return candidate;
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
    return {bytes:candidate.bytes, model:recoveryPptModel(candidate?.model)};
  }
  return {bytes:candidate.bytes};
}
