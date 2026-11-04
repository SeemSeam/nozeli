// Single source of truth for the host baseline reading style of HTML reports.
// New publications bake it into the canonical object (prepareHtmlReport), so
// exported files stay self-contained without the app. The isolated display
// layer injects the same bytes when serving reports published before it
// existed; frozen object bytes are never rewritten. The style is always the
// first style of the document: later author styles keep the last word, and
// author SVG colors and geometry are never touched.
export const REPORT_READER_STYLE_ID = 'nozeli-reader-style';
export const REPORT_VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';
// Host-injected accent tokens map to fixed enums only — never arbitrary CSS.
// Values mirror the renderer document-domain tokens per palette x mode.
export const REPORT_ACCENTS = {
  sage: { light: { paper: '#fffefa', ink: '#263932', link: '#456654' }, dark: { paper: '#222b25', ink: '#e1e9e3', link: '#a6cba9' } },
  slate: { light: { paper: '#fbfcfe', ink: '#263544', link: '#355f88' }, dark: { paper: '#222d3a', ink: '#e3eaf2', link: '#a4c7ed' } },
};
export const reportAccentCss = (palette, mode) => {
  const safe = REPORT_ACCENTS[palette] ? palette : 'sage';
  const set = REPORT_ACCENTS[safe][mode === 'dark' ? 'dark' : 'light'];
  return `:root{--nozeli-paper:${set.paper};--nozeli-ink:${set.ink};--nozeli-link:${set.link}}`;
};
export const REPORT_READER_STYLE = `/* Nozeli host baseline reading style; later author styles may override it. */
/* nozeli-reader-baseline v4 */
:root{color-scheme:light dark}
html{background:var(--nozeli-paper,light-dark(#ffffff,#10151c))}
body{max-width:72ch;margin:0 auto;padding:clamp(1.25rem,4vw,3rem);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif;font-size:1.0625rem;line-height:1.75;color:var(--nozeli-ink,light-dark(#212934,#d9e0e8));background:var(--nozeli-paper,light-dark(#ffffff,#10151c));overflow-wrap:break-word}
h1,h2,h3,h4,h5,h6{font-weight:700;line-height:1.35;margin:2em 0 .65em;break-after:avoid}
h1{font-size:1.9em;margin-top:0;margin-bottom:.65em}
h2{font-size:1.4em;padding-bottom:.35em;border-bottom:1px solid light-dark(#c9d3de,#465365)}
h3{font-size:1.15em}
h4,h5,h6{font-size:1em}
h1+p,.report-lead{font-size:1.12em;line-height:1.65;margin-bottom:1.4em}
.report-conclusion{margin:1.4em 0 1.8em;padding:.9em 1.15em;border-left:3px solid var(--nozeli-link,light-dark(#0a5cd3,#86b6ff));background:light-dark(#f2f5f9,#18202a)}
.report-conclusion>h2:first-child,.report-conclusion>h3:first-child{margin-top:0;padding-bottom:0;border:0}
.report-conclusion>:last-child{margin-bottom:0}
p,ul,ol,dl,blockquote,figure,pre,table,details,hr{margin:0 0 1.1em}
p{orphans:3;widows:3}
li{margin:.35em 0}
li>ul,li>ol{margin:.35em 0}
dt{font-weight:700;margin-top:.8em}
dd{margin-inline-start:1.5em}
hr{border:0;border-top:1px solid light-dark(#c9d3de,#465365);margin:2.2em 0}
a{color:var(--nozeli-link,light-dark(#0a5cd3,#86b6ff))}
a:focus-visible,summary:focus-visible,table:focus-visible,pre:focus-visible{outline:2px solid var(--nozeli-link,light-dark(#0a5cd3,#86b6ff));outline-offset:3px}
ul,ol{padding-inline-start:1.6em}
blockquote{padding:.35em 1.2em;border-left:3px solid light-dark(#c9d3de,#333f4d)}
code,kbd,samp{font-family:ui-monospace,"Cascadia Code",Menlo,Consolas,"Liberation Mono","Noto Sans Mono CJK SC",monospace;font-size:.92em}
:not(pre)>code{background:light-dark(#eef2f7,#1a2330);border-radius:.3em;padding:.12em .38em}
kbd{background:light-dark(#f4f6fa,#1a2330);border:1px solid light-dark(#b6c1cd,#46556a);border-bottom:2px solid light-dark(#b6c1cd,#46556a);border-radius:.3em;padding:.1em .45em;font-size:.85em}
pre{overflow-x:auto;padding:1em 1.15em;border-radius:.45em;background:light-dark(#f2f5f9,#18202a);line-height:1.55}
table{border-collapse:collapse;display:block;width:100%;max-width:100%;overflow-x:auto;font-size:.94em;line-height:1.55;margin:1.4em 0}
caption{caption-side:top;text-align:start;min-width:min(48ch,calc(100vw - 4rem));padding:0 0 .65em;font-weight:600;color:light-dark(#4f5b6b,#b4bfce)}
th,td{border-bottom:1px solid light-dark(#c9d3de,#465365);padding:.55em .8em;text-align:start;vertical-align:top}
th{background:light-dark(#f2f5f9,#18202a);font-weight:700}
thead th{border-bottom:2px solid light-dark(#9eacbc,#748398)}
th.report-number,td.report-number{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}
tfoot{font-weight:600}
figure{margin:1.8em 0;padding:1em 0;border-block:1px solid light-dark(#c9d3de,#465365)}
img{max-width:100%;height:auto}
figure>img,figure>svg{display:block;margin-inline:auto;max-width:100%;height:auto}
figure svg{max-width:100%;height:auto}
figcaption{margin-top:.8em;font-size:.92em;line-height:1.6;color:light-dark(#4f5b6b,#b4bfce)}
details{padding:.65em 0;border-block:1px solid light-dark(#c9d3de,#465365)}
summary{cursor:pointer;font-weight:600;padding:.35em .2em;line-height:1.6}
summary:hover{color:var(--nozeli-link,light-dark(#0a5cd3,#86b6ff))}
details[open]>summary{margin-bottom:.8em}
details>:last-child{margin-bottom:0}
@media (max-width:30rem){body{font-size:1rem;padding:1.25rem 1rem 2.5rem}h1{font-size:1.6em}h2{font-size:1.28em}h1+p,.report-lead{font-size:1.06em}.report-conclusion{padding:.75em .9em}th,td{padding:.5em .6em}}
@media print{html{background:#ffffff}body{max-width:none;padding:0;font-size:11pt;color:#000000;background:#ffffff}a{color:#000000}:root{color-scheme:light;--nozeli-paper:#ffffff;--nozeli-ink:#000000;--nozeli-link:#000000}pre,th,.report-conclusion{background:#f2f5f9;color:#000000}:not(pre)>code,kbd{background:#f4f6fa;color:#000000}hr,h2,th,td,thead th,figure,details,.report-conclusion{border-color:#9eacbc}caption,figcaption{color:#4f5b6b}pre{overflow:visible;white-space:pre-wrap}table{display:table;width:100%;overflow:visible;font-size:.9em}th,td{overflow-wrap:anywhere}th.report-number,td.report-number{white-space:normal}blockquote,figure,tr{break-inside:avoid}details{border:0}summary{font-weight:700}}`;

export const reportReaderStyleTag = () => `<style id="${REPORT_READER_STYLE_ID}">${REPORT_READER_STYLE}</style>`;
const hasViewport = html => /<meta[^>]+name=["']viewport["']/i.test(html);

// Display-layer adapter for objects published before the baseline existed.
// Injection sits between the doctype and <html>; the HTML parser relocates
// both nodes into the (implicit) head ahead of author styles. Served bytes
// only — the frozen object keeps its original digest.
export function withReportReaderStyle(html) {
  if (typeof html !== 'string' || html.includes(`<style id="${REPORT_READER_STYLE_ID}">`)) return html;
  const injected = reportReaderStyleTag() + (hasViewport(html) ? '' : REPORT_VIEWPORT_META);
  const doctype = /^\s*<!doctype\s+html\s*>/i.exec(html);
  const offset = doctype ? doctype[0].length : 0;
  return html.slice(0, offset) + injected + html.slice(offset);
}
// Served-byte adapter for baselines baked by older builds: swap the recognizable
// host style block for the current versioned baseline so old reports follow the
// app theme without rewriting any frozen object. Author styles keep their order.
export function upgradeReportReaderStyle(html) {
  if (typeof html !== 'string') return html;
  const pattern = new RegExp(`<style id="${REPORT_READER_STYLE_ID}">([\\s\\S]*?)</style>`);
  const existing = pattern.exec(html);
  if (!existing) return html;
  if (existing[1].includes('nozeli-reader-baseline v4')) return html;
  return html.slice(0, existing.index) + reportReaderStyleTag() + html.slice(existing.index + existing[0].length);
}

// Canonical adapter used by prepareHtmlReport: the markup there is always
// host-serialized, so an exact first-child insertion into <head> (or a
// synthesized <head> before <body>) needs no reparse. The caller rejects
// documents that already use the reserved host style id.
export function bakeReportReaderStyle(markup) {
  const style = reportReaderStyleTag() + (hasViewport(markup) ? '' : REPORT_VIEWPORT_META);
  const head = /<head(?:\s[^>]*)?>/.exec(markup);
  if (head) return markup.slice(0, head.index + head[0].length) + style + markup.slice(head.index + head[0].length);
  const synthesized = `<head>${style}</head>`;
  const body = /<body(?:\s[^>]*)?>/.exec(markup);
  if (body) return markup.slice(0, body.index) + synthesized + markup.slice(body.index);
  const html = /<html(?:\s[^>]*)?>/.exec(markup);
  if (html) return markup.slice(0, html.index + html[0].length) + synthesized + markup.slice(html.index + html[0].length);
  return synthesized + markup;
}
