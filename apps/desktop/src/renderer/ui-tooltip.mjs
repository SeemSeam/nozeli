// One delegated tooltip controller per document (singleton per ownerDocument).
// Elements opt in by carrying a data-ui-hint attribute: setIconButton and
// setActionButton set it, and plain DOM or React code may set it directly.
// An empty data-ui-hint resolves dynamically to the element's current title
// (then aria-label) at event time, so later real rejection reasons written to
// button.title are never masked by a stale copy. The controller never touches
// title or aria-label; the only attribute it manages is aria-describedby,
// where it appends its own token on show and removes exactly that token on
// hide, preserving any other ids the caller maintains in between.
// Listeners attach once per document, so re-renders never add handlers, and
// the controller never scans the DOM or guesses element meaning. It reacts
// only to real pointer/focus events, never takes focus, closes on Escape,
// follows the anchor while scrollers move, and drops tooltips whose anchor
// is removed or disabled (no orphan bubbles).
const controllers = new WeakMap();
const HOVER_DELAY_MS = 300;
const TOOLTIP_ID = 'ui-tooltip';

export function mountUiTooltip(doc = document) {
  return controllerFor(doc);
}

export function hideUiTooltip(doc = document) {
  const state = controllers.get(doc);
  if (state) hide(state);
}

// Thin adapter for any DOM or React code: mark an element (hint text, or ''
// for dynamic title/aria resolution) or unmark it (falsy hint). Geometry
// stays in ui-icons.mjs; no path data is copied here.
export function setUiHint(element, hint) {
  if (!element) return element;
  if (hint !== undefined && hint !== null && hint !== false) element.dataset.uiHint = String(hint);
  else delete element.dataset.uiHint;
  return element;
}

function controllerFor(doc) {
  const existing = controllers.get(doc);
  if (existing) return existing;
  const state = {doc, view: doc.defaultView, tooltip: null, anchor: null, hover: null, focus: null, showTimer: 0, raf: 0};
  controllers.set(doc, state);
  const marked = node => node && typeof node.closest === 'function' ? node.closest('[data-ui-hint]') : null;
  doc.addEventListener('pointerover', event => {
    const target = marked(event.target);
    state.hover = target;
    if (!target) { if (!state.focus) hide(state); return; }
    if (state.anchor === target) return;
    schedule(state, target, HOVER_DELAY_MS);
  });
  doc.addEventListener('pointerout', event => {
    const from = marked(event.target);
    if (!from || from.contains(event.relatedTarget)) return;
    if (state.hover === from) state.hover = null;
    cancelSchedule(state);
    if (!state.focus && state.anchor === from) hide(state);
  });
  doc.addEventListener('focusin', event => {
    const target = marked(event.target);
    state.focus = target;
    if (target) show(state, target);
    // Focus moved to an unmarked control: clear the previous hint even if its
    // anchor is still hovered, so a keyboard transition never leaves it stale.
    else hide(state);
  });
  doc.addEventListener('focusout', event => {
    const from = marked(event.target);
    if (state.focus === from) state.focus = null;
    if (!state.hover && state.anchor === from) hide(state);
  });
  // Close only; the tooltip never owns focus, so Escape must not move it.
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') hide(state); });
  doc.addEventListener('pointerdown', () => hide(state));
  // Follow the anchor while any scroller moves; hiding here would also kill
  // freshly shown tooltips because appending the bubble itself can fire a
  // scroll event (scroll anchoring) on the document.
  doc.addEventListener('scroll', () => { if (state.anchor) position(state, state.anchor); }, {capture: true, passive: true});
  state.view?.addEventListener?.('resize', () => hide(state));
  return state;
}

function schedule(state, anchor, delay) {
  cancelSchedule(state);
  state.showTimer = state.view.setTimeout(() => { state.showTimer = 0; show(state, anchor); }, delay);
}

function cancelSchedule(state) {
  if (state.showTimer) { state.view.clearTimeout(state.showTimer); state.showTimer = 0; }
}

function show(state, anchor) {
  cancelSchedule(state);
  // A caller's newer title describes live routing/failure state; otherwise
  // keep the catalog's fuller hint instead of the short initial title.
  const title=anchor.title || '',changedTitle=anchor.dataset.uiHintTitle!==undefined&&title!==anchor.dataset.uiHintTitle;
  const hint = String((changedTitle&&title)||anchor.dataset.uiHint||title||anchor.getAttribute('aria-label')||'').trim();
  if (!hint || !anchor.isConnected || anchor.matches(':disabled,[aria-disabled="true"]')) return hide(state);
  if (!state.tooltip) {
    state.tooltip = state.doc.createElement('div');
    state.tooltip.id = TOOLTIP_ID;
    state.tooltip.className = 'ui-tooltip';
    state.tooltip.setAttribute('role', 'tooltip');
  }
  const tip = state.tooltip;
  if (state.anchor && state.anchor !== anchor) detach(state);
  if (tip.textContent !== hint) tip.textContent = hint;
  if (!state.anchor) {
    state.anchor = anchor;
    // Append our own token only: caller-maintained ids (e.g. live reason
    // descriptions) stay visible while this tooltip is open.
    const tokens = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!tokens.includes(TOOLTIP_ID)) tokens.push(TOOLTIP_ID);
    anchor.setAttribute('aria-describedby', tokens.join(' '));
  }
  const parent = anchor.closest('dialog[open], [popover]:popover-open') || state.doc.body;
  if (parent && tip.parentNode !== parent) parent.append(tip);
  position(state, anchor);
  watch(state);
}

function detach(state) {
  const anchor = state.anchor;
  state.anchor = null;
  if (!anchor) return;
  // Remove only this tooltip's token; keep whatever else the caller set or
  // updated while the tooltip was open (no full backup rewrite).
  const tokens = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(token => token && token !== TOOLTIP_ID);
  if (tokens.length) anchor.setAttribute('aria-describedby', tokens.join(' '));
  else anchor.removeAttribute('aria-describedby');
}

function hide(state) {
  cancelSchedule(state);
  cancelWatch(state);
  detach(state);
  if (state.tooltip) state.tooltip.remove();
}

// While visible, verify the anchor on every frame: a node removed from the
// document (or disabled by a later render) closes the tooltip immediately.
function watch(state) {
  cancelWatch(state);
  const step = () => {
    const anchor = state.anchor;
    if (!anchor) return;
    if (!anchor.isConnected || !anchor.getClientRects().length || anchor.matches(':disabled,[aria-disabled="true"]')) return hide(state);
    state.raf = state.view.requestAnimationFrame(step);
  };
  state.raf = state.view.requestAnimationFrame(step);
}

function cancelWatch(state) {
  if (state.raf) { state.view.cancelAnimationFrame(state.raf); state.raf = 0; }
}

function position(state, anchor) {
  const tip = state.tooltip, view = state.view, margin = 8, gap = 6;
  tip.style.left = '0px';
  tip.style.top = '0px';
  const box = anchor.getBoundingClientRect(), size = tip.getBoundingClientRect();
  const left = Math.max(margin, Math.min(view.innerWidth - size.width - margin, box.left + (box.width - size.width) / 2));
  const below = box.bottom + gap + size.height <= view.innerHeight - margin;
  const top = below ? box.bottom + gap : Math.max(margin, box.top - gap - size.height);
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}
