// Layout is driven by board geometry, never execution text or token events.
export function sidebarAllocation(H, a, b) {
  if (a.M + b.M > H) return { short: true, top: Math.max(a.D, a.M), bottom: Math.max(b.D, b.M) };
  const half = H / 2;
  let top = half;
  if (a.D > half && b.D <= half) top += Math.max(0, Math.min(half - Math.max(b.D, b.M), a.D - half));
  else if (b.D > half && a.D <= half) top -= Math.max(0, Math.min(half - Math.max(a.D, a.M), b.D - half));
  top = Math.max(a.M, Math.min(H - b.M, top));
  return { short: false, top, bottom: H - top };
}

export function mountSidebarLayout(document) {
  const body = document.getElementById('sidebar-body');
  const side = document.getElementById('side');
  const edge = document.getElementById('toggle-sidebar');
  const left = document.getElementById('file-toggle');
  const panes = [body.querySelector('.inbox-panel'), body.querySelector('.workflow-panel')];
  let frame = 0, boardScroll = [0, 0, 0], previousDetail = false;
  const set = (node, property, value) => { if (node.style.getPropertyValue(property) !== value) node.style.setProperty(property, value); };
  const visible = node => node && !node.hidden && node.getClientRects().length > 0;
  function measure(pane) {
    const list = pane.querySelector('.sidebar-list');
    const css = getComputedStyle(pane);
    const padding = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom) + parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth);
    const controls = [...pane.children].filter(node => node !== list && visible(node));
    const chrome = controls.reduce((height, node) => {
      const style = getComputedStyle(node);
      return height + node.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    }, padding + (parseFloat(css.rowGap) || 0) * controls.length);
    const children = [...list.children].filter(visible);
    const origin = list.getBoundingClientRect().top;
    const bottom = node => node.getBoundingClientRect().bottom - origin + list.scrollTop + parseFloat(getComputedStyle(node).marginBottom);
    const natural = Math.max(0, ...children.map(bottom));
    const rows = pane.querySelector('#inbox-reports, #work-items');
    const first = [...rows.children].find(visible);
    const minimum = first ? bottom(first) : natural;
    return { D: Math.ceil(chrome + natural), M: Math.ceil(chrome + minimum) };
  }
  function layout() {
    frame = 0;
    if (visible(left) && visible(edge)) {
      const reference = left.getBoundingClientRect(), bounds = side.getBoundingClientRect();
      // Match the existing file handle, including native-shell/narrow geometry.
      set(edge, '--sidebar-edge-y', `${Math.round(reference.top + reference.height / 2 - bounds.top)}px`);
    }
    const detail = panes.some(pane => pane.hidden);
    if (detail) {
      previousDetail = true;
      body.style.removeProperty('--sidebar-top');body.style.removeProperty('--sidebar-bottom');
      body.classList.remove('sidebar-short');
      return;
    }
    if (!visible(body)) return;
    const restoreScroll = previousDetail;
    previousDetail = false;
    const H = body.clientHeight;
    if (!H) return;
    const allocation = sidebarAllocation(H, ...panes.map(measure));
    body.classList.toggle('sidebar-short', allocation.short);
    set(body, '--sidebar-top', `${allocation.top}px`);
    set(body, '--sidebar-bottom', `${allocation.bottom}px`);
    if (restoreScroll) {
      body.scrollTop = boardScroll[0];
      panes.forEach((pane, index) => { pane.querySelector('.sidebar-list').scrollTop = boardScroll[index + 1]; });
    }
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(layout); }
  const resize = new ResizeObserver(schedule);
  for (const node of [body, side, left.parentElement, ...panes.flatMap(pane => [...pane.children].filter(node => !node.classList.contains('sidebar-list'))), document.getElementById('inbox-reports'), document.getElementById('work-items'), document.getElementById('inbox-empty'), document.getElementById('work-empty')]) resize.observe(node);
  const rememberScroll = () => {
    if (panes.some(pane => pane.hidden) || !visible(body)) return;
    boardScroll = [body.scrollTop, ...panes.map(pane => pane.querySelector('.sidebar-list').scrollTop)];
  };
  body.addEventListener('scroll', rememberScroll, { passive: true });
  for (const pane of panes) pane.querySelector('.sidebar-list').addEventListener('scroll', rememberScroll, { passive: true });
  // Only visibility transitions affect allocation; process text is not observed.
  const mutation = new MutationObserver(schedule);
  for (const pane of panes) mutation.observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  for (const pane of panes) {
    const list = pane.querySelector('.sidebar-list');
    const content = new MutationObserver(() => {
      for (const child of list.children) resize.observe(child);
      schedule();
    });
    content.observe(list, { childList: true });
  }
  window.addEventListener('resize', schedule);
  window.addEventListener('nozeli-layout-change', schedule);
  document.fonts?.ready.then(schedule);
  document.fonts?.addEventListener('loadingdone', schedule);
  schedule();
}
