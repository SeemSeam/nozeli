import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
register('./tex-workspace-css.fixture.mjs',import.meta.url);
const {renderTagMarkdown}=await import('../src/renderer/tag-markdown.mjs');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this._text = ''; this.ownerDocument = doc; this.listeners = {}; }
  set textContent(value) { this._text=String(value);this.children=[]; }
  get textContent() { return this._text+this.children.map(c=>c.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text='';this.children=children; }
  setAttribute(k,v) { this.attrs[k]=v; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { this.listeners.click?.({ preventDefault() {} }); }
}
const doc={createElement:tag=>new Element(tag)};
const all=(root,tag)=>[...(root.tag===tag?[root]:[]),...root.children.flatMap(c=>all(c,tag))];
test('shared GFM renderer creates headings, emphasis, lists, quotes, code and tables',()=>{
 const root=new Element('div'), fence=String.fromCharCode(96).repeat(3);
 const summary=renderTagMarkdown(root,'# 标题\n\n**重点**与*强调*\n\n- 一\n- 二\n\n> 引用\n\n| A | B |\n|---|---|\n|1|2|\n\n'+fence+'js\nx < y\n'+fence);
 for(const name of ['h1','strong','em','ul','li','blockquote','table','th','td','pre','code']) assert.ok(all(root,name).length>0,name);
 assert.match(summary,/标题 重点/); assert.ok(!summary.includes('**'));
 assert.equal(all(root,'code')[0].textContent,'x < y');
 assert.equal(all(root,'table')[0].children.length,2);
});
test('raw HTML and dangerous links remain inert; remote image is never created',()=>{
 const root=new Element('div');
 renderTagMarkdown(root,'<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[bad](javascript:alert) [data](data:text/html,evil) [safe](https://example.org) ![image](https://example.org/a.png)');
 assert.equal(all(root,'script').length,0);assert.equal(all(root,'img').length,0);
 const links=all(root,'a');assert.equal(links.length,1);assert.equal(links[0].attrs.href,'https://example.org');assert.equal(links[0].textContent,'safe');
 assert.match(root.textContent,/onerror=alert/);assert.match(root.textContent,/图片：image/);
 renderTagMarkdown(root,'replacement');assert.equal(root.textContent,'replacement');
});
test('validated project links decode spaces and preserve line suffix without opening ordinary words', () => {
 const root = new Element('div'); let opened = null;
 renderTagMarkdown(root, '[论文](notes/%E4%B8%AD%E6%96%87.md:12) `notes/中文.md:7` ordinary', { filePaths: new Set(['notes/中文.md']), onFile: value => { opened = value; } });
 const buttons = all(root, 'button'); assert.equal(buttons.length, 2); buttons[0].click(); assert.deepEqual(opened, { relPath: 'notes/中文.md', line: 12 }); buttons[1].click(); assert.deepEqual(opened, { relPath: 'notes/中文.md', line: 7 });
});
test('inline and display TeX become explicit KaTeX math nodes', () => {
 const root = new Element('div');
 renderTagMarkdown(root, '能量公式 $E=mc^2$\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$');
 const formulas = all(root, 'span').filter(node => node.attrs['data-tex']);
 assert.equal(formulas.length, 2);
 assert.equal(formulas[0].attrs['data-tex'], 'E=mc^2');
 assert.equal(formulas[1].attrs['data-tex'], '\\int_0^1 x^2 dx = \\frac{1}{3}');
 assert.equal(formulas[1].className, 'conversation-math conversation-math-display');
});
test('backslash TeX delimiters survive CodeMirror escape tokenization', () => {
 const root = new Element('div');
 renderTagMarkdown(root, String.raw`inline \(x+1\) and display \[\sum_i i\]`);
 const formulas = all(root, 'span').filter(node => node.attrs['data-tex']);
 assert.deepEqual(formulas.map(node => node.attrs['data-tex']), ['x+1', '\\sum_i i']);
});
