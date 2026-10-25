const LIMIT = 256 * 1024 * 1024;
const CHUNK = 24576; // Divisible by three, so independently encoded chunks concatenate.
function invalid(message) { return Object.assign(new Error(message), {code:'INVALID_OFFICE_RECOVERY'}); }

// Typed bytes are accepted only at the live capture boundary. Persistence is
// explicit base64, avoiding numeric-key objects and oversized JSON byte arrays.
export function encodeRecoveryBytes(value) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw invalid('恢复文档缺少二进制内容。');
  if (!bytes.length || bytes.length > LIMIT) throw invalid('恢复文档为空或超过 256 MiB。');
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))));
  return {encoding:'base64',byteLength:bytes.length,data:parts.join('')};
}

export function decodeRecoveryBytes(value) {
  if (value?.encoding !== 'base64' || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 || value.byteLength > LIMIT || typeof value.data !== 'string' || value.data.length !== 4 * Math.ceil(value.byteLength / 3)) throw invalid('恢复文档编码无效。');
  const padding = (3 - value.byteLength % 3) % 3;
  if (value.data.slice(value.data.length - padding) !== '='.repeat(padding)) throw invalid('恢复文档填充无效。');
  for (let offset = 0; offset < value.data.length - padding; offset += CHUNK) {
    if (/[^A-Za-z0-9+/]/.test(value.data.slice(offset, Math.min(offset + CHUNK,value.data.length - padding)))) throw invalid('恢复文档编码无效。');
  }
  const bytes = new Uint8Array(value.byteLength);
  let cursor = 0;
  for (let offset = 0; offset < value.data.length; offset += CHUNK) {
    const part = atob(value.data.slice(offset, offset + CHUNK));
    for (let i = 0; i < part.length; i++) bytes[cursor++] = part.charCodeAt(i);
  }
  if (cursor !== bytes.length) throw invalid('恢复文档长度不匹配。');
  return bytes;
}

export function recoveryPptModel(value) {
  const text = JSON.stringify(value);
  if (!text || text.length > LIMIT) throw invalid('PPTX 恢复模型无效或过大。');
  const model = JSON.parse(text);
  if (!model || !Array.isArray(model.slides) || !model.slides.length || model.slides.some(slide => !slide || typeof slide.id !== 'string' || !Array.isArray(slide.elements))) throw invalid('PPTX 恢复模型缺少有效幻灯片。');
  return model;
}
