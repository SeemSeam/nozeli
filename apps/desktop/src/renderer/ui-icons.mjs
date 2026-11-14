// Official Lucide SVG definitions: https://github.com/lucide-icons/lucide
// ISC/MIT notices are retained in workspace-conversation-controls.LICENSE.
import {setUiHint} from './ui-tooltip.mjs';

// 2026-11-13: confirmed icon-list-v2 set moved here as the single source
// (save, download, panel-top, file-cog, plug-zap, square, trash, square-pen,
// message-square-reply) plus corner-up-right/folder-open/rotate-cw for the
// jump-definition/open-project/reload actions. No page keeps a second copy.
const paths = {
  pencil: [["path", {"d": "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}], ["path", {"d": "m15 5 4 4"}]],
  "eraser": [["path", {"d": "m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"}], ["path", {"d": "M22 21H7"}], ["path", {"d": "m5 11 9 9"}]],
  "undo": [["path", {"d": "M9 14 4 9l5-5"}], ["path", {"d": "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"}]],
  "redo": [["path", {"d": "m15 14 5-5-5-5"}], ["path", {"d": "M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"}]],
  layout: [['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }], ['path', { d: 'M3 9h18' }], ['path', { d: 'M9 21V9' }]],
  floating: [['path', { d: 'M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4' }], ['rect', { width: 10, height: 7, x: 12, y: 13, rx: 2 }]],
  maximize: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  minimize: ['M8 3v3a2 2 0 0 1-2 2H3', 'M21 8h-3a2 2 0 0 1-2-2V3', 'M3 16h3a2 2 0 0 1 2 2v3', 'M16 21v-3a2 2 0 0 1 2-2h3'],
  reset: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
  arrow: ['m5 12 7-7 7 7', 'M12 19V5'],
  minus: ['M5 12h14'],

  "plus": [["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],
  "chevron-up": [["path",{"d":"m18 15-6-6-6 6"}]],
  "chevron-down": [["path",{"d":"m6 9 6 6 6-6"}]],
  "chevron-left": [["path",{"d":"m15 18-6-6 6-6"}]],
  "chevron-right": [["path",{"d":"m9 18 6-6-6-6"}]],
  "search": [["circle",{"cx":"11","cy":"11","r":"8"}],["path",{"d":"m21 21-4.3-4.3"}]],
  "scan": [["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}]],
  "list-tree": [["path",{"d":"M21 12h-8"}],["path",{"d":"M21 6H8"}],["path",{"d":"M21 18h-8"}],["path",{"d":"M3 6v4c0 1.1.9 2 2 2h3"}],["path",{"d":"M3 10v6c0 1.1.9 2 2 2h3"}]],
  "book-open": [["path",{"d":"M12 7v14"}],["path",{"d":"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"}]],
  "sticky-note": [["path",{"d":"M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"}],["path",{"d":"M15 3v4a2 2 0 0 0 2 2h4"}]],
  "message-square": [["path",{"d":"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"}]],
  globe: [['circle',{cx:12,cy:12,r:10}],['path',{d:'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'}],['path',{d:'M2 12h20'}]],
  terminal: ['m4 17 6-5-6-5', 'M12 19h8'],
  "circle-help": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"}],["path",{"d":"M12 17h.01"}]],
  "arrow-down": [["path",{"d":"M12 5v14"}],["path",{"d":"m19 12-7 7-7-7"}]],
  "ellipsis": [["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"19","cy":"12","r":"1"}],["circle",{"cx":"5","cy":"12","r":"1"}]],
  "check": [["path",{"d":"M20 6 9 17l-5-5"}]],
  "triangle-alert": [["path", {"d": "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"}], ["path", {"d": "M12 9v4"}], ["path", {"d": "M12 17h.01"}]],
  settings: [['path',{d:'m9.7 4.3.6-2.3h3.4l.6 2.3 2 .9 2.1-.7 1.7 3-1.5 1.6.2 2.3 1.7 1.5-1.7 3-2.2-.5-1.9 1.3-.4 2.3h-3.5l-.5-2.3-2-1.2-2.1.5-1.7-3 1.6-1.5.1-2.3L2.7 8l1.7-3 2.2.7z'}],['circle',{cx:12,cy:11,r:3}]],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  "save": [["path",{"d":"M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"}],["path",{"d":"M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"}],["path",{"d":"M7 3v4a1 1 0 0 0 1 1h7"}]],
  "download": [["path",{"d":"M12 15V3"}],["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],["path",{"d":"m7 10 5 5 5-5"}]],
  "panel-top": [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}]],
  "file-cog": [["path",{"d":"M15 8a1 1 0 0 1-1-1V2a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8z"}],["path",{"d":"M20 8v12a2 2 0 0 1-2 2h-4.182"}],["path",{"d":"m3.305 19.53.923-.382"}],["path",{"d":"M4 10.592V4a2 2 0 0 1 2-2h8"}],["path",{"d":"m4.228 16.852-.924-.383"}],["path",{"d":"m5.852 15.228-.383-.923"}],["path",{"d":"m5.852 20.772-.383.924"}],["path",{"d":"m8.148 15.228.383-.923"}],["path",{"d":"m8.53 21.696-.382-.924"}],["path",{"d":"m9.773 16.852.922-.383"}],["path",{"d":"m9.773 19.148.922.383"}],["circle",{"cx":"7","cy":"18","r":"3"}]],
  "plug-zap": [["path",{"d":"M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"}],["path",{"d":"m2 22 3-3"}],["path",{"d":"M7.5 13.5 10 11"}],["path",{"d":"M10.5 16.5 13 14"}],["path",{"d":"m18 3-4 4h6l-4 4"}]],
  "square": [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}]],
  "trash": [["path",{"d":"M10 11v6"}],["path",{"d":"M14 11v6"}],["path",{"d":"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"}],["path",{"d":"M3 6h18"}],["path",{"d":"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"}]],
  "square-pen": [["path",{"d":"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"}],["path",{"d":"M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"}]],
  "message-square-reply": [["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"m10 8-3 3 3 3"}],["path",{"d":"M17 14v-1a2 2 0 0 0-2-2H7"}]],
  "corner-up-right": [["path",{"d":"m15 14 5-5-5-5"}],["path",{"d":"M4 20v-7a4 4 0 0 1 4-4h12"}]],
  "folder-open": [["path",{"d":"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"}]],
  "rotate-cw": [["path",{"d":"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}]],
  copy: [['rect',{width:14,height:14,x:8,y:8,rx:2,ry:2}],['path',{d:'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'}]],
};

export function uiIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true })) svg.setAttribute(key, value);
  svg.classList.add('ui-icon'); svg.dataset.icon=name; svg.setAttribute('focusable','false');
  for (const definition of paths[name]) {
    const [tag, attrs] = typeof definition === 'string' ? ['path', { d: definition }] : definition;
    const child = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
    svg.append(child);
  }
  return svg;
}



export function setIconButton(button, name, {label, text = ''} = {}) {
  const current = button.querySelector(':scope > .ui-icon');
  if (current?.dataset.icon !== name || (button.querySelector(':scope > .ui-icon-text')?.textContent || '') !== text) {
    button.replaceChildren(uiIcon(name));
    if (text) { const span=document.createElement('span');span.className='ui-icon-text';span.textContent=text;button.append(span); }
  }
  button.classList.toggle('ui-icon-button', !text);button.classList.toggle('ui-icon-label', Boolean(text));
  if (label) { button.setAttribute('aria-label',label);setUiHint(button,label); }
  else if(button.title){setUiHint(button,button.title);}
  return button;
}

export function setFontButton(button, size) {
  let value=button.querySelector(':scope > .panel-font-value');
  if (!value) { value=document.createElement('span');value.className='panel-font-value';button.replaceChildren(value,uiIcon('chevron-down')); }
  const label=size+'px';if(value.textContent!==label)value.textContent=label;
}
