// Adapt the pinned editor's fixed sidebars without rebuilding its document,
// canvas, controls or Pinia stores. Popovers already live in document.body.
export function mountPptLayout(frame) {
  const doc = frame.contentDocument, win = frame.contentWindow;
  const app = doc.getElementById('app');
  if (!app) throw Error('PPTX 编辑界面尚未就绪');
  const style = doc.createElement('style');
  style.textContent = `
.nozeli-ppt-panel-controls{display:none}
.pptist-editor[data-nozeli-ppt-layout="compact"]>.nozeli-ppt-panel-controls{display:flex;align-items:center;gap:6px;box-sizing:border-box;height:36px;padding:4px 8px;border-bottom:1px solid #ddd;background:#fff;color:#333;font:13px system-ui,sans-serif}
.nozeli-ppt-panel-controls button{height:28px;padding:2px 9px;border:1px solid #ccc;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.nozeli-ppt-panel-controls button[aria-expanded="true"]{background:#eee}
.nozeli-ppt-panel-controls button:focus-visible{outline:2px solid currentColor;outline-offset:1px}
.pptist-editor[data-nozeli-ppt-layout="compact"]>.layout-content{position:relative;height:calc(100% - 36px)}
.pptist-editor[data-nozeli-ppt-layout="compact"]>.layout-content>.layout-content-center{width:100%!important;min-width:0;flex:1}
.pptist-editor[data-nozeli-ppt-layout="compact"]>.layout-content>.layout-content-left,
.pptist-editor[data-nozeli-ppt-layout="compact"]>.layout-content>.layout-content-right{position:absolute;top:0;bottom:0;height:100%;z-index:30;display:none!important;background:#fff;box-shadow:0 2px 12px #0003}
.pptist-editor[data-nozeli-ppt-layout="compact"]>.layout-content>.layout-content-left{left:0;width:min(160px,calc(100% - 16px))!important}
.pptist-editor[data-nozeli-ppt-layout="compact"]>.layout-content>.layout-content-right{right:0;width:min(260px,calc(100% - 16px))!important}
.pptist-editor[data-nozeli-ppt-layout="compact"][data-nozeli-ppt-panel="slides"]>.layout-content>.layout-content-left,
.pptist-editor[data-nozeli-ppt-layout="compact"][data-nozeli-ppt-panel="tools"]>.layout-content>.layout-content-right{display:block!important}
.pptist-editor[data-nozeli-ppt-layout="compact"] .canvas-tool{justify-content:flex-start;align-items:center;gap:8px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
.pptist-editor[data-nozeli-ppt-layout="compact"] .canvas-tool::-webkit-scrollbar{height:4px}
.pptist-editor[data-nozeli-ppt-layout="compact"] .canvas-tool>.left-handler,
.pptist-editor[data-nozeli-ppt-layout="compact"] .canvas-tool>.right-handler{display:flex!important;flex:none}
.pptist-editor[data-nozeli-ppt-layout="compact"] .canvas-tool>.add-element-handler{position:static;transform:none;flex:none}
`;
  doc.head.append(style);
  const controls = doc.createElement('nav');
  controls.className = 'nozeli-ppt-panel-controls';
  controls.setAttribute('aria-label', '幻灯片编辑面板');
  const buttons = new Map();
  let editor = null, panel = '';
  const media = win.matchMedia('(max-width: 900px)');
  function update() {
    if (!editor) return;
    editor.dataset.nozeliPptLayout = media.matches ? 'compact' : 'wide';
    editor.dataset.nozeliPptPanel = panel;
    for (const [name, button] of buttons) button.setAttribute('aria-expanded', String(media.matches && panel === name));
  }
  for (const [name, label] of [['slides', '幻灯片'], ['tools', '格式与工具']]) {
    const button = doc.createElement('button');
    button.type = 'button'; button.textContent = label; button.dataset.panel = name;
    button.setAttribute('aria-controls', 'nozeli-ppt-' + name);
    button.addEventListener('click', () => { panel = panel === name ? '' : name; update(); });
    buttons.set(name, button); controls.append(button);
  }
  function attach() {
    const next = app.querySelector(':scope > .pptist-editor');
    if (next === editor) return;
    if (editor) { delete editor.dataset.nozeliPptLayout; delete editor.dataset.nozeliPptPanel; }
    editor = next; panel = '';
    if (!editor) { controls.remove(); return; }
    editor.prepend(controls);
    for (const [name, target] of [['slides', '.layout-content-left'], ['tools', '.layout-content-right']]) {
      const node = editor.querySelector(target);
      if (node) { node.id ||= 'nozeli-ppt-' + name; buttons.get(name).setAttribute('aria-controls', node.id); }
    }
    update();
  }
  const resized = () => { panel = ''; update(); };
  const escape = event => {
    if (event.key !== 'Escape' || event.isComposing || !media.matches || !panel) return;
    if (doc.querySelector('.tippy-box[data-theme~="popover"][data-state="visible"]')) return;
    const active = doc.activeElement;
    if (!controls.contains(active) && !editor?.querySelector('.layout-content-left')?.contains(active) && !editor?.querySelector('.layout-content-right')?.contains(active)) return;
    panel = ''; update(); event.preventDefault(); event.stopImmediatePropagation();
  };
  // Editor/Screen are replaced at the app root. Do not observe every keystroke.
  const observer = new win.MutationObserver(attach);
  observer.observe(app, {childList: true});
  media.addEventListener('change', resized);
  doc.addEventListener('keydown', escape, true);
  attach();
  return () => {
    observer.disconnect(); media.removeEventListener('change', resized); doc.removeEventListener('keydown', escape, true);
    if (editor) { delete editor.dataset.nozeliPptLayout; delete editor.dataset.nozeliPptPanel; }
    controls.remove(); style.remove();
  };
}
