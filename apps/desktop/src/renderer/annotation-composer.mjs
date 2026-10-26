import {renderTagMarkdown} from './tag-markdown.mjs';
export function describeAnnotationSource({relPath = '', anchor = {}, text = '', displayLocation} = {}) {
  let location = displayLocation?.summary || displayLocation?.label || '';
  if (!location && anchor.page) location = '第 ' + anchor.page + ' 页' + (anchor.space === 'rendered-page-normalized' && Number.isFinite(anchor.x) ? '位置' : '');
  if (!location && Number.isInteger(anchor.start)) {
    const line = point => text.slice(0, point).split('\n').length;
    location = anchor.start === anchor.end ? '第 ' + line(anchor.start) + ' 行位置' : '第 ' + line(anchor.start) + '–' + line(Math.max(anchor.start,anchor.end-1)) + ' 行';
  }
  if (!location && anchor.space === 'image-normalized') location = Number.isFinite(anchor.x) ? '图片位置' : '图片区域';
  if (!location && anchor.space === 'pptx-slide-normalized') location = Number.isFinite(anchor.x) ? '幻灯片位置' : '幻灯片区域';
  return [relPath, location || '所选内容'].filter(Boolean).join(' · ');
}
export function mountAnnotationComposer({root,input}) {
  root.classList.add('annotation-composer');
  const tabs = document.createElement('div'); tabs.className = 'composer-tabs'; tabs.setAttribute('role','group'); tabs.setAttribute('aria-label','批注输入与预览');
  const edit = document.createElement('button'), preview = document.createElement('button');
  for (const button of [edit,preview]) button.type = 'button';
  edit.textContent = '输入'; preview.textContent = '预览';
  const body = document.createElement('div'); body.className = 'composer-preview tag-markdown'; body.hidden = true;
  tabs.append(edit,preview); input.before(tabs); input.after(body);
  let previewing = false, active = !input.hidden;
  function render() {
    tabs.hidden = !active; input.hidden = !active || previewing; body.hidden = !active || !previewing;
    if (!active) return;
    edit.setAttribute('aria-pressed',String(!previewing)); preview.setAttribute('aria-pressed',String(previewing));
    if (previewing) renderTagMarkdown(body,input.value || '（尚未输入）');
  }
  edit.onclick = () => {previewing = false; render(); input.focus();};
  preview.onclick = () => {previewing = true; render();};
  input.addEventListener('input',render);
  render();
  return {
    reset() {active=true;previewing=false;render();},
    hide() {active=false;previewing=false;render();},
    dispose() {input.removeEventListener('input',render);},
  };
}
