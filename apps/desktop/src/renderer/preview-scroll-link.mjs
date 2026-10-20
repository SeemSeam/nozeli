// Programmatic scrolling must not become a new user scroll in the other pane.
export function mountPreviewScrollLink({ source, preview, enabled, fromSource, fromPreview, delay = 0, onError = () => {} }) {
  let stopped = false, serial = 0, held = 0, timer, frame = 0, leader = 'source', offset = null;
  const alive = ticket => !stopped && ticket === serial && enabled();
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
  async function write(action) {
    held++;
    try { await action(); }
    finally { await nextFrame(); await nextFrame(); held--; }
  }
  function schedule(side = leader, force = false, anchor = offset) {
    if (stopped || held && !force) return;
    leader = side; offset = side === 'source' ? anchor : null;
    if (!enabled()) return;
    const ticket = ++serial;
    clearTimeout(timer); cancelAnimationFrame(frame);
    timer = setTimeout(() => { frame = requestAnimationFrame(() => {
      frame = 0;
      if (alive(ticket)) Promise.resolve((side === 'source' ? fromSource : fromPreview)({ current: () => alive(ticket), write, offset })).catch(onError);
    }); }, delay);
  }
  // Native caret reveal can emit scroll after keyup; it must not erase the
  // exact keyboard anchor. Wheel/scrollbar gestures explicitly clear it.
  const stopSource = source.onScroll(() => schedule('source', false, offset));
  const pause = () => { serial++; clearTimeout(timer); cancelAnimationFrame(frame); frame = 0; };
  window.addEventListener('nozeli-context-menu-open', pause);
  const onPreview = () => schedule('preview', false, null);
  preview.addEventListener('scroll', onPreview, { passive: true });
  // An actual wheel/scrollbar gesture can supersede a PDF render in progress.
  const intents = [];
  for (const [node, side] of [[source.getEditorElement(), 'source'], [preview, 'preview']]) {
    const wheel = () => requestAnimationFrame(() => schedule(side, true, null));
    const start = event => {
      if (side === 'source' && !event.target.closest?.('.cm-content,.view-lines,.inputarea')) offset = null;
    };
    const end = event => {
      if (event.type === 'pointerup' && event.button !== 0) return;
      if (event.target.closest?.('.note-anchor')) return;
      requestAnimationFrame(() => {
        if(stopped)return;
        const selection = side === 'source' ? source.getSelection() : null;
        const caret = selection && selection.from === selection.to ? source.coordsAtOffset(selection.head) : null;
        const box = node.getBoundingClientRect(), content = event.type !== 'pointerup' || event.target.closest?.('.cm-content,.view-lines,.inputarea');
        // Native keyboard navigation may reveal the caret after keyup. Keep
        // its source position even while that line is outside the old viewport.
        const useCaret = selection && selection.from === selection.to && content && (event.type === 'keyup' || caret && caret.bottom > box.top && caret.top < box.bottom);
        schedule(side, true, useCaret ? selection.head : null);
      });
    };
    const key = event => { if (!event.isComposing) end(event); };
    node.addEventListener('wheel', wheel, { passive: true }); node.addEventListener('pointerdown', start, { passive: true }); node.addEventListener('pointerup', end, { passive: true });
    if(side==='source')node.addEventListener('keyup',key);
    intents.push(() => { node.removeEventListener('wheel', wheel); node.removeEventListener('pointerdown', start); node.removeEventListener('pointerup', end); node.removeEventListener('keyup',key); });
  }
  return {
    align(side = leader) { schedule(side, true); },
    alignSourceOffset(value) { schedule('source', true, value); },
    snapshot() { return { leader, offset }; },
    pageChanged() { schedule('preview'); },
    pause,
    dispose() { stopped = true; pause(); stopSource(); preview.removeEventListener('scroll', onPreview); window.removeEventListener('nozeli-context-menu-open', pause); intents.forEach(stop => stop()); },
  };
}

export function mappedHeight(points, value, input = 0) {
  const output = 1 - input, sorted = [...points].sort((a, b) => a[input] - b[input]);
  if (!sorted.length) return 0;
  if (value <= sorted[0][input]) return sorted[0][output];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (value <= b[input]) return a[output] + (b[output] - a[output]) * (value - a[input]) / Math.max(.001, b[input] - a[input]);
  }
  return sorted.at(-1)[output];
}
