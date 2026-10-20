import JSZip from 'jszip';
export async function validateSheet(bytes) {
  if (bytes.length < 4 || bytes.length > 32 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('不是有效的 XLSX 文件，或文件超过 32 MiB。');
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(f => !f.dir);
  if (files.length > 10000 || files.reduce((sum, f) => sum + (f._data?.uncompressedSize || 0), 0) > 128 * 1024 * 1024) throw new Error('XLSX 解压尺寸超过安全限制。');
  if (!zip.file('[Content_Types].xml') || !zip.file('xl/workbook.xml')) throw new Error('XLSX 缺少主文档。');
  const xml = await zip.file('xl/workbook.xml').async('string');
  if (!xml.includes('http://schemas.openxmlformats.org/spreadsheetml/2006/main') || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XLSX 主文档无效。');
}
