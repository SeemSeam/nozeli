// One delegated tooltip controller per document (singleton per ownerDocument).
// Elements opt in by carrying a data-ui-hint attribute: setIconButton and
// setActionButton set it, and plain DOM or React code may set it directly.
// Hints live only in data-ui-hint; title is removed on opt-in to prevent the
// browser's native bubble from duplicating the themed tooltip. Accessible
// names stay independent. aria-describedby retains all caller-owned tokens.
// Listeners attach once per document, so re-renders never add handlers, and
// the controller never scans the DOM or guesses element meaning. It reacts
// only to real pointer/focus events, never takes focus, and closes on interaction
// or anchor invalidation. The DOM owns accessibility and measurement; a trusted
// workspace host owns visuals above native content views when supported.
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

// Explicit adapter for dynamic tool state; unrelated native titles stay intact.
export function getUiHint(element) {
  return element?.dataset.uiHint ?? '';
}
export function setUiHint(element, hint) {
  if (!element) return element;
  element.removeAttribute('title');
  if (hint !== undefined && hint !== null && hint !== false) {
    element.dataset.uiHint = String(hint);
    mountUiTooltip(element.ownerDocument);
  } else delete element.dataset.uiHint;
  const state = controllers.get(element.ownerDocument);
  if (state?.anchor === element) {
    if (!hint) hide(state);
    else if (state.tooltip.textContent !== String(hint).trim()) show(state, element);
  }
  return element;
}

function controllerFor(doc) {
  const existing = controllers.get(doc);
  if (existing) return existing;
  const session = doc.defaultView?.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const state = {doc, view: doc.defaultView, session, tooltip: null, anchor: null, hover: null, focus: null, showTimer: 0, raf: 0, epoch: 0, nativeId: null, nativeSupported: null, pointerAnchor: null, suppressFocus: false};
  controllers.set(doc, state);
  const marked = node => node && typeof node.closest === 'function' ? node.closest('[data-ui-hint]') : null;
  const interactive = node => node && typeof node.closest === 'function' ? node.closest('button,[role="button"],a,input,select,textarea,[tabindex]') : null;
  doc.addEventListener('pointerover', event => {
    const target = marked(event.target);
    if (event.pointerType === 'touch') { state.hover = null; hide(state); return; }
    if (state.pointerAnchor && state.pointerAnchor !== target) { state.pointerAnchor = null; state.suppressFocus = false; }
    state.hover = target;
    if (!target) { if (!state.focus) hide(state); return; }
    if (state.anchor === target) return;
    schedule(state, target, HOVER_DELAY_MS);
  });
  doc.addEventListener('pointerout', event => {
    const from = marked(event.target) || interactive(event.target);
    if (!from || from.contains(event.relatedTarget)) return;
    if (state.pointerAnchor === from) { state.pointerAnchor = null; state.suppressFocus = false; }
    if (state.hover === from) state.hover = null;
    cancelSchedule(state);
    if (!state.focus && state.anchor === from) hide(state);
  });
  doc.addEventListener('focusin', event => {
    const target = marked(event.target);
    state.focus = target;
    if (state.suppressFocus) { hide(state); return; }
    if (target) show(state, target);
    else hide(state);
  });
  doc.addEventListener('focusout', event => {
    const from = marked(event.target);
    if (state.focus === from) state.focus = null;
    if (!state.hover && state.anchor === from) hide(state);
  });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Tab') { state.suppressFocus = false; state.pointerAnchor = null; return; }
    if (event.key === 'Enter' || event.key === ' ') hide(state);
    else if (event.key === 'Escape') hide(state);
  });
  doc.addEventListener('pointerdown', event => {
    const target = marked(event.target), focusTarget = target || interactive(event.target);
    state.pointerAnchor = focusTarget;
    state.suppressFocus = Boolean(focusTarget);
    hide(state);
  });
  doc.addEventListener('click', () => hide(state), true);
  doc.addEventListener('scroll', () => hide(state), {capture: true, passive: true});
  state.view?.addEventListener?.('resize', () => hide(state));
  state.view?.addEventListener?.('blur', () => { state.hover = state.focus = null; hide(state); });
  state.view?.addEventListener?.('pagehide', () => hide(state));
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) hide(state); });
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
  const hint = getUiHint(anchor).trim();
  if (!hint || !anchor.isConnected || anchor.matches(':disabled,[aria-disabled="true"]')) return hide(state);
  if (state.anchor === anchor && state.tooltip?.textContent === hint) return;
  hide(state);
  if (!state.tooltip) {
    state.tooltip = state.doc.createElement('div');
    state.tooltip.id = TOOLTIP_ID;
    state.tooltip.className = 'ui-tooltip';
    state.tooltip.setAttribute('role', 'tooltip');
  }
  const tip = state.tooltip;
  tip.style.opacity = '';
  tip.style.overflowWrap = 'anywhere';
  tip.style.maxHeight = 'calc(100vh - 16px)';
  tip.style.overflow = 'hidden';
  if (tip.textContent !== hint) tip.textContent = hint;
  if (!state.anchor) {
    state.anchor = anchor;
    // Append our own token only: caller-maintained ids (e.g. live reason
    // descriptions) stay visible while this tooltip is open.
    const tokens = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!tokens.includes(TOOLTIP_ID)) tokens.push(TOOLTIP_ID);
    anchor.setAttribute('aria-describedby', tokens.join(' '));
  }
  const topLayer = anchor.closest('dialog[open], [popover]:popover-open');
  const parent = topLayer || state.doc.body;
  if (parent && tip.parentNode !== parent) parent.append(tip);
  position(state, anchor);
  if (!topLayer) showNative(state, hint);
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
  hideNative(state);
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

function nativeBridge(state) {
  const view = state.view, scope = view?.__workspaceScope;
  const trustedScope = ['shell', 'detached'].includes(scope?.role) || scope?.role === 'surface' && ['document', 'conversation', 'task-process', 'terminal', 'project-terminal'].includes(scope.kind);
  return trustedScope && typeof view.nozeli?.invoke === 'function' ? view.nozeli : null;
}

function reportNativeError(state, operation, error) {
  state.view?.console?.error?.(`[ui-tooltip] ${operation} failed`, error);
}

function hideNative(state) {
  const id = state.nativeId;
  state.nativeId = null;
  if (id === null) return;
  const bridge = nativeBridge(state);
  if (!bridge) return;
  try {
    Promise.resolve(bridge.invoke('workspace.tooltip.hide', {id})).then(result => {
      if (!result?.ok && result?.error?.code !== 'UNKNOWN_OP') reportNativeError(state, 'hide', result?.error || result);
    }, error => reportNativeError(state, 'hide', error));
  } catch (error) { reportNativeError(state, 'hide', error); }
}

function showNative(state, text) {
  const bridge = nativeBridge(state);
  if (!bridge || state.nativeSupported === false) return;
  const tip = state.tooltip, box = tip.getBoundingClientRect(), style = state.view.getComputedStyle(tip);
  const anchor = state.anchor.getBoundingClientRect();
  const id = `ui-tooltip-${state.session}-${++state.epoch}`;
  state.nativeId = id;
  // Opacity, not visibility/display: keep this description in the accessibility
  // tree and measurable, without painting a second bubble during the IPC.
  tip.style.opacity = '0';
  const payload = {id, text, rect: {x:box.x, y:box.y, width:box.width, height:box.height},
    // Both rectangles use this viewport's CSS pixels: rect is the final bubble,
    // anchorRect is only the trigger boundary for host pointer-leave cleanup.
    anchorRect: {x:anchor.x, y:anchor.y, width:anchor.width, height:anchor.height},
    appearance: {background:style.backgroundColor, color:style.color, border:style.borderColor, fontSize:parseFloat(style.fontSize)}};
  const finish = result => {
    const supported = result?.ok === true && result.value?.supported === true && typeof result.value.shown === 'boolean';
    if (supported) state.nativeSupported = true;
    else if (result?.error?.code === 'UNKNOWN_OP' || result?.ok === true && result.value?.supported === false) state.nativeSupported = false;
    else reportNativeError(state, 'show', result?.error || result);
    if (state.nativeId !== id) return;
    if (!supported) {
      hideNative(state);
      tip.style.opacity = '';
    }
    // supported + shown:false is intentional host suppression (e.g. a modal),
    // never permission to paint over it with a renderer fallback.
  };
  try { Promise.resolve(bridge.invoke('workspace.tooltip.show', payload)).then(finish, error => finish({ok:false,error})); }
  catch (error) { finish({ok:false,error}); }
}

function position(state, anchor) {
  const tip = state.tooltip, view = state.view, margin = 8, gap = 6;
  tip.style.left = '0px';
  tip.style.top = '0px';
  const box = anchor.getBoundingClientRect(), size = tip.getBoundingClientRect();
  const side = anchor.dataset.uiHintPlacement === 'right';
  const preferredLeft = side ? box.right + gap : box.left + (box.width - size.width) / 2;
  const left = Math.max(margin, Math.min(view.innerWidth - size.width - margin, preferredLeft));
  const below = box.bottom + gap + size.height <= view.innerHeight - margin;
  const preferredTop = side ? box.top : below ? box.bottom + gap : box.top - gap - size.height;
  const top = Math.max(margin, Math.min(view.innerHeight - size.height - margin, preferredTop));
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}
