import './markdown-workspace.css';
import { mountPreviewScrollLink, mappedHeight } from './preview-scroll-link.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const isMarkdownPath = path => /\.(?:md|markdown)$/i.test(path || '');

// A preview is another view of the current buffer, never another editor/file.
export function mountMarkdownWorkspace({ getContext, render, saveView, layout, project }) {
  const parent = document.getElementById('reader-scroll');
  const source = document.getElementById('text-host');
  const preview = document.getElementById('text-preview');
  const divider = document.createElement('div');
  divider.id = 'markdown-divider'; divider.className = 'markdown-divider'; divider.hidden = true;
  divider.tabIndex = 0; divider.role = 'separator';
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', '调整 Markdown 源码与预览宽度');
  divider.title = '拖动调整源码与预览宽度 · 双击复位';
  const viewport = document.createElement('div');
  const syncButton = document.getElementById('markdown-sync');
  viewport.id = 'markdown-preview-scroll'; viewport.hidden = true;
  viewport.setAttribute('aria-label', 'Markdown 实时预览');
  parent.insertBefore(divider, preview.nextSibling); divider.after(viewport);
  let mode = 'edit', ratio = 50, scrollTop = 0, timer, saveTimer, dragEnd = null, frame = 0, link = null, linked = true;
  function points(adapter) {
    const text = adapter.getText(), box = viewport.getBoundingClientRect(), result = [[0, 0]];
    for (const node of preview.querySelectorAll('[data-md-block-from],.conversation-math-display[data-md-from]')) {
      const from = Number(node.dataset.mdBlockFrom ?? node.dataset.mdFrom), to = Number(node.dataset.mdBlockTo ?? node.dataset.mdTo);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > text.length) continue;
      const rect = node.getBoundingClientRect();
      result.push([adapter.getOffsetTop(from), rect.top - box.top + viewport.scrollTop]);
      result.push([adapter.getOffsetBottom(to - 1), rect.bottom - box.top + viewport.scrollTop]);
    }
    result.push([adapter.getScrollMetrics().total, viewport.scrollHeight]);
    const monotone = [];
    for (const p of result.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      const previous = monotone.at(-1);
      if (p.every(Number.isFinite) && (!previous || p[0] > previous[0] + .1 && p[1] >= previous[1])) monotone.push(p);
    }
    return monotone;
  }
  function attachLink() {
    const savedLink = link?.snapshot();
    link?.dispose(); link = null;
    syncButton.hidden = mode !== 'split'; syncButton.setAttribute('aria-pressed', String(linked));
    syncButton.title = linked ? '源码与预览按内容位置联动滚动；点击可独立滚动' : '点击恢复源码与预览联动滚动';
    const adapter = getContext().editor?.adapter;
    if (mode !== 'split' || !adapter?.onScroll) return;
    const enabled = () => mode === 'split' && linked && !getContext().composing && getContext().editor?.adapter === adapter && preview._markdownSourceText === adapter.getText();
    const move = async (fromSource, { current, write, offset }) => {
      const sourceMetrics = adapter.getScrollMetrics(), a = fromSource ? sourceMetrics : { top: viewport.scrollTop, height: viewport.clientHeight, total: viewport.scrollHeight };
      const b = fromSource ? { height: viewport.clientHeight, total: viewport.scrollHeight } : sourceMetrics;
      const maxA = Math.max(0, a.total - a.height), maxB = Math.max(0, b.total - b.height);
      const caret = fromSource && Number.isInteger(offset) ? adapter.coordsAtOffset(offset) : null;
      const fraction = caret ? clamp((caret.top - adapter.getScrollElement().getBoundingClientRect().top) / a.height, .2, .75) : .25;
      const target = caret ? clamp(mappedHeight(points(adapter), adapter.getOffsetTop(offset)) - b.height * fraction, 0, maxB) : a.top <= 1 ? 0 : a.top >= maxA - 1 ? maxB : clamp(mappedHeight(points(adapter), a.top + a.height * .25, fromSource ? 0 : 1) - b.height * .25, 0, maxB);
      if (current()) await write(() => fromSource ? viewport.scrollTop = target : adapter.setScrollTop(target));
    };
    link = mountPreviewScrollLink({ source: adapter, preview: viewport, enabled, fromSource: ctx => move(true, ctx), fromPreview: ctx => move(false, ctx) });
    if(savedLink?.offset!=null)link.alignSourceOffset(savedLink.offset);
  }
  syncButton.onclick = () => { linked = !linked; attachLink(); if (linked) link?.align('source'); void saveView(); };
  const projectLayout = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = 0; if (!preview.hidden) project(); link?.align(); });
  };
  const observer = new ResizeObserver(projectLayout);
  observer.observe(preview); observer.observe(parent);
  window.addEventListener('nozeli-layout-change', projectLayout);

  function setRatio(value) {
    ratio = clamp(value, 25, 75);
    parent.style.setProperty('--markdown-source-ratio', ratio + 'fr');
    parent.style.setProperty('--markdown-preview-ratio', (100 - ratio) + 'fr');
    divider.setAttribute('aria-valuemin', '25'); divider.setAttribute('aria-valuemax', '75');
    divider.setAttribute('aria-valuenow', String(Math.round(ratio)));
    layout();
  }
  function cancelPending() { clearTimeout(timer); clearTimeout(saveTimer); cancelAnimationFrame(frame); frame = 0; link?.pause(); }
  function refresh() {
    clearTimeout(timer);
    const context = getContext();
    if (!context.editor || !isMarkdownPath(context.file?.relPath) || mode !== 'split' || context.composing) return;
    const top = viewport.scrollTop;
    render(context.editor.adapter.getText());
    viewport.scrollTop = top;
    link?.align();
  }
  function changed() {
    clearTimeout(timer);
    const { file, project, composing } = getContext();
    if (mode !== 'split' || composing) return;
    timer = setTimeout(() => {
      const next = getContext();
      if (next.file === file && next.project === project) refresh();
    }, 180);
  }
  function setMode(value) {
    cancelPending(); dragEnd?.();
    if (mode === 'split') scrollTop = viewport.scrollTop;
    else if (mode === 'read') scrollTop = parent.scrollTop;
    const previous = mode; mode = value;
    parent.classList.toggle('markdown-split', mode === 'split');
    divider.hidden = viewport.hidden = mode !== 'split';
    if (mode === 'split') {
      viewport.append(preview); parent.scrollTop = parent.scrollLeft = 0;
      setRatio(ratio); viewport.scrollTop = scrollTop;
    } else {
      // Keep the established full-width reading surface and its scroll owner.
      if (preview.parentElement !== parent) parent.insertBefore(preview, divider);
      if (mode === 'read' && previous === 'split') parent.scrollTop = scrollTop;
      layout();
    }
    attachLink();
  }
  viewport.addEventListener('scroll', () => {
    if (mode !== 'split') return;
    scrollTop = viewport.scrollTop; clearTimeout(saveTimer);
    const { file, project } = getContext();
    saveTimer = setTimeout(() => {
      const next = getContext();
      if (next.file === file && next.project === project) void saveView();
    }, 300);
  }, { passive: true });
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || mode !== 'split') return;
    event.preventDefault(); divider.focus(); divider.setPointerCapture(event.pointerId);
    document.body.classList.add('panel-dragging');
    const initialRatio = ratio, origin = event.clientX, width = parent.clientWidth - divider.offsetWidth;
    const move = e => setRatio(initialRatio + (e.clientX - origin) / Math.max(1, width) * 100);
    const end = () => {
      if (!dragEnd) return;
      dragEnd = null;
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', end); divider.removeEventListener('pointercancel', end);
      divider.removeEventListener('lostpointercapture', end);
      document.body.classList.remove('panel-dragging');
      if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
      void saveView();
    };
    dragEnd = end;
    divider.addEventListener('pointermove', move);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) divider.addEventListener(name, end);
  });
  divider.addEventListener('dblclick', () => { setRatio(50); void saveView(); });
  divider.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault(); setRatio(event.key === 'Home' ? 50 : ratio + (event.key === 'ArrowLeft' ? -2 : 2)); void saveView();
  });
  return {
    changed, refresh, setMode, composing: cancelPending,
    layoutChanged() { link?.align(); },
    restoreScroll() { if (mode === 'split') { viewport.scrollTop = scrollTop; link?.align('source'); } else if (mode === 'read') parent.scrollTop = scrollTop; },
    snapshot: () => ({ ratio, linked, scrollTop: mode === 'split' ? viewport.scrollTop : mode === 'read' ? parent.scrollTop : scrollTop }),
    restore(view) { linked = view?.linked !== false; ratio = Number.isFinite(view?.ratio) ? clamp(view.ratio, 25, 75) : 50; scrollTop = Number.isFinite(view?.scrollTop) ? Math.max(0, view.scrollTop) : 0; },
    leave() { cancelPending(); dragEnd?.(); setMode('edit'); ratio = 50; scrollTop = 0; linked = true; },
    selectionViewport: () => mode === 'split' ? (getContext().textSelectionSurface === 'preview' ? viewport : source) : parent,
  };
}
