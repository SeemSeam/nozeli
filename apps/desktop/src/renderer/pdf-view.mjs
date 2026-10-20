import {projectDrawing} from './region-drawing.mjs';
let pdfjs;
import { makeNoteTag, makeAnchorTag } from './note-tag.mjs';
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import(new URL('./pdf.mjs', window.location.href).href);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', window.location.href).href;
  }
  return pdfjs;
}

export async function mountPdf({ parent, bytes, page, initialZoom = 1, fitViewport = null, onPage, onSelection = () => {}, noteActions = {}, tagActions = {} }) {
  let selectionAbort=null;
  parent.replaceChildren();
  parent.hidden = false;
  const workerUrl = new URL('./pdf.worker.min.mjs', window.location.href).href;
  const workerProbe = await fetch(workerUrl, { method: 'HEAD' });
  if (!workerProbe.ok) throw new Error(`PDF worker unavailable: ${workerProbe.status}`);
  const { getDocument, TextLayer } = await loadPdfjs();
  const data = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes?.data ?? bytes ?? []);
  const task = getDocument({
    data,
    cMapUrl: new URL('./cmaps/', window.location.href).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('./standard_fonts/', window.location.href).href,
    wasmUrl: new URL('./wasm/', window.location.href).href,
  });
  const document_ = await task.promise;
  const surface = document.createElement('div');
  surface.style.flexShrink = '0';
  if (fitViewport) { surface.style.width = 'max-content'; surface.style.marginInline = 'auto'; }
  parent.appendChild(surface);
  const state = { document: document_, page: Math.min(Math.max(1, page || 1), document_.numPages), disposed: false, generation: 0, zoom: initialZoom, fit:fitViewport?'page':'width', query: '', matches: [], match: -1 };
  let resizeTimer;
  let annotations = [], tags = [], regionMode = false, drawingActive=false;
  const openStates = new Map();
  function rememberExpanded() {
    const nodes = surface.querySelectorAll('.note-anchor');
    for (const node of nodes) openStates.set(node.dataset.annotation, node.querySelector('.note-index').getAttribute('aria-expanded') === 'true');
  }
  const normRect = (rect, box) => {
    const x = Math.max(0, (rect.left-box.left)/box.width), y = Math.max(0, (rect.top-box.top)/box.height);
    return [x,y,Math.max(0,Math.min(1-x,rect.width/box.width)),Math.max(0,Math.min(1-y,rect.height/box.height))];
  };
  function paintNotes() {
    const wrap = surface.querySelector('.pdf-page'); if (!wrap) return;
    rememberExpanded();
    wrap.querySelectorAll('.pdf-note-mark,.note-anchor,.region-drawing-projection').forEach(node => node.remove());
    for (const note of annotations.filter(note => note.anchor.page === state.page)) {
      const rects = note.anchor.rects || [[.025,.04,.001,.001]];
      for (const r of note.anchor.rects || []) {
        const mark = document.createElement('span'); mark.className = 'pdf-note-mark';
        Object.assign(mark.style, {left:r[0]*100+'%',top:r[1]*100+'%',width:r[2]*100+'%',height:r[3]*100+'%'}); wrap.append(mark);
      }
      projectDrawing(wrap,note.information?.drawing,rects[0]);
      const tag = makeNoteTag(note, { ...noteActions, open: id => openStates.get(id) ?? noteActions.open?.(id) }), r = rects[0];
      Object.assign(tag.style,{position:'absolute',left:r[0]*100+'%',top:r[1]*100+'%'}); wrap.append(tag);
    }
    for (const tag of tags.filter(tag => tag.anchor.page === state.page)) {
      const rect = tag.anchor.rects?.[0];
      if (!rect) continue;
      for (const r of tag.anchor.rects) { const mark = document.createElement('span'); mark.className = `pdf-note-mark tag-${tag.status === 'followup' ? 'followup' : tag.kind}`; Object.assign(mark.style, {left:r[0]*100+'%',top:r[1]*100+'%',width:r[2]*100+'%',height:r[3]*100+'%'}); wrap.append(mark); }
      projectDrawing(wrap,tag.information?.drawing||tag.drawing,rect);
      const node = makeAnchorTag({ ...tag, open: openStates.get(tag.id) ?? tag.open }, tagActions);
      Object.assign(node.style, { position:'absolute', left:rect[0]*100+'%', top:rect[1]*100+'%' });
      wrap.append(node);
      node.fitConversation?.();
    }
  }

  async function render() {
    if (state.disposed) return;
    onSelection(null);
    const generation = ++state.generation;
    const renderedPage = state.page;
    const pdfPage = await state.document.getPage(renderedPage);
    if (state.disposed || generation !== state.generation) return;
    const unit = pdfPage.getViewport({ scale: 1 });
    const sizing = fitViewport || parent.parentElement;
    const padded = fitViewport ? fitViewport.querySelector('#secondary-pdf') : parent;
    const css = getComputedStyle(padded || parent);
    const width = Math.max(1, sizing.clientWidth - parseFloat(css.paddingLeft || 0) - parseFloat(css.paddingRight || 0) - 2);
    const height = Math.max(1, sizing.clientHeight - parseFloat(css.paddingTop || 0) - parseFloat(css.paddingBottom || 0) - 2);
    const scale = state.fit==='actual' ? 1 : state.fit==='page' ? Math.min(width / unit.width, height / unit.height) : width / unit.width;
    const viewport = pdfPage.getViewport({ scale: scale * state.zoom });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    wrap.classList.toggle('region-selecting', regionMode);
    wrap.style.width = viewport.width + 'px';
    wrap.style.setProperty('--total-scale-factor', String(viewport.scale));
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = 'auto';
    wrap.appendChild(canvas);
    rememberExpanded();
    surface.replaceChildren(wrap);
    const context = canvas.getContext('2d');
    await pdfPage.render({ canvasContext: context, canvas, viewport, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] }).promise;
    if (state.disposed || generation !== state.generation) return;
    const content = await pdfPage.getTextContent();
    if (state.disposed || generation !== state.generation) return;
    const layer = document.createElement('div'); layer.className = 'textLayer'; wrap.append(layer);
    await new TextLayer({ textContentSource: content, container: layer, viewport }).render();
    const anchorFor = (rects, quote) => ({ page: renderedPage, rotation: viewport.rotation, space:'rendered-page-normalized', rects, quote });
    const readTextSelection = () => {
      if(state.disposed||generation!==state.generation)return;
      if (regionMode||drawingActive) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0).cloneRange(), boundary=document.createRange();boundary.selectNodeContents(layer);
      if(!range.intersectsNode(layer))return;
      if(range.compareBoundaryPoints(Range.START_TO_START,boundary)<0)range.setStart(boundary.startContainer,boundary.startOffset);
      if(range.compareBoundaryPoints(Range.END_TO_END,boundary)>0)range.setEnd(boundary.endContainer,boundary.endOffset);
      const box = wrap.getBoundingClientRect();
      const rects = [...range.getClientRects()].map(rect => normRect(rect,box)).filter(r => r[2]>0 && r[3]>0);
      const quote = range.toString();
      if (quote.length > 20000) { onSelection({ error: '选文超过可保存长度，未截断。' }); return; }
      if (rects.length) {
        wrap.querySelectorAll('.region-preview').forEach(node => node.remove());
        const visual = range.getBoundingClientRect();
        onSelection({ kind:'pdf-selection', viewportRect:{left:visual.left,right:visual.right,top:visual.top,bottom:visual.bottom}, anchor:anchorFor(rects,quote) });
      }
    };
    wrap.addEventListener('pointerdown',event=>{
      if(regionMode||event.button!==0||!layer.contains(event.target))return;
      selectionAbort?.abort();selectionAbort=new AbortController();
      document.addEventListener('pointerup',()=>requestAnimationFrame(readTextSelection),{once:true,signal:selectionAbort.signal});
    });
    wrap.addEventListener('pointerdown', event => {
      if (drawingActive || !regionMode || event.button !== 0 || event.target.closest('.note-anchor')) return;
      window.getSelection()?.removeAllRanges();
      wrap.querySelectorAll('.region-preview').forEach(node => node.remove());
      event.preventDefault(); wrap.setPointerCapture(event.pointerId);
      const box = wrap.getBoundingClientRect(), start = [event.clientX,event.clientY];
      const preview = document.createElement('span'); preview.className = 'region-preview'; wrap.append(preview);
      let rect;
      const draw = e => {
        const x = Math.max(box.left,Math.min(box.right,e.clientX)), y = Math.max(box.top,Math.min(box.bottom,e.clientY));
        rect = normRect({left:Math.min(start[0],x),top:Math.min(start[1],y),width:Math.abs(x-start[0]),height:Math.abs(y-start[1])},box);
        Object.assign(preview.style,{left:rect[0]*100+'%',top:rect[1]*100+'%',width:rect[2]*100+'%',height:rect[3]*100+'%'});
      };
      const cleanup = () => { if (wrap.hasPointerCapture(event.pointerId)) wrap.releasePointerCapture(event.pointerId); wrap.removeEventListener('pointermove',draw); wrap.removeEventListener('pointerup',finish); wrap.removeEventListener('pointercancel',cancel); };
      const finish = e => {
        draw(e); cleanup();
        if (!rect || rect[2]*box.width<=4 || rect[3]*box.height<=4) { preview.remove(); onSelection(null); return; }
        regionMode = false; wrap.classList.remove('region-selecting');
        const sourceCanvas = wrap.querySelector('canvas');
        let imageDataUrl = '';
        if (sourceCanvas) {
          const scaleX = sourceCanvas.width / box.width, scaleY = sourceCanvas.height / box.height;
          const crop = document.createElement('canvas');
          crop.width = Math.max(1, Math.round(rect[2] * box.width * scaleX)); crop.height = Math.max(1, Math.round(rect[3] * box.height * scaleY));
          crop.getContext('2d').drawImage(sourceCanvas, Math.round(rect[0] * box.width * scaleX), Math.round(rect[1] * box.height * scaleY), crop.width, crop.height, 0, 0, crop.width, crop.height);
          imageDataUrl = crop.toDataURL('image/png');
        }
        onSelection({kind:'pdf-region', viewportRect:{left:box.left+rect[0]*box.width,right:box.left+(rect[0]+rect[2])*box.width,top:box.top+rect[1]*box.height,bottom:box.top+(rect[1]+rect[3])*box.height},anchor:anchorFor([rect],''),material:{imageDataUrl}});
      };
      const cancel = () => { cleanup(); preview.remove(); onSelection(null); };
      wrap.addEventListener('pointermove',draw); wrap.addEventListener('pointerup',finish); wrap.addEventListener('pointercancel',cancel);
    });
    paintNotes();
    if (state.query) layer.querySelectorAll('span').forEach(span => { if (span.textContent.toLocaleLowerCase().includes(state.query)) span.classList.add('search-match'); });
    if (!state.disposed && generation === state.generation) { state.geometry = { unit, viewport, page: renderedPage }; onPage(renderedPage, state.document.numPages); }
  }

  await render();
  const sizing = fitViewport || parent.parentElement;
  const sizeKey = () => `${sizing.clientWidth}:${state.fit==='page' ? sizing.clientHeight : 0}`;
  let lastSize = sizeKey();
  const observer = new ResizeObserver(() => {
    if (lastSize === sizeKey() || state.disposed) return;
    lastSize = sizeKey(); clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { render().catch(error => { if (!state.disposed) console.warn('PDF resize:', error.message); }); }, 120);
  });
  observer.observe(sizing);
  return {
    zoomLevel: () => state.zoom,
    pageCount: () => state.document.numPages,
    current: () => state.page,
    syncPoint(fraction = .25, client = null) {
      const geometry = state.geometry, wrap = surface.querySelector('.pdf-page');
      if (!geometry || geometry.page !== state.page || !wrap) return null;
      const rect = wrap.getBoundingClientRect(), box = sizing.getBoundingClientRect();
      const x = client?.x ?? rect.left + rect.width * .3, y = client?.y ?? box.top + sizing.clientHeight * fraction;
      if (client && (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom)) return null;
      const point = geometry.viewport.convertToPdfPoint(Math.max(0, Math.min(rect.width, x - rect.left)), Math.max(0, Math.min(rect.height, y - rect.top)));
      return { page: state.page, x: point[0] - geometry.unit.viewBox[0], y: geometry.unit.viewBox[3] - point[1] };
    },
    syncClientPoint(point) {
      const geometry = state.geometry, wrap = surface.querySelector('.pdf-page');
      if (!geometry || point.page !== geometry.page || !wrap) return null;
      const pixel = geometry.viewport.convertToViewportPoint(geometry.unit.viewBox[0] + point.x, geometry.unit.viewBox[3] - point.y), box = wrap.getBoundingClientRect();
      return { x: box.left + pixel[0], y: box.top + pixel[1] };
    },
    drawingActive(value){drawingActive=value;},
    regionRect(a){const b=surface.querySelector('.pdf-page')?.getBoundingClientRect();if(!b||a.page!==state.page||a.rotation!==state.geometry?.viewport.rotation)return null;const r=a.rects[0];return {left:b.left+r[0]*b.width,top:b.top+r[1]*b.height,right:b.left+(r[0]+r[2])*b.width,bottom:b.top+(r[1]+r[3])*b.height};},
    setNotes(notes) { annotations = notes; surface.querySelectorAll('.region-preview').forEach(node => node.remove()); paintNotes(); },
    setTags(items) { tags = items; paintNotes(); },
    clearSelection() { surface.querySelectorAll('.region-preview').forEach(node => node.remove()); onSelection(null); },
    region(enabled) { regionMode = enabled; surface.querySelectorAll('.region-preview').forEach(node => node.remove()); surface.querySelector('.pdf-page')?.classList.toggle('region-selecting', enabled); onSelection(null); },
    viewState:()=>({mode:state.fit,scale:state.zoom}),
    async restoreView(value){if(['width','page','actual'].includes(value.mode))state.fit=value.mode;state.zoom=Math.max(.4,Math.min(3,Number(value.scale)||1));await render();},
    async zoom(factor) {
      if(factor===null||['width','page','actual'].includes(factor)){state.fit=factor|| (fitViewport?'page':'width');state.zoom=1;}
      else if(Number.isFinite(factor)&&factor>0)state.zoom=Math.max(.4, Math.min(3, state.zoom * factor));
      else return;
      await render();
    },
    async outline() {
      const list = [];
      async function visit(items, depth = 0) {
        for (const item of items || []) {
          const dest = typeof item.dest === 'string' ? await document_.getDestination(item.dest) : item.dest;
          if (Array.isArray(dest)) {
            const index = typeof dest[0] === 'number' ? dest[0] : await document_.getPageIndex(dest[0]);
            list.push({ title: item.title, page: index + 1, depth });
          }
          await visit(item.items, depth + 1);
        }
      }
      await visit(await document_.getOutline()); return list;
    },
    async search(query, next = false, cancelled = () => false) {
      query = query.trim().toLocaleLowerCase();
      if (query !== state.query || !next) {
        state.query = query; state.matches = []; state.match = -1;
        if (query) for (let p = 1; p <= document_.numPages; p++) {
          if (state.disposed || cancelled()) return { total: 0, index: -1, cancelled: true };
          let text;
          try { text = await (await document_.getPage(p)).getTextContent(); }
          catch (error) { if (state.disposed || cancelled()) return { total: 0, index: -1, cancelled: true }; throw error; }
          if (state.disposed || cancelled()) return { total: 0, index: -1, cancelled: true };
          if (text.items.map(item => item.str || '').join(' ').toLocaleLowerCase().includes(query)) state.matches.push(p);
        }
      }
      if (cancelled() || state.disposed) return { total: 0, index: -1, cancelled: true };
      if (state.matches.length) { state.match = (state.match + 1) % state.matches.length; state.page = state.matches[state.match]; }
      await render(); return { total: state.matches.length, index: state.match };
    },
    async go(next) {
      if (!Number.isFinite(next) || state.disposed) return state.page;
      next = Math.trunc(next);
      const pageNumber = Math.min(Math.max(1, next), state.document.numPages);
      if (pageNumber === state.page) return pageNumber;
      state.page = pageNumber;
      await render();
      return state.page;
    },
    destroy() {
      state.disposed = true;selectionAbort?.abort();
      clearTimeout(resizeTimer); observer.disconnect();
      // PDF.js 6 owns destruction on the loading task, not PDFDocumentProxy.
      task.destroy().catch(() => {});
      surface.remove();
      parent.hidden = true;
    },
  };
  }
