import { createHash } from 'node:crypto';
import { parser as htmlParser } from '@lezer/html';
import { parser as cssParser } from '@lezer/css';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { imageSize } from 'image-size';
import { REPORT_READER_STYLE, REPORT_READER_STYLE_ID, bakeReportReaderStyle, reportReaderStyleTag } from './report-reader-style.mjs';

// These budgets apply before publication, including resources embedded in the export.
export const HTML_REPORT_LIMITS = Object.freeze({ bodyBytes: 8 * 1024 * 1024, resourceBytes: 32 * 1024 * 1024, assetBytes: 8 * 1024 * 1024, assets: 128, imagePixels: 40_000_000, nodes: 100_000, depth: 128, cssBytes: 1024 * 1024, cssNodes: 100_000, svgNodes: 30_000 });
const htmlTags = new Set('html head title body style meta main article section header footer nav aside div span p h1 h2 h3 h4 h5 h6 blockquote pre code kbd samp var em strong b i u s small mark sub sup abbr cite q dfn time address br wbr hr ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td figure figcaption details summary a img'.split(' '));
const voidTags = new Set('meta br wbr hr col img'.split(' '));
const commonAttrs = new Set('id class title lang dir role hidden tabindex aria-label aria-labelledby aria-describedby aria-hidden aria-expanded aria-details style'.split(' '));
const tagAttrs = { html: ['xmlns'], meta: ['charset', 'name', 'content'], a: ['href'], img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'], ol: ['start', 'reversed', 'type'], li: ['value'], th: ['colspan', 'rowspan', 'scope', 'headers', 'abbr'], td: ['colspan', 'rowspan', 'headers'], col: ['span'], colgroup: ['span'], details: ['open', 'name'], time: ['datetime'], blockquote: ['cite'], q: ['cite'] };
const cssProperties = new Set(('accent-color align-content align-items align-self all appearance aspect-ratio backdrop-filter backface-visibility background background-color background-image background-position background-repeat background-size background-origin background-clip border border-block border-inline border-top border-right border-bottom border-left border-color border-style border-width border-radius border-collapse border-spacing border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius box-shadow box-sizing break-after break-before break-inside caption-side clear clip clip-path color color-scheme column-count column-gap column-width columns contain content counter-increment counter-reset cursor direction display empty-cells fill fill-opacity fill-rule filter flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap float font font-family font-size font-style font-weight font-variant font-variant-numeric gap grid grid-area grid-auto-columns grid-auto-flow grid-auto-rows grid-column grid-column-end grid-column-start grid-row grid-row-end grid-row-start grid-template grid-template-areas grid-template-columns grid-template-rows height hyphens inline-size inset isolation justify-content justify-items justify-self left letter-spacing line-height list-style list-style-position list-style-type margin margin-block margin-block-end margin-block-start margin-inline margin-inline-end margin-inline-start margin-top margin-right margin-bottom margin-left marker-start marker-mid marker-end mask mask-image max-height max-width max-inline-size min-height min-width min-inline-size mix-blend-mode object-fit object-position opacity order orphans outline outline-color outline-offset outline-style outline-width overflow overflow-wrap overflow-x overflow-y padding padding-block padding-block-end padding-block-start padding-inline padding-inline-end padding-inline-start padding-top padding-right padding-bottom padding-left page-break-after page-break-before page-break-inside paint-order pointer-events position print-color-adjust right rotate row-gap scale scroll-margin scroll-margin-top scroll-padding shape-rendering stop-color stop-opacity stroke stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width table-layout text-align text-anchor text-decoration text-decoration-color text-decoration-line text-decoration-style text-indent text-overflow text-rendering text-transform text-wrap top transform transform-box transform-origin translate unicode-bidi user-select vector-effect vertical-align visibility white-space widows width word-break word-spacing word-wrap writing-mode z-index dominant-baseline alignment-baseline baseline-shift').split(' '));
const svgTags = new Set('svg g defs title desc style path rect circle ellipse line polyline polygon text tspan textPath a use symbol marker clipPath mask linearGradient radialGradient stop pattern filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence'.split(' '));
const svgAttrs = new Set(('xmlns xmlns:xlink id class style role aria-label aria-labelledby aria-describedby aria-hidden viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry d points transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity color font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing textLength lengthAdjust dx dy rotate startOffset href xlink:href clip-path clip-rule clipPathUnits mask maskUnits maskContentUnits marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient overflow vector-effect paint-order shape-rendering text-rendering gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr patternUnits patternContentUnits patternTransform filter filterUnits primitiveUnits in in2 result stdDeviation mode type values operator k1 k2 k3 k4 flood-color flood-opacity lighting-color surfaceScale diffuseConstant specularConstant specularExponent limitingConeAngle azimuth elevation scale xChannelSelector yChannelSelector baseFrequency numOctaves seed stitchTiles order kernelMatrix divisor bias targetX targetY edgeMode kernelUnitLength preserveAlpha amplitude exponent intercept slope tableValues').split(' '));
svgAttrs.add('lang');
const cssFunctions = new Set('url var calc min max clamp rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient repeating-conic-gradient translate translateX translateY translateZ translate3d scale scaleX scaleY scaleZ scale3d rotate rotateX rotateY rotateZ rotate3d skew skewX skewY matrix matrix3d perspective blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia counter counters attr fit-content repeat minmax env round mod rem abs sign pow sqrt hypot log exp sin cos tan asin acos atan atan2'.toLowerCase().split(' '));
export const HTML_REPORT_OBJECT_MAX_BYTES = 64 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export class HtmlReportValidationError extends Error {
  constructor(reason, { code = 'HTML_REPORT_INVALID', cause } = {}) {
    super(`HTML report rejected: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'HtmlReportValidationError';
    this.code = code;
  }
}
const fail = (reason, options) => { throw new HtmlReportValidationError(reason, options); };
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const normalize = text => text.replace(/\s+/g, ' ').trim();
function decode(text) {
  const doc = new DOMParser({ onError: () => fail('invalid character reference') }).parseFromString(`<span>${text.replace(/</g, '&lt;')}</span>`, 'text/html');
  return doc.documentElement.textContent;
}
function children(node) { const out = []; for (let child = node.firstChild; child; child = child.nextSibling) out.push(child); return out; }
function checkedTree(parser, text, limit, label) {
  const tree = parser.parse(text); let count = 0; let depth = 0;
  tree.iterate({ enter(node) { if (node.type.isError) fail(`malformed ${label}`); if (++count > limit || ++depth > HTML_REPORT_LIMITS.depth) fail(`${label} complexity budget exceeded`); }, leave() { depth--; } });
  return tree;
}
function decodeCss(input) {
  return input.replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?|\\([^\n\r\f0-9a-f])/gi, (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char);
}
function css(input, inline = false, svg = false) {
  if (Buffer.byteLength(input) > HTML_REPORT_LIMITS.cssBytes) fail('CSS byte budget exceeded');
  // Decode CSS escapes before validation, so escaped functions cannot evade policy.
  const text = decodeCss(input);
  if (/[\u0000-\u0008\u000b\u000e-\u001f<\\]/.test(text)) fail('unsupported CSS characters');
  // Lezer's special unquoted URL token is case-sensitive; CSS function names are not.
  // Same-length casing normalization in the parse view does not alter strings or output bytes.
  const parseInput = input.replace(/\burl(?=\s*\()/gi, 'url');
  const parsed = inline ? `x{${parseInput}}` : parseInput;
  const tree = checkedTree(cssParser, parsed, HTML_REPORT_LIMITS.cssNodes, 'CSS');
  tree.iterate({ enter(node) {
    const value = decodeCss(parsed.slice(node.from, node.to));
    if (node.name === 'PropertyName' && !cssProperties.has(value.toLowerCase()) && !(svg && ['rx', 'ry', 'cx', 'cy', 'r', 'x', 'y', 'd'].includes(value.toLowerCase())) && !/^--[a-zA-Z0-9_-]+$/.test(value)) fail(`unsupported CSS property ${value}`);
    if (node.name === 'AtKeyword' && !['@media', '@supports', '@layer', '@container'].includes(value.toLowerCase())) fail(`unsupported CSS rule ${value}`);
    if (node.name === 'Callee' && !cssFunctions.has(value.toLowerCase())) fail(`unsupported CSS function ${value}`);
  } });
  // Inspect tokens as well as the syntax tree: custom-property values are intentionally opaque in CSS grammars.
  const tokens = text.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@(?!media\b|supports\b|layer\b|container\b)/i.test(tokens) || /(?:expression|image-set|-webkit-image-set|paint|element)\s*\(/i.test(tokens) || /(?:https?:|file:|data:|blob:|javascript:|\/\/)/i.test(tokens)) fail('active or network CSS');
  for (const match of tokens.matchAll(/url\s*\(([^)]*)\)/gi)) if (!/^\s*(['"]?)#[a-zA-Z_][\w:.-]*\1\s*$/.test(match[1])) fail('CSS resource URLs must be local SVG fragments');
  if (/\b(?:animation|transition|behavior|-moz-binding)\s*:/i.test(tokens)) fail('dynamic CSS is unsupported');
  return input;
}
function pathForAsset(value) {
  if (!value || value.length > 2048 || /[\\\u0000-\u0020?#:%]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('invalid local resource path');
  return value;
}
function validateDocumentIds(html) {
  const tree = checkedTree(htmlParser, html, HTML_REPORT_LIMITS.nodes, 'canonical HTML');
  const ids = new Set();
  tree.iterate({ enter(node) {
    if (node.name !== 'Attribute') return;
    const name = node.node.getChild('AttributeName');
    if (!name || html.slice(name.from, name.to).toLowerCase() !== 'id') return;
    const valueNode = node.node.getChild('AttributeValue') || node.node.getChild('UnquotedAttributeValue');
    const value = valueNode ? decode(html.slice(valueNode.from, valueNode.to).replace(/^(["'])([\s\S]*)\1$/, '$2')) : '';
    if (!value || ids.has(value)) fail('duplicate or empty document id');
    ids.add(value);
  } });
}
function localFragment(value) { return /^#[a-zA-Z_][\w:.-]*$/.test(value); }
function validateSvg(source, inline = false) {
  if (Buffer.byteLength(source) > HTML_REPORT_LIMITS.assetBytes || /<!DOCTYPE|<!ENTITY/i.test(source)) fail('SVG declarations or size are unsupported');
  const doc = new DOMParser({ onError: () => fail('malformed SVG') }).parseFromString(source, 'image/svg+xml');
  if (doc.documentElement.localName !== 'svg') fail('SVG root required');
  const root = doc.documentElement;
  const dimensions = ['width', 'height'].map(name => Number(root.getAttribute(name)?.replace(/px$/, '')));
  const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const [width, height] = dimensions.every(value => value > 0) ? dimensions : box.slice(2);
  if (width && height && (!Number.isFinite(width * height) || width * height > HTML_REPORT_LIMITS.imagePixels)) fail('SVG pixel budget exceeded');
  for (const child of Array.from(doc.childNodes)) if (child !== doc.documentElement && child.nodeType !== 8 && !(child.nodeType === 3 && !child.textContent.trim())) fail('unsupported SVG document content');
  let count = 0;
  const ids = new Map(), uses = [], references = [];
  function walk(node, depth) {
    if (++count > HTML_REPORT_LIMITS.svgNodes || depth > HTML_REPORT_LIMITS.depth) fail('SVG complexity budget exceeded');
    if (node.nodeType === 3 || node.nodeType === 8) return;
    if (node.nodeType !== 1) fail('unsupported SVG node');
    if (!svgTags.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/2000/svg') fail(`unsupported SVG element ${node.tagName}`);
    if (node.hasAttribute('id')) {
      const id = node.getAttribute('id');
      if (!/^[a-zA-Z_][\w:.-]*$/.test(id) || ids.has(id)) fail('invalid or duplicate SVG id');
      ids.set(id, node);
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name, value = attr.value;
      if (!svgAttrs.has(name)) fail(`unsupported SVG attribute ${name}`);
      if (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg' || name === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink') fail('invalid SVG namespace');
      if (name === 'href' || name === 'xlink:href') { if (!localFragment(value)) fail('external SVG reference'); }
      if (name === 'style') node.setAttribute(name, css(value, true, true));
      if (['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end'].includes(name)) css(`${name}:${value}`, true, true);
      if (['d', 'points'].includes(name) && value.length > 500_000) fail('SVG geometry budget exceeded');
      if (name === 'numOctaves' && (!/^\d+$/.test(value) || Number(value) > 8)) fail('SVG filter complexity exceeded');
      if (name === 'stdDeviation' && value.split(/[ ,]+/).some(part => !Number.isFinite(Number(part)) || Math.abs(Number(part)) > 256)) fail('SVG filter complexity exceeded');
      if (name === 'href' || name === 'xlink:href') {
        references.push(value.slice(1));
      }
      for (const match of decodeCss(value).matchAll(/url\s*\(\s*['"]?#([\w:.-]+)['"]?\s*\)/gi)) references.push(match[1]);
    }
    if (node.tagName === 'use') {
      const target = node.hasAttribute('href') ? node.getAttribute('href') : node.getAttribute('xlink:href');
      if (target) uses.push([node, target.slice(1)]);
    }
    if (node.tagName === 'style') {
      node.textContent = css(node.textContent, false, true);
      for (const match of decodeCss(node.textContent).matchAll(/url\s*\(\s*['"]?#([\w:.-]+)['"]?\s*\)/gi)) references.push(match[1]);
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child, depth + 1);
  }
  walk(doc.documentElement, 0);
  for (const id of references) if (!ids.has(id)) fail('missing SVG fragment reference');
  const useTargets = new Map(uses);
  let expanded = 0;
  function expand(node, stack) {
    if (++expanded > HTML_REPORT_LIMITS.svgNodes * 4 || stack.size > 32) fail('SVG expansion budget exceeded');
    if (stack.has(node)) fail('cyclic SVG reference');
    stack.add(node);
    if (useTargets.has(node)) expand(ids.get(useTargets.get(node)), stack);
    for (const child of Array.from(node.childNodes)) if (child.nodeType === 1) expand(child, stack);
    stack.delete(node);
  }
  expand(doc.documentElement, new Set());
  let serialized = new XMLSerializer().serializeToString(doc.documentElement);
  // In inline HTML SVG, style is raw text; XML entity escaping would change selectors/content.
  if (inline) {
    const styles = Array.from(doc.getElementsByTagName('style'));
    let index = 0;
    serialized = serialized.replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/g, (_, start, end) => start + styles[index++].textContent + end);
  }
  const serializer = new XMLSerializer();
  const notices = Array.from(doc.childNodes).filter(child => child.nodeType === 8).map(child => serializer.serializeToString(child)).join('\n');
  return notices ? `${notices}\n${serialized}` : serialized;
}
const mediaByType = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
// The host baseline must keep passing the same strict CSS policy as author styles.
css(REPORT_READER_STYLE);

export async function prepareHtmlReport(html, { readAsset, resolveReference } = {}) {
  if (typeof html !== 'string' || !html.trim()) fail('nonempty HTML is required');
  // Republishing a previously frozen report can carry the baked host baseline
  // verbatim. Ingest drops exactly those host-owned bytes and re-bakes the
  // current baseline; partial or spoofed use of the reserved id still fails.
  const bakedStyle = reportReaderStyleTag();
  if (html.includes(bakedStyle)) html = html.split(bakedStyle).join('');
  if (Buffer.byteLength(html) > HTML_REPORT_LIMITS.bodyBytes) fail('body byte budget exceeded');
  const tree = checkedTree(htmlParser, html, HTML_REPORT_LIMITS.nodes, 'HTML');
  const manifest = { version: 1, assets: [], references: [], semanticText: '' };
  const assets = new Map(); let resourceBytes = 0; let title = ''; let heading = '';
  async function renderChildren(nodes, hiddenText = false) {
    let result = '';
    let byteLength = 0;
    for (const node of nodes) {
      const rendered = await render(node, hiddenText);
      byteLength += Buffer.byteLength(rendered);
      if (byteLength > HTML_REPORT_OBJECT_MAX_BYTES) fail('self-contained output byte budget exceeded');
      result += rendered;
    }
    return result;
  }
  async function asset(path) {
    pathForAsset(path);
    if (assets.has(path)) return assets.get(path);
    if (assets.size >= HTML_REPORT_LIMITS.assets) fail('asset count budget exceeded');
    if (typeof readAsset !== 'function') fail('local resource is unavailable', { code: 'HTML_REPORT_RESOURCE_UNAVAILABLE' });
    let supplied;
    try { supplied = await readAsset(path); } catch (cause) { fail('local resource is unavailable', { code: 'HTML_REPORT_RESOURCE_UNAVAILABLE', cause }); }
    if (!supplied || !(supplied.bytes instanceof Uint8Array)) fail('local resource is unavailable', { code: 'HTML_REPORT_RESOURCE_UNAVAILABLE' });
    const bytes = Buffer.from(supplied.bytes);
    if (bytes.length > HTML_REPORT_LIMITS.assetBytes || (resourceBytes += bytes.length) > HTML_REPORT_LIMITS.resourceBytes) fail('resource byte budget exceeded');
    const hash = digest(bytes);
    if (supplied.digest && supplied.digest !== hash) fail('resource digest mismatch');
    let size;
    try { size = imageSize(bytes); } catch { fail('unsupported or malformed image'); }
    const mediaType = mediaByType[size.type];
    if (!mediaType || !size.width || !size.height || size.width * size.height > HTML_REPORT_LIMITS.imagePixels) fail('image type or pixel budget exceeded');
    if (supplied.mediaType && supplied.mediaType.split(';')[0].trim().toLowerCase() !== mediaType) fail('resource MIME mismatch');
    const extension = path.split('.').pop().toLowerCase();
    if (!({ png: ['png'], jpg: ['jpg', 'jpeg'], gif: ['gif'], webp: ['webp'], svg: ['svg'] }[size.type] || []).includes(extension)) fail('resource extension mismatch');
    let embedded = bytes;
    if (size.type === 'svg') {
      let source;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid SVG encoding'); }
      embedded = Buffer.from(validateSvg(source));
    }
    const uri = `data:${mediaType};base64,${embedded.toString('base64')}`;
    manifest.assets.push({ path, digest: hash, byteLength: bytes.length, mediaType, embeddedDigest: digest(embedded) });
    assets.set(path, uri); return uri;
  }
  async function reference(href) {
    if (localFragment(href)) return href;
    if (typeof resolveReference !== 'function') fail('reference is unavailable', { code: 'HTML_REPORT_REFERENCE_UNAVAILABLE' });
    if (!href || href.length > 2048 || /[\u0000-\u0020\\]/.test(href) || /^(?:javascript|data|file|blob|vbscript):/i.test(href)) fail('unsafe reference');
    let resolved;
    try { resolved = await resolveReference(href); } catch (cause) { fail('reference is unavailable', { code: 'HTML_REPORT_REFERENCE_UNAVAILABLE', cause }); }
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) fail('reference is unavailable', { code: 'HTML_REPORT_REFERENCE_UNAVAILABLE' });
    let copied;
    try { copied = JSON.parse(JSON.stringify(resolved)); } catch { fail('invalid reference capability'); }
    const id = String(manifest.references.length);
    manifest.references.push({ ...copied, id, href });
    return `nozeli-report-ref:${id}`;
  }
  async function render(node, hiddenText = false) {
    if (node.name === 'DoctypeDecl') return '';
    if (node.name === 'Comment') {
      const comment = html.slice(node.from, node.to);
      if (!/^<!--(?:[^-]|-(?!-))*-->$/.test(comment) || /^<!--(?:>|->)/.test(comment)) fail('ambiguous HTML comment');
      return comment;
    }
    if (node.name !== 'Element') {
      if (node.name === 'Document') return renderChildren(children(node));
      const text = decode(html.slice(node.from, node.to));
      if (!['Text', 'EntityReference', 'CharacterReference'].includes(node.name)) fail(`unsupported HTML syntax ${node.name}`);
      const parentName = node.parent?.name === 'Element' ? node.parent.firstChild.getChild('TagName') : null;
      if (text.trim() && parentName && ['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'head', 'html'].includes(html.slice(parentName.from, parentName.to).toLowerCase())) fail('HTML would relocate important text');
      return escape(text);
    }
    const list = children(node); const open = list[0];
    const tagNode = open.getChild('TagName');
    if (!tagNode) fail('missing element name');
    const tag = html.slice(tagNode.from, tagNode.to).toLowerCase();
    if (tag !== 'svg' && !htmlTags.has(tag)) fail(`unsupported HTML element ${tag}`);
    const parentElement = node.parent?.name === 'Element' ? node.parent : null;
    const parentNameNode = parentElement?.firstChild?.getChild('TagName');
    const parentTag = parentNameNode ? html.slice(parentNameNode.from, parentNameNode.to).toLowerCase() : '';
    const requiredParents = { html: [''], head: ['html'], body: ['html'], title: ['head'], meta: ['head'], caption: ['table'], colgroup: ['table'], col: ['colgroup'], thead: ['table'], tbody: ['table'], tfoot: ['table'], tr: ['table', 'thead', 'tbody', 'tfoot'], th: ['tr'], td: ['tr'], li: ['ul', 'ol'], dt: ['dl'], dd: ['dl'], summary: ['details'] };
    if (requiredParents[tag] && !requiredParents[tag].includes(parentTag)) fail(`invalid HTML parent for ${tag}`);
    if (parentTag === 'table' && !['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'style'].includes(tag) || ['thead', 'tbody', 'tfoot'].includes(parentTag) && tag !== 'tr' || parentTag === 'tr' && !['td', 'th'].includes(tag) || parentTag === 'head' && !['title', 'meta', 'style'].includes(tag) || parentTag === 'html' && !['head', 'body'].includes(tag)) fail('HTML would relocate important content');
    if (tag === 'svg') {
      const svg = validateSvg(html.slice(node.from, node.to), true);
      return svg;
    }
    const attrs = new Map();
    for (const attribute of children(open).filter(child => child.name === 'Attribute')) {
      const keyNode = attribute.getChild('AttributeName');
      const name = html.slice(keyNode.from, keyNode.to).toLowerCase();
      if (attrs.has(name)) fail('duplicate HTML attribute');
      const valueNode = attribute.getChild('AttributeValue') || attribute.getChild('UnquotedAttributeValue');
      let value = valueNode ? html.slice(valueNode.from, valueNode.to) : '';
      if (/^["']/.test(value)) value = value.slice(1, -1);
      value = decode(value);
      if (!commonAttrs.has(name) && !(tagAttrs[tag] || []).includes(name)) fail(`unsupported HTML attribute ${name}`);
      if (name === 'style') value = css(value, true);
      if (name === 'src') value = await asset(value);
      if (name === 'href' || name === 'cite') value = await reference(value);
      if (name === 'tabindex' && !['0', '-1'].includes(value)) fail('unsupported tabindex');
      if (name === 'xmlns' && value !== 'http://www.w3.org/1999/xhtml') fail('invalid HTML namespace');
      attrs.set(name, value);
    }
    if (tag === 'meta' && !(attrs.size === 1 && attrs.get('charset')?.toLowerCase() === 'utf-8') && !(attrs.get('name') === 'viewport' && attrs.size === 2 && attrs.has('content'))) fail('unsupported HTML metadata');
    if (tag === 'img' && (!attrs.has('src') || !attrs.has('alt'))) fail('images require local src and alt');
    const contentNodes = list.slice(1).filter(child => child.name !== 'CloseTag');
    let content;
    if (tag === 'style') content = css(contentNodes.map(child => html.slice(child.from, child.to)).join(''));
    else content = await renderChildren(contentNodes, hiddenText || tag === 'head' || tag === 'title');
    if (tag === 'title') title ||= normalize(decode(content));
    if (tag === 'h1') heading ||= readHtmlReportText(`<div>${content}</div>`);
    const serializedAttrs = Array.from(attrs, ([name, value]) => ` ${name}="${escape(value)}"`).join('');
    return `<${tag}${serializedAttrs}>${voidTags.has(tag) ? '' : `${content}</${tag}>`}`;
  }
  let canonical = await render(tree.topNode);
  const roots = children(tree.topNode).filter(node => !['Comment', 'DoctypeDecl'].includes(node.name) && html.slice(node.from, node.to).trim());
  if (!roots.length || roots.some(node => node.name !== 'Element')) fail('HTML elements are required; plain text or Markdown is not an HTML report');
  const documentRoot = roots.find(node => node.name === 'Element' && html.slice(node.firstChild.getChild('TagName').from, node.firstChild.getChild('TagName').to).toLowerCase() === 'html');
  if (documentRoot && roots.length !== 1) fail('multiple document roots');
  if (!documentRoot) canonical = `<html><head><meta charset="utf-8"></head><body>${canonical}</body></html>`;
  if (canonical.includes(`id="${REPORT_READER_STYLE_ID}"`)) fail('reserved host reader style id');
  // Bake the host baseline as the first head style: exports are self-contained
  // and later author styles keep the last word in the cascade.
  canonical = bakeReportReaderStyle(canonical);
  canonical = `<!doctype html>\n${canonical}`;
  if (Buffer.byteLength(canonical) > HTML_REPORT_OBJECT_MAX_BYTES) fail('self-contained output byte budget exceeded');
  validateDocumentIds(canonical);
  manifest.semanticText = readHtmlReportText(canonical);
  if (!manifest.semanticText) fail('report has no semantic content');
  return { html: canonical, title: (title || heading || manifest.semanticText).slice(0, 200), excerpt: manifest.semanticText.slice(0, 500), manifest: freeze(manifest) };
}

// Frozen reports have already passed preparation; this reader never opens paths or URLs.
export function readHtmlReportText(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > HTML_REPORT_OBJECT_MAX_BYTES) fail('report read budget exceeded');
  const tree = checkedTree(htmlParser, html, HTML_REPORT_LIMITS.nodes, 'HTML');
  const text = [];
  function walk(node) {
    if (node.name === 'Element') {
      const open = node.firstChild; const name = open.getChild('TagName');
      const tag = html.slice(name.from, name.to).toLowerCase();
      if (['head', 'style', 'script'].includes(tag)) return;
      text.push(' ');
      if (tag === 'img') {
        for (const attribute of children(open).filter(child => child.name === 'Attribute')) {
          const key = attribute.getChild('AttributeName'), value = attribute.getChild('AttributeValue') || attribute.getChild('UnquotedAttributeValue');
          if (value && html.slice(key.from, key.to).toLowerCase() === 'alt') text.push(decode(html.slice(value.from, value.to).replace(/^(["'])([\s\S]*)\1$/, '$2')));
        }
      }
      for (const child of children(node).slice(1)) if (child.name !== 'CloseTag') walk(child);
      text.push(' ');
    } else if (node.name === 'Document') children(node).forEach(walk);
    else if (!['Comment', 'DoctypeDecl'].includes(node.name)) text.push(decode(html.slice(node.from, node.to)));
  }
  walk(tree.topNode); return normalize(text.join(''));
}
