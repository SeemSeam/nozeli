// Official Lucide SVG definitions: https://github.com/lucide-icons/lucide
// ISC/MIT notices are retained in workspace-conversation-controls.LICENSE.
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
  terminal: ['M12 19h8', 'm4 17 6-6-6-6'],

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
  "circle-help": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"}],["path",{"d":"M12 17h.01"}]],
  "arrow-down": [["path",{"d":"M12 5v14"}],["path",{"d":"m19 12-7 7-7-7"}]],
  "ellipsis": [["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"19","cy":"12","r":"1"}],["circle",{"cx":"5","cy":"12","r":"1"}]],
  "check": [["path",{"d":"M20 6 9 17l-5-5"}]],
  settings: [['path',{d:'m9.7 4.3.6-2.3h3.4l.6 2.3 2 .9 2.1-.7 1.7 3-1.5 1.6.2 2.3 1.7 1.5-1.7 3-2.2-.5-1.9 1.3-.4 2.3h-3.5l-.5-2.3-2-1.2-2.1.5-1.7-3 1.6-1.5.1-2.3L2.7 8l1.7-3 2.2.7z'}],['circle',{cx:12,cy:11,r:3}]],
  close: ['M18 6 6 18', 'm6 6 12 12'],
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
  if (label) { button.title=label;button.setAttribute('aria-label',label); }
  return button;
}

export function setFontButton(button, size) {
  let value=button.querySelector(':scope > .panel-font-value');
  if (!value) { value=document.createElement('span');value.className='panel-font-value';button.replaceChildren(value,uiIcon('chevron-down')); }
  const label=size+'px';if(value.textContent!==label)value.textContent=label;
}
