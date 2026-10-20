import {createHighlighterCore} from '@shikijs/core';
import {createJavaScriptRegexEngine} from '@shikijs/engine-javascript';
import light from '@shikijs/themes/light-plus';
const languages = {
  javascript: () => import('@shikijs/langs/javascript'), typescript: () => import('@shikijs/langs/typescript'),
  cpp: () => import('@shikijs/langs/cpp'), python: () => import('@shikijs/langs/python'),
  json: () => import('@shikijs/langs/json'), css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'), sql: () => import('@shikijs/langs/sql'),
  java: () => import('@shikijs/langs/java'), go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'), bash: () => import('@shikijs/langs/bash'),
  latex: () => import('@shikijs/langs/latex'), yaml: () => import('@shikijs/langs/yaml'),
};
const aliases = {js:'javascript',mjs:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',c:'cpp','c++':'cpp',cc:'cpp',py:'python',sh:'bash',shell:'bash',tex:'latex',yml:'yaml'};
let highlighter;
const loading = new Map();
function grammar(id) {
  highlighter ||= createHighlighterCore({themes:[light],langs:[],engine:createJavaScriptRegexEngine({forgiving:true})});
  if (!loading.has(id)) loading.set(id, highlighter.then(async h => {await h.loadLanguage((await languages[id]()).default); return h;}));
  return loading.get(id);
}
export async function highlightMarkdownCode(target, options = {}) {
  const token = target._markdownRenderToken;
  await Promise.all([...target.querySelectorAll('pre code')].map(async code => {
    const id = aliases[code.dataset.language] || code.dataset.language;
    if (!languages[id] || code.textContent.length > 100_000) return;
    const text = code.textContent;
    try {
      const h = await grammar(id);
      if (target._markdownRenderToken !== token || !target.contains(code)) return;
      const lines = h.codeToTokens(text, {lang:id,theme:'light-plus'}).tokens;
      const parts = []; let offset = 0;
      const map = code._markdownSource;
      for (let i=0;i<lines.length;i++) {
        if (i) {
          const newline = document.createElement('span'); newline.textContent = '\n';
          if (map) {newline.dataset.mdFrom = String(map[offset]); newline.dataset.mdTo = String(map[offset+1]);}
          parts.push(newline); offset++;
        }
        for (const item of lines[i]) {
          const span = document.createElement('span'); span.textContent = item.content; span.style.color = item.color;
          if (map) {span.dataset.mdFrom = String(map[offset]); span.dataset.mdTo = String(map[offset+item.content.length]);}
          offset += item.content.length; parts.push(span);
        }
      }
      code.replaceChildren(...parts); code.removeAttribute('data-md-from'); code.removeAttribute('data-md-to');
      code.dataset.highlighted = id;
    } catch { /* An unsupported grammar remains readable plain code. */ }
  }));
  if (target._markdownRenderToken === token) options.onLayout?.();
}
