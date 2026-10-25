import {createHighlighterCore} from '@shikijs/core';
import {createJavaScriptRegexEngine} from '@shikijs/engine-javascript';
import light from '@shikijs/themes/light-plus';
import dark from '@shikijs/themes/dark-plus';
import './markdown-code.css';

// Use the darker of the light code papers and brighter of the dark papers so
// AA-adjusted Shiki hues remain readable in either palette, not only on white.
const surfaces = {light:[242,246,250],dark:[36,42,39]};
const foregrounds = {light:'#27332D',dark:'#E5EAE7'};
const palette = {light:new Map(),dark:new Map()};
function luminance(rgb) {
  const channels = rgb.map(value => {const c=value/255; return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});
  return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
}
function readableColor(color, mode) {
  const cache=palette[mode];
  if (cache.has(color)) return cache.get(color);
  const hex=/^#([\da-f]{6})$/iu.exec(color || '');
  if (!hex) return foregrounds[mode];
  const rgb=[0,2,4].map(offset=>parseInt(hex[1].slice(offset,offset+2),16));
  const background=luminance(surfaces[mode]);
  const contrast=value=>{const foreground=luminance(value);return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05);};
  let result=color;
  if (contrast(rgb)<4.6) {
    const end=mode==='dark'?255:0;
    const blend=amount=>rgb.map(value=>Math.round(value+(end-value)*amount));
    let low=0,high=1;
    for(let i=0;i<12;i++){const middle=(low+high)/2;if(contrast(blend(middle))>=4.6)high=middle;else low=middle;}
    result='#'+blend(high).map(value=>value.toString(16).padStart(2,'0')).join('');
  }
  cache.set(color,result);return result;
}
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
  highlighter ||= createHighlighterCore({themes:[light,dark],langs:[],engine:createJavaScriptRegexEngine({forgiving:true})});
  if (!loading.has(id)) loading.set(id, highlighter.then(async h => {await h.loadLanguage((await languages[id]()).default); return h;}));
  return loading.get(id);
}
export async function highlightMarkdownCode(target, options = {}) {
  const token = target._markdownRenderToken;
  await Promise.all([...target.querySelectorAll('pre code')].map(async code => {
    code.parentElement.dataset.markdownCode='';
    const id = aliases[code.dataset.language] || code.dataset.language;
    if (!languages[id] || code.textContent.length > 100_000) return;
    const text = code.textContent;
    try {
      const h = await grammar(id);
      if (target._markdownRenderToken !== token || !target.contains(code)) return;
      const lines = h.codeToTokensWithThemes(text, {lang:id,themes:{light:'light-plus',dark:'dark-plus'}});
      const parts = []; let offset = 0;
      const map = code._markdownSource;
      for (let i=0;i<lines.length;i++) {
        if (i) {
          const newline = document.createElement('span');
          newline.textContent = text.startsWith('\r\n',offset)?'\r\n':text[offset];
          const end=offset+newline.textContent.length;
          if (map) {newline.dataset.mdFrom = String(map[offset]); newline.dataset.mdTo = String(map[end]);}
          parts.push(newline); offset=end;
        }
        for (const item of lines[i]) {
          const span = document.createElement('span'); span.textContent = item.content;
          span.style.setProperty('--markdown-token-light',readableColor(item.variants.light.color,'light'));
          span.style.setProperty('--markdown-token-dark',readableColor(item.variants.dark.color,'dark'));
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
