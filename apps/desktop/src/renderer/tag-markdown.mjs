import { markdownLanguage } from '@codemirror/lang-markdown';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { highlightTree, classHighlighter } from '@lezer/highlight';
import katex from 'katex';
import {highlightMarkdownCode} from './markdown-code.mjs';

const SAFE_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
const FILE_SUFFIX = /^(.*?)(?::(?:line|行)?(\d+))?$/u;


function safeUrl(value) { try { const parsed = new URL(value); return SAFE_PROTOCOLS.has(parsed.protocol) && !/[\u0000-\u0020]/u.test(value) ? value : null; } catch { return null; } }
function projectTarget(value, filePaths, basePath = '') {
  const match=FILE_SUFFIX.exec(String(value).trim());if(!match)return null;
  let path;try{path=decodeURIComponent(match[1]).replaceAll('\\','/');}catch{return null;}
  const hash=path.indexOf('#'),fragment=hash<0?null:path.slice(hash+1);if(hash>=0)path=path.slice(0,hash);
  if(!path || path.startsWith('/') || /^[a-z]+:/iu.test(path))return null;
  const normalize=parts=>{const result=[];for(const part of parts){if(!part || part==='.')continue;if(part==='..'){if(!result.length)return null;result.pop();}else result.push(part);}return result.join('/');};
  const candidates=[normalize([...basePath.split('/').slice(0,-1),...path.split('/')]),normalize(path.split('/'))];
  const relPath=candidates.find(candidate=>candidate && filePaths?.has(candidate));
  return relPath?{relPath,line:match[2]?Number(match[2]):null,...(fragment?{fragment}:{})}:null;
}
const mathParser=markdownLanguage.parser.configure({
  defineNodes:['NozeliMath'],
  parseInline:[{name:'NozeliMath',before:'Escape',parse(cx,next,pos){
    const start=cx.slice(pos,pos+2),delimiter=start==='$$'?'$$':start==='\\('?'\\)':start==='\\['?'\\]':next===36?'$':null;
    if(!delimiter)return -1;
    const width=delimiter.length,tail=cx.slice(pos+width,cx.end);
    let index=tail.indexOf(delimiter);
    while(index>=0 && tail[index-1]==='\\')index=tail.indexOf(delimiter,index+width);
    if(index<0 || (delimiter==='$' && tail.slice(0,index).includes('\n')))return -1;
    return cx.addElement(cx.elt('NozeliMath',pos,pos+width+index+width));
  }}],
});

export function renderTagMarkdown(target, value, options = {}) {
  const text = String(value ?? ''), tree = mathParser.parse(text), doc = target.ownerDocument || document, words = [];
  const mapped=(el,from,to,atomic=false)=>{
    if(options.mapSource && Number.isInteger(from)){el.dataset.mdFrom=String(from);el.dataset.mdTo=String(to);if(atomic)el.dataset.mdAtomic='true';}
    return el;
  };
  const block=(el,n)=>{if(options.mapSource){el.dataset.mdBlockFrom=String(n.from);el.dataset.mdBlockTo=String(n.to);}return el;};
  const node = (tag, content) => { const el = doc.createElement(tag); if (content != null) { el.textContent = content; words.push(String(content)); } return el; };
  const raw = n => text.slice(n.from, n.to);
  const formulaPattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(\$[^\n$]+?\$)/gu;
  function appendText(into, source, from) {
    let cursor = 0;
    formulaPattern.lastIndex = 0;
    for (const match of source.matchAll(formulaPattern)) {
      const start = match.index ?? 0;
      if (start > cursor) into.append(mapped(node('span', source.slice(cursor, start)),from+cursor,from+start));
      const display = Boolean(match[1] || match[2]);
      const tex = match[1] || match[2] || match[3] || match[4].slice(1, -1);
      const formula = doc.createElement('span');
      formula.className = display ? 'conversation-math conversation-math-display' : 'conversation-math';
      formula.setAttribute('data-tex', tex);
      words.push(tex);
      try {
        const html = katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, output: 'htmlAndMathml' });
        if ('innerHTML' in formula) formula.innerHTML = html;
        else formula.textContent = tex;
      } catch {
        formula.textContent = tex;
      }
      into.append(mapped(formula,from+start,from+start+match[0].length,true));
      cursor = start + match[0].length;
    }
    if (cursor < source.length) into.append(mapped(node('span', source.slice(cursor)),from+cursor,from+source.length));
  }
  const inline = new Set(['Paragraph', 'Emphasis', 'StrongEmphasis', 'Strikethrough', 'InlineCode', 'Link', 'TableCell', 'Subscript', 'Superscript']);
  const ignored = new Set(['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'CodeInfo', 'LinkMark', 'URL', 'LinkTitle', 'ListMark', 'QuoteMark', 'TableDelimiter', 'TaskMarker']);
  function children(n, into, gaps) { let end = n.from; for (let c = n.firstChild; c; c = c.nextSibling) { if (gaps && c.from > end) appendText(into, text.slice(end, c.from),end); render(c, into); end = c.to; } if (gaps && end < n.to) appendText(into, text.slice(end, n.to),end); }
  function codeBlock(code, language, into) { const el = node('code'); if (el.dataset) el.dataset.language = language || ''; el.textContent = code; if (language === 'js' || language === 'javascript' || language === 'mjs') { const spans = []; highlightTree(javascriptLanguage.parser.parse(code), classHighlighter, (from, to, classes) => spans.push({ from, to, classes })); if (spans.length && el.replaceChildren) { el.replaceChildren(); let cursor = 0; for (const span of spans) { if (span.from > cursor) el.append(node('span', code.slice(cursor, span.from))); const part = node('span', code.slice(span.from, span.to)); part.className = span.classes; el.append(part); cursor = span.to; } if (cursor < code.length) el.append(node('span', code.slice(cursor))); } } into.append(el); }
  function render(n, into) {
    if (ignored.has(n.name)) return;
    if (n.name === 'Document') { children(n, into, false); return; }
    // CodeMirror tokenizes backslash math delimiters as separate Escape nodes.
    // Render that paragraph as text runs so the complete TeX expression remains intact.
    if(n.name==='NozeliMath'){appendText(into,raw(n),n.from);return;}
    if(n.name==='Escape'){into.append(mapped(node('span',raw(n).slice(1)),n.from,n.to,true));return;}
    if(n.name==='Entity'){
      const decoder=doc.createElement('textarea');decoder.innerHTML=raw(n);
      into.append(mapped(node('span',decoder.value || raw(n)),n.from,n.to,true));return;
    }
    if (n.name === 'Image') {
      const source = raw(n), open = source.indexOf('['), end = source.indexOf(']');
      const alt = source.slice(open + 1, end < 0 ? undefined : end);
      let url = ''; for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === 'URL') url = raw(c);
      // Local relative references render as lazy images resolved by the host;
      // remote/data URLs keep the text placeholder (no automatic network loads).
      const local = options.images && url && !url.includes('\\') && !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(url);
      if (local) {
        const figure = block(node('span'), n); figure.className = 'markdown-image';
        const image = node('img'); image.alt = alt; image.loading = 'lazy';
        image.dataset.imageRef = url;
        const caption = node('span', alt || url); caption.className = 'markdown-image-caption';
        figure.append(image, caption); into.append(figure); return;
      }
      into.append(node('span', '[图片：' + alt + ']')); return;
    }
    if(n.name==='FencedCode' || n.name==='CodeBlock'){
      const lines=[],positions=[];let language='';
      for(let c=n.firstChild;c;c=c.nextSibling){
        if(c.name==='CodeInfo')language=raw(c).trim().toLowerCase().split(/\s/u)[0];
        if(c.name==='CodeText'){if(lines.length)positions.push(c.from-1);lines.push(raw(c));for(let i=c.from;i<c.to;i++)positions.push(i);positions.end=c.to;}
      }
      positions.push(positions.end??n.from);
      const pre=block(node('pre'),n);pre.dataset.language=language;
      if(language){const label=node('span',language);label.className='conversation-code-language';pre.append(label);}
      codeBlock(lines.join('\n'),language,pre);
      const code=pre.children[pre.children.length-1];
      if(options.mapSource && lines.length){code.textContent=lines.join('\n');mapped(code,positions[0],positions.at(-1));code._markdownSource=positions;}
      into.append(pre);return;
    }
    if (n.name === 'HTMLTag' || n.name === 'HTMLBlock' || n.name === 'CommentBlock' || n.name === 'ProcessingInstructionBlock') { into.append(block(node('span', raw(n)),n)); return; }
    if (n.name === 'HardBreak') { into.append(node('br')); return; }
    if (n.name === 'HorizontalRule') { into.append(block(node('hr'),n)); return; }
    const tags = { Paragraph:'p', StrongEmphasis:'strong', Emphasis:'em', Strikethrough:'del', InlineCode:'code', BulletList:'ul', OrderedList:'ol', ListItem:'li', Blockquote:'blockquote', Table:'table', TableHeader:'tr', TableRow:'tr', TableCell:n.parent?.name === 'TableHeader' ? 'th' : 'td', Subscript:'sub', Superscript:'sup' };
    const heading = /^(?:ATX|Setext)Heading([1-6])$/u.exec(n.name), tag = heading ? 'h' + heading[1] : tags[n.name];
    if (n.name === 'InlineCode') {
      const original=raw(n),marks=/^`+/u.exec(original)?.[0].length||0;
      const value=original.slice(marks,original.length-marks),targetPath=projectTarget(value,options.filePaths,options.basePath);
      if (targetPath) { const link = mapped(node('button', value),n.from+marks,n.to-marks); link.type = 'button'; link.className = 'conversation-file-link'; if (link.dataset) link.dataset.path = targetPath.relPath; link.addEventListener('click', () => options.onFile?.(targetPath)); into.append(link); return; }
      const code = mapped(node('code'),n.from+marks,n.to-marks); code.textContent = value; words.push(value); into.append(code); return;
    }
    if(n.name==='Link' || n.name==='Autolink'){
      let url='';for(let c=n.firstChild;c;c=c.nextSibling)if(c.name==='URL')url=raw(c);
      const project=projectTarget(url,options.filePaths,options.basePath),local=url.startsWith('#')&&options.onAnchor;
      if(project || local){const link=node('button');link.type='button';link.className='conversation-file-link';if(project)link.dataset.path=project.relPath;children(n,link,true);link.addEventListener('click',()=>project?options.onFile?.(project):options.onAnchor(url.slice(1)));into.append(link);return;}
      const safe=safeUrl(url),link=node(safe?'a':'span');
      if(safe){link.setAttribute('href',safe);link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');link.addEventListener('click',event=>{
        if(options.onExternal){event.preventDefault();options.onExternal(safe);}
        else if(globalThis.window?.nozeli?.invoke){event.preventDefault();void window.nozeli.invoke('links.openExternal',{url:safe}).then(result=>{if(!result.ok)options.onLinkError?.(result.error?.message);});}
      });}
      if(n.name==='Autolink'){link.textContent=url||raw(n);words.push(link.textContent);mapped(link,n.from+1,n.to-1);}else children(n,link,true);into.append(link);return;
    }
    if (tag) { const el = node(tag); if(heading || ['Paragraph','ListItem','Blockquote','Table','TableHeader','TableRow'].includes(n.name))block(el,n); children(n, el, inline.has(n.name) || Boolean(heading)); if (n.name === 'ListItem' && /^\s*\[[ xX]\]/u.test(raw(n))) { const check = node('input'); check.type = 'checkbox'; check.disabled = true; check.checked = /^\s*\[x\]/iu.test(raw(n)); el.prepend?.(check); } if (n.name === 'Table') { const scroll = node('span'); scroll.className = 'tag-table-scroll'; scroll.append(el); into.append(scroll); } else into.append(el); return; }
    appendText(into, raw(n),n.from);
  }
  target.replaceChildren(...(options.retainNodes || []));target._markdownRenderToken=Symbol('markdown');render(tree.topNode,target);
  if(target.querySelectorAll){
    const headings=new Map();
    for(const heading of target.querySelectorAll('h1,h2,h3,h4,h5,h6')){
      const base=heading.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu,'').replace(/\s+/gu,'-');
      const count=headings.get(base)||0;headings.set(base,count+1);heading.id=base+(count?'-'+count:'');
    }
    for(const code of target.querySelectorAll('pre code')){
      const copy=doc.createElement('button');copy.type='button';copy.className='conversation-copy';copy.textContent='⧉';copy.title='复制代码';copy.setAttribute('aria-label','复制代码');
      copy.addEventListener('click',async()=>{
        try{
          if(options.onCopy)await options.onCopy(code.textContent);
          else if(globalThis.window?.nozeli?.invoke){const result=await window.nozeli.invoke('document.clipboard',{action:'write',text:code.textContent});if(!result.ok)throw Error(result.error?.message || '复制失败');}
          else await navigator.clipboard.writeText(code.textContent);
          copy.textContent='✓';copy.title='已复制';
        }catch{copy.textContent='!';copy.title='复制失败';options.onCopyError?.();}
      });
      code.parentElement.prepend(copy);
    }
    target.markdownReady=highlightMarkdownCode(target,options);
  }
  return words.join(' ').replace(/\s+/gu, ' ').trim() || target.textContent.replace(/\s+/gu, ' ').trim();
}

export function tagMarkdownSummary(value) { return renderTagMarkdown(document.createElement('span'), value); }
