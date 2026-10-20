import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { sql } from '@codemirror/lang-sql';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { go } from '@codemirror/lang-go';
import { rust } from '@codemirror/lang-rust';
import { autocompletion } from '@codemirror/autocomplete';

const extensionMap = new Map([
  ['.tex','latex'], ['.sty','latex'], ['.cls','latex'], ['.bib','bibtex'],
  ['.js', 'javascript'], ['.jsx', 'jsx'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.ts', 'typescript'], ['.tsx', 'tsx'], ['.py', 'python'], ['.json', 'json'],
  ['.css', 'css'], ['.html', 'html'], ['.htm', 'html'], ['.sql', 'sql'],
  ['.java', 'java'], ['.c', 'cpp'], ['.h', 'cpp'], ['.cc', 'cpp'], ['.cpp', 'cpp'],
  ['.cxx', 'cpp'], ['.hpp', 'cpp'], ['.go', 'go'], ['.rs', 'rust'],
]);
const words = {
  javascript: 'const let var function class return if else for while import export from async await new this throw try catch true false null undefined typeof'.split(' '),
  jsx: 'const let var function class return if else for while import export from async await new this throw try catch true false null undefined typeof'.split(' '),
  typescript: 'interface type enum namespace implements public private readonly declare abstract keyof unknown never any string number boolean'.split(' '),
  tsx: 'interface type enum namespace implements public private readonly declare abstract keyof unknown never any string number boolean'.split(' '),
  python: 'def class return if elif else for while import from as async await yield try except finally with lambda True False None self print len range'.split(' '),
  json: 'true false null'.split(' '), css: 'display position color background margin padding width height grid flex'.split(' '),
  html: 'html head body div span main section article header footer script style link meta button input form'.split(' '),
  sql: 'select from where insert into update delete create alter drop table index join left right inner group by order having limit as and or not null'.split(' '),
  java: 'class interface extends implements public private protected static final void int boolean new return if else for while try catch package import'.split(' '),
  cpp: 'include define namespace class struct template typename public private protected const auto void int char bool return if else for while'.split(' '),
  go: 'package import func type struct interface map range go defer chan select return if else for switch case'.split(' '),
  rust: 'fn let mut struct enum trait impl pub use mod match if else for while loop return async await move'.split(' '),
};

export function completionLabelsFor(languageId, text) {
  const symbols = documentSymbols(text).map(item => item.name);
  return [...new Set([...(words[languageId] || []), ...symbols])];
}

export function languageIdForPath(relPath) {
  const match = /\.([^.]+)$/.exec(String(relPath || '').toLowerCase());
  return match ? extensionMap.get(`.${match[1]}`) || null : null;
}

// Editing mode is independent of whether a syntax/semantic adapter is installed.
export function isCodePath(relPath) {
  return Boolean(languageIdForPath(relPath)) || /(?:\.(?:sh|bash|zsh|fish|ps1|bat|cmd|cmake|rb|php|swift|kt|kts|cs|m|mm|lua|r|pl|vue|svelte|yml|yaml|toml|ini)|(?:^|\/)(?:CMakeLists\.txt|Makefile|Dockerfile))$/i.test(relPath || '');
}

export function languageSupportForPath(relPath) {
  const id = languageIdForPath(relPath);
  switch (id) {
    case 'javascript': return javascript();
    case 'jsx': return javascript({ jsx: true });
    case 'typescript': return javascript({ typescript: true });
    case 'tsx': return javascript({ typescript: true, jsx: true });
    case 'python': return python();
    case 'json': return json();
    case 'css': return css();
    case 'html': return html();
    case 'sql': return sql();
    case 'java': return java();
    case 'cpp': return cpp();
    case 'go': return go();
    case 'rust': return rust();
    default: return [];
  }
}

const definitionPatterns = [
  /\b(?:function|class|interface|type|enum|struct|trait|fn|func|def)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var|val|auto)\s+([A-Za-z_$][\w$]*)/g,
  /\b([A-Za-z_$][\w$]*)\s*\([^\n]*\)\s*\{/g,
];
export function documentSymbols(text) {
  const symbols = [];
  for (const pattern of definitionPatterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) symbols.push({ name: match[1], from: match.index + match[0].lastIndexOf(match[1]), to: match.index + match[0].lastIndexOf(match[1]) + match[1].length, kind: 'definition' });
  }
  return symbols.sort((a, b) => a.from - b.from).filter((item, index, all) => index === 0 || item.from !== all[index - 1].from);
}

export function symbolAt(text, pos) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  const lineEnd = text.indexOf('\n', pos) < 0 ? text.length : text.indexOf('\n', pos);
  const line = text.slice(lineStart, lineEnd);
  const offset = pos - lineStart;
  const match = /[A-Za-z_$][\w$]*/g;
  let current;
  while ((current = match.exec(line))) if (current.index <= offset && current.index + current[0].length >= offset) return { name: current[0], from: lineStart + current.index, to: lineStart + current.index + current[0].length };
  return null;
}

export function navigationTarget(text, pos) {
  const symbol = symbolAt(text, pos);
  if (!symbol) return { kind: 'missing' };
  const definition = documentSymbols(text).find(item => item.name === symbol.name);
  if (definition) return { kind: 'definition', ...definition };
  const lineStart = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  const lineEnd = text.indexOf('\n', pos) < 0 ? text.length : text.indexOf('\n', pos);
  const line = text.slice(lineStart, lineEnd);
  const importMatch = /(?:import|include|require\s*\()[^'"`]*['"`]([^'"`]+)['"`]/.exec(line);
  return importMatch ? { kind: 'path', path: importMatch[1], from: symbol.from, to: symbol.to } : { kind: 'missing', name: symbol.name };
}

export function codeCompletionSource(context) {
  const word = context.matchBefore(/[A-Za-z_$][\w$]*/);
  if (!word && !context.explicit) return null;
  const from = word ? word.from : context.pos;
  const text = context.state.doc.toString();
  const id = context.state.facet(codeLanguageFacet);
  const symbols = documentSymbols(text);
  const symbolNames = new Set(symbols.map(item => item.name));
  const options = [...new Set([...(words[id] || []), ...symbols.map(item => item.name)])].map(label => ({ label, type: symbolNames.has(label) ? 'variable' : 'keyword', section: symbolNames.has(label) ? '当前文件符号' : '语言关键字' }));
  return { from, options, validFor: /^[A-Za-z_$][\w$]*$/ };
}

import { Facet } from '@codemirror/state';
export const codeLanguageFacet = Facet.define({ combine: values => values[0] || null });
export function codeExtensions(relPath) {
  const id = languageIdForPath(relPath);
  return id ? [languageSupportForPath(relPath), codeLanguageFacet.of(id), autocompletion({ override: [codeCompletionSource] })] : [];
}
