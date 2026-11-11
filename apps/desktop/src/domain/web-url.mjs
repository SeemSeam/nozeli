const invalid = () => Object.assign(new Error('请输入有效的 HTTP 或 HTTPS 网站地址。'), {code:'WEB_URL_INVALID'});

// nzl: Address-bar input only; never turn an explicit non-web scheme into HTTPS.
export function normalizeWebUrl(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  let nzlAddressInput = value.trim();
  if (!nzlAddressInput || /[\x00-\x20\x7f\\]/.test(nzlAddressInput)) throw invalid();
  if (!/^[a-z][a-z\d+.-]*:/i.test(nzlAddressInput) || /^(?:localhost|[a-z\d.-]+):\d+(?:[/?#]|$)/i.test(nzlAddressInput)) nzlAddressInput = 'https://' + nzlAddressInput;
  let url;
  try { url = new URL(nzlAddressInput); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw invalid();
  return url.href;
}

export function webTitle(value) {
  return new URL(normalizeWebUrl(value)).host;
}
