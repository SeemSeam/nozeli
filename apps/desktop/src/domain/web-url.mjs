const invalid = () => Object.assign(new Error('请输入有效的 HTTP 或 HTTPS 网站地址。'), {code:'WEB_URL_INVALID'});

// Address-bar input only: never turn an explicit non-web scheme into HTTPS.
export function normalizeWebUrl(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  let input = value.trim();
  if (!input || /[\x00-\x20\x7f\\]/.test(input)) throw invalid();
  if (!/^[a-z][a-z\d+.-]*:/i.test(input) || /^(?:localhost|[a-z\d.-]+):\d+(?:[/?#]|$)/i.test(input)) input = 'https://' + input;
  let url;
  try { url = new URL(input); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw invalid();
  return url.href;
}

export function webTitle(value) {
  return new URL(normalizeWebUrl(value)).host;
}
