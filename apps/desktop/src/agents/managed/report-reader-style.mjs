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
/* nozeli-reader-baseline v3 */
:root{color-scheme:light dark}
html{background:var(--nozeli-paper,light-dark(#ffffff,#10151c))}
body{max-width:74ch;margin:0 auto;padding:clamp(1.25rem,4vw,2.75rem);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif;font-size:1.0625rem;line-height:1.75;color:var(--nozeli-ink,light-dark(#212934,#d9e0e8));background:var(--nozeli-paper,light-dark(#ffffff,#10151c));overflow-wrap:break-word}
h1,h2,h3,h4,h5,h6{font-weight:700;line-height:1.3;margin:1.9em 0 .65em}
h1{font-size:1.85em;margin-top:0}
h2{font-size:1.4em}
h3{font-size:1.18em}
h4,h5,h6{font-size:1em}
p,ul,ol,dl,blockquote,figure,pre,table,details,hr{margin:0 0 1.05em}
li{margin:.3em 0}
li>ul,li>ol{margin:.3em 0}
dt{font-weight:700;margin-top:.7em}
dd{margin-inline-start:1.5em}
hr{border:0;border-top:1px solid light-dark(#c9d3de,#333f4d);margin:2.2em 0}
a{color:var(--nozeli-link,light-dark(#0a5cd3,#86b6ff))}
a:focus-visible,summary:focus-visible{outline:2px solid var(--nozeli-link,light-dark(#0a5cd3,#86b6ff));outline-offset:2px}
ul,ol{padding-inline-start:1.6em}
blockquote{padding:.35em 1.2em;border-left:3px solid light-dark(#c9d3de,#333f4d)}
code,kbd,samp{font-family:ui-monospace,"Cascadia Code",Menlo,Consolas,"Liberation Mono","Noto Sans Mono CJK SC",monospace;font-size:.92em}
:not(pre)>code{background:light-dark(#eef2f7,#1a2330);border-radius:.3em;padding:.12em .38em}
kbd{background:light-dark(#f4f6fa,#1a2330);border:1px solid light-dark(#b6c1cd,#46556a);border-bottom:2px solid light-dark(#b6c1cd,#46556a);border-radius:.3em;padding:.1em .45em;font-size:.85em}
pre{overflow-x:auto;padding:1em 1.15em;border-radius:.45em;background:light-dark(#f2f5f9,#18202a);line-height:1.55}
table{border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow-x:auto}
caption{caption-side:top;text-align:start;padding:.5em 0;font-size:.92em;color:light-dark(#4f5b6b,#a3b0bf)}
th,td{border:1px solid light-dark(#c9d3de,#333f4d);padding:.45em .7em;text-align:start;vertical-align:top}
th{background:light-dark(#f2f5f9,#18202a);font-weight:700}
figure{margin:1.6em 0}
img{max-width:100%;height:auto}
figure svg{max-width:100%;height:auto}
figcaption{margin-top:.6em;font-size:.92em;line-height:1.6;color:light-dark(#4f5b6b,#a3b0bf)}
summary{cursor:pointer;font-weight:700;margin:.2em 0 .5em}
details[open]>summary{margin-bottom:.65em}
@media (max-width:30rem){body{font-size:1rem;padding:1.2rem 1.1rem 2.5rem}h1{font-size:1.55em}h2{font-size:1.28em}}
@media print{html{background:#ffffff}body{max-width:none;padding:0;font-size:11pt;color:#000000;background:#ffffff}a{color:#000000}:root{color-scheme:light;--nozeli-paper:#ffffff;--nozeli-ink:#000000;--nozeli-link:#000000}pre,th{background:#f2f5f9;color:#000000}:not(pre)>code,kbd{background:#f4f6fa;color:#000000}hr,th,td{border-color:#c9d3de}caption,figcaption{color:#4f5b6b}pre{overflow:visible;white-space:pre-wrap}table{overflow:visible}blockquote,figure,pre,tr{break-inside:avoid}}`;

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
  if (existing[1].includes('nozeli-reader-baseline v3')) return html;
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
