import {uiIcon, setFontButton} from './ui-icons.mjs';
export const moreHint = '更多操作，也可在内容区右键';
export const menuNotice = { notice: '内容区右键可查看选区相关操作' };

// Preserve the live editor/input selection when opening a panel setting.
export function panelButton(id, label = moreHint, font = false) {
  const button = document.createElement('button'); button.type = 'button';
  if (id) button.id = id;
  button.className = font ? 'panel-font' : 'panel-more';
  button.title = label; button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
  if (font) setFontButton(button,14);
  else { button.classList.add('ui-icon-button');button.append(uiIcon('ellipsis')); }
  button.addEventListener('pointerdown', event => { if (event.button === 0) event.preventDefault(); });
  return button;
}

export function panelMenuPosition(trigger) {
  const box = trigger.getBoundingClientRect();
  return { x: Math.max(6, box.right - 250), y: box.bottom + 5, anchor:{left:box.left,right:box.right,top:box.top,bottom:box.bottom},focus: document.activeElement };
}

// Breakpoints follow each panel, including a narrow panel inside a wide window.
export function observePanelWidth(row) {
  const observer = new ResizeObserver(() => {
    const width = row.getBoundingClientRect().width;
    row.classList.toggle('panel-medium', width < 700);
    row.classList.toggle('panel-compact', width < 480);
    row.classList.toggle('panel-narrow', width < 340);
    row.classList.toggle('panel-tiny', width < 260);
  });
  observer.observe(row); return () => observer.disconnect();
}
