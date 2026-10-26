// Auto original reader for read-required replies: NO manual paging controls.
// Visibility drives everything — the first page loads only when the reader is
// actually on screen; further pages stream one bounded page at a time as the
// user scrolls toward either edge of the owning transcript scroller.
//
// Bounded window, no byte loss: the displayed text is a contiguous window into
// the immutable original. Scrolling far past it evicts the far edge; a ledger
// of known-valid offsets (block boundaries, plus every page boundary the host
// hands back) lets scrolling up re-read the exact same ranges — every byte
// stays reachable, memory stays bounded (WINDOW_CHARS plus one in-flight page,
// permanently; nothing is raisable).
//
// Block-safe rendering: in markdown mode BOTH window edges sit on parsed
// top-level Markdown block boundaries (eviction only advances to one; prepends
// target ledger boundaries), so paragraphs, tables, lists, math and fences are
// never cut at a display edge. Blocks may still straddle PAGE boundaries — the
// window renders as ONE markdown document, so a fence or table split across
// pages renders as a single block. A single block larger than the whole window
// budget switches that window to plain-text fidelity mode (exact characters,
// line-aligned eviction, no Markdown reinterpretation of any fence marker)
// until a boundary-aligned window fits again.
//
// Versions: the descriptor captured with the reply is the immutable authority.
// A page answering a different version is never spliced and never replaces the
// authority — the reader keeps what it holds and reports the mismatch; retry
// re-reads the SAME version until the store can serve it again.
// 完整 is claimed only while the entire original is held; otherwise the status
// honestly shows the displayed byte range.
import {markdownLanguage} from '@codemirror/lang-markdown';
import {renderTagMarkdown} from './tag-markdown.mjs';

// How far beyond the scroll clip still counts as "about to read" (px).
const LOOKAHEAD = 512;
// Displayed-window budget (chars). The reader never holds more than this plus
// one in-flight page; evicted ranges re-read on demand from the ledger.
const WINDOW_CHARS = 256 * 1024;
const PAGE_LIMIT = 65536;
const UTF8 = typeof TextEncoder === 'function' ? new TextEncoder() : null;
const byteLength = text => UTF8 ? UTF8.encode(text).length : text.length;

/** Ascending top-level block-start offsets (0 excluded, kept implicit). */
function blockStarts(text) {
  const starts = [];
  const tree = markdownLanguage.parser.parse(text);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) if (node.from > 0) starts.push(node.from);
  return starts;
}

export function makeOriginalReplyReader(read, document = globalThis.document) {
  const win = document.defaultView || globalThis;
  const root = document.createElement('span'); root.className = 'tag-original'; root.dataset.tagOriginal = '';
  const status = document.createElement('span'); status.className = 'tag-original-status'; status.setAttribute('role', 'status');
  const topSentinel = document.createElement('span'); topSentinel.className = 'tag-original-sentinel-top'; topSentinel.setAttribute('aria-hidden', 'true');
  const body = document.createElement('span'); body.className = 'tag-original-body tag-markdown';
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tag-original-retry'; retry.textContent = '重试读取原文';
  const sentinel = document.createElement('span'); sentinel.className = 'tag-original-sentinel'; sentinel.setAttribute('aria-hidden', 'true');
  root.append(status, topSentinel, body, retry, sentinel);
  status.hidden = true; retry.hidden = true; body.hidden = true;

  let descriptor = null, field = null, totalBytes = 0, completeDown = false;
  let windowText = '', startByte = 0, endByte = 0, plain = false;
  const ledger = []; // {o: byte offset, aligned: block-aligned?} refill targets below startByte
  let loading = false, failed = false, serial = 0, direction = 'down';
  let lastHeadCutBlock = -1; // block index of the latest head eviction, for scroll anchoring
  let observer = null, scroller = null, scrollListener = null, disposed = false;

  const clearFailure = () => { failed = false; delete status.dataset.state; retry.hidden = true; };
  const fail = message => {
    failed = true;
    status.hidden = false; status.dataset.state = 'error';
    status.textContent = '原文读取失败：' + (message || '未知错误');
    retry.hidden = false;
  };
  const progress = () => {
    if (completeDown && startByte === 0) { status.hidden = true; return; } // 整篇都在窗口内才视为完整
    status.hidden = false;
    status.textContent = `原文${field && field !== 'text' ? ' · ' + field : ''} · 已显示 ${startByte}–${endByte} / ${totalBytes} 字节${plain ? ' · 超长块按原文显示' : ''}`;
  };
  const render = () => {
    body.classList.toggle('tag-original-plain', plain);
    body.hidden = !windowText;
    if (!windowText) return;
    if (plain) body.textContent = windowText; // exact characters, no reinterpretation
    else renderTagMarkdown(body, windowText); // one document: page-boundary splits stay one block
  };

  const isHighSurrogate = code => code >= 0xd800 && code <= 0xdbff;
  /** Cut a leading chunk (markdown: to the FIRST boundary that brings the
   * window back within budget — keeps the most legal text, exactly one cut;
   * plain: whole lines, falling back to a surrogate-safe character cut).
   * Returns true when the window shrank. */
  const cutHead = () => {
    if (plain) {
      let cut = windowText.length - WINDOW_CHARS;
      const line = windowText.lastIndexOf('\n', cut);
      if (line > 0) cut = line + 1;
      // No newline in range: plain text has no structure to corrupt, but a
      // cut must never split a UTF-16 surrogate pair (byte accounting would
      // drift irreversibly). Retreat one char so the pair stays in the window.
      if (isHighSurrogate(windowText.charCodeAt(cut - 1))) cut -= 1;
      startByte += byteLength(windowText.slice(0, cut));
      windowText = windowText.slice(cut);
      return true;
    }
    const starts = blockStarts(windowText);
    let cut = -1, index = 0;
    for (let i = 0; i < starts.length; i++) {
      if (windowText.length - starts[i] <= WINDOW_CHARS) { cut = starts[i]; index = i; break; }
    }
    if (cut <= 0) { plain = true; return false; } // one block exceeds the whole budget
    // Byte-map every boundary inside the evicted prefix once (each character
    // encoded exactly once), so the ledger can serve any later refill target.
    let bytes = startByte, cursor = 0;
    for (let i = 0; i < index; i++) {
      const start = starts[i];
      bytes += byteLength(windowText.slice(cursor, start));
      cursor = start;
      if (ledger[ledger.length - 1]?.o !== bytes) ledger.push({ o: bytes, aligned: true });
    }
    startByte = bytes + byteLength(windowText.slice(cursor, cut));
    windowText = windowText.slice(cut);
    if (ledger[ledger.length - 1]?.o !== startByte) ledger.push({ o: startByte, aligned: true });
    lastHeadCutBlock = index; // first kept block index, for scroll anchoring
    return true;
  };
  /** Cut a trailing chunk (markdown: whole blocks, keeping the most legal
   * text; plain: whole lines with a surrogate-safe character fallback so a
   * single huge line can never grow the window unbounded). */
  const cutTail = () => {
    if (plain) {
      let cut = WINDOW_CHARS;
      const line = windowText.indexOf('\n', cut);
      if (line > 0) cut = line + 1;
      else if (isHighSurrogate(windowText.charCodeAt(cut - 1))) cut += 1; // keep the pair on the window side
      const evicted = byteLength(windowText.slice(cut));
      if (evicted <= 0) return false;
      windowText = windowText.slice(0, cut);
      endByte -= evicted;
      completeDown = false;
      return true;
    }
    const starts = blockStarts(windowText);
    let cut = -1;
    for (const start of starts) if (start <= WINDOW_CHARS) cut = start;
    if (cut <= 0) { plain = true; return false; }
    const evicted = byteLength(windowText.slice(cut));
    windowText = windowText.slice(0, cut);
    endByte -= evicted;
    completeDown = false;
    return true;
  };
  const trim = cutter => { let moved = true; while (windowText.length > WINDOW_CHARS && moved) moved = cutter(); };

  // A collapsed (display:none) reader has no boxes — never treat it as near.
  const near = node => {
    if (disposed || !root.getClientRects?.().length) return false;
    const box = node.getBoundingClientRect();
    if (scroller) {
      const clip = scroller.getBoundingClientRect();
      return box.top <= clip.bottom + LOOKAHEAD && box.bottom >= clip.top - LOOKAHEAD;
    }
    return box.top <= (win.innerHeight || 0) + LOOKAHEAD && box.bottom >= -LOOKAHEAD;
  };
  // Deterministic direction model: the reader loads ONLY at the edge its
  // direction points to. Direction starts 'down' at attach, changes ONLY on a
  // real user scroll (event delta), and an explicit retry reuses the direction
  // that failed. Pump completion, IO callbacks and attach-time evaluation may
  // only CONTINUE the same direction; at an edge's end (startByte 0 / tail
  // complete) loading simply stops until the user scrolls the other way.
  // The reader's own scroll compensations record the expected scrollTop so the
  // scroll events they generate are never mistaken for user intent.
  let lastScrollTop = null, expectedScrollTop = null;
  const onScroll = () => {
    if (!scroller) return;
    const top = scroller.scrollTop;
    const selfInduced = expectedScrollTop !== null && Math.abs(top - expectedScrollTop) <= 1;
    if (!selfInduced && lastScrollTop !== null) {
      const delta = top - lastScrollTop;
      if (delta < -1) direction = 'up';
      else if (delta > 1) direction = 'down';
    }
    lastScrollTop = top;
    expectedScrollTop = null; // one-shot: consumed by the event it explains
    schedule();
  };
  const setScrollTop = value => {
    if (!scroller) return;
    expectedScrollTop = value;
    scroller.scrollTop = value;
  };
  const choose = () => {
    if (disposed || loading || failed || !root.isConnected) return;
    if (direction === 'down') { if (!completeDown && near(sentinel)) void pump(); return; }
    if (startByte > 0 && near(topSentinel)) void pump();
  };
  // Scheduling runs synchronously: IO callbacks already arrive post-layout,
  // and a pending rAF whose callback never runs (hidden/backgrounded surface)
  // must never be able to wedge the reader with no reads at all.
  const schedule = () => { if (!disposed) choose(); };

  async function ensureDescriptor(token) {
    if (descriptor) return;
    status.hidden = false; status.textContent = '正在读取原文…';
    const entry = await read();
    if (token !== serial || !root.isConnected) return;
    descriptor = entry?.read || null;
    const fields = descriptor?.fields || [];
    if (!descriptor?.version || !fields.length) throw Error('原文读取描述不可用。');
    const pick = fields.find(item => item.field === 'text' && item.totalBytes > 0) || fields.find(item => item.totalBytes > 0) || fields[0];
    field = pick.field; totalBytes = pick.totalBytes;
  }

  async function pumpDown(token) {
    const startOffset = endByte;
    const page = await read({ version: descriptor.version, field, offset: endByte, limit: descriptor.maxBytes || PAGE_LIMIT });
    if (token !== serial || !root.isConnected) return;
    // The reply's descriptor is the immutable authority: a different version is
    // never spliced and never replaces it.
    if (page.version !== descriptor.version) throw Error('原文版本已变化；已保留已读内容，可重试同一版本。');
    // No-progress answers (empty content that does not complete, or a next
    // offset that fails to advance) are reported, never looped on.
    const next = page.nextOffset ?? null;
    const total = page.totalBytes ?? totalBytes;
    if (next !== null ? next <= startOffset : (startOffset + byteLength(page.content || '') < total)) {
      throw Error('原文分页未前进，已停止；可重试。');
    }
    windowText += page.content || '';
    endByte = next ?? total;
    totalBytes = total;
    completeDown = next == null;
    // Head eviction shifts kept content up — anchor the first kept block so
    // the viewport does not jump when far-above text is dropped.
    lastHeadCutBlock = -1;
    trim(cutHead);
    const anchor = lastHeadCutBlock >= 0 && body.children[lastHeadCutBlock] ? body.children[lastHeadCutBlock].getBoundingClientRect().top : null;
    render(); progress();
    if (anchor !== null && scroller && body.children[0]) setScrollTop(scroller.scrollTop + body.children[0].getBoundingClientRect().top - anchor);
  }

  async function pumpUp(token) {
    if (startByte <= 0) return;
    // Refills only ever start at KNOWN-VALID byte offsets — never raw
    // byte-minus-chunk guessing (the host rejects mid-character offsets).
    // Markdown windows target the nearest block-aligned ledger entry; plain
    // windows accept any recorded offset (byte-valid suffices there).
    const limit = descriptor.maxBytes || PAGE_LIMIT;
    const below = ledger.filter(entry => entry.o < startByte);
    const target = (plain ? below[below.length - 1] : [...below].reverse().find(entry => entry.aligned))?.o ?? 0;
    if (target >= startByte) return;
    const before = scroller ? { top: scroller.scrollTop, height: scroller.scrollHeight } : null;
    const batch = [];
    let offset = target, batchBytes = 0;
    while (offset < startByte) {
      const page = await read({ version: descriptor.version, field, offset, limit: Math.min(limit, startByte - offset) });
      if (token !== serial || !root.isConnected) return;
      if (page.version !== descriptor.version) throw Error('原文版本已变化；已保留已读内容，可重试同一版本。');
      const text = page.content || '';
      const end = page.nextOffset ?? page.totalBytes ?? startByte;
      if (!text || end <= offset) throw Error('原文分页无法前进。');
      batch.push(text);
      batchBytes += text.length;
      // Every page boundary the host returns is a valid future target.
      if (end < startByte && !ledger.some(entry => entry.o === end)) ledger.push({ o: end, aligned: false });
      if (end >= startByte) break;
      offset = end;
      if (batchBytes > 8 * WINDOW_CHARS) throw Error('原文分页读取过长，已停止；可重试。');
    }
    ledger.sort((a, b) => a.o - b.o);
    windowText = batch.join('') + windowText;
    startByte = target;
    trim(cutTail);
    // A boundary-aligned window whose first block now fits leaves plain mode.
    if (plain && (startByte === 0 || ledger.some(entry => entry.o === startByte && entry.aligned))) {
      const firstEnd = blockStarts(windowText)[0] ?? windowText.length;
      if (firstEnd <= WINDOW_CHARS) plain = false;
    }
    render(); progress();
    // Keep the viewport anchored: prepending grows the content above it.
    if (scroller && before) setScrollTop(before.top + (scroller.scrollHeight - before.height));
  }

  async function pump() {
    if (loading || failed || disposed || !root.isConnected) return;
    if (direction === 'down' && completeDown) return;
    if (direction === 'up' && startByte === 0) return;
    loading = true; clearFailure();
    const token = ++serial;
    try {
      await ensureDescriptor(token);
      if (token !== serial || !root.isConnected) return;
      if (direction === 'down') await pumpDown(token); else await pumpUp(token);
    } catch (error) {
      if (token === serial && root.isConnected) fail(error?.message);
    } finally {
      if (token === serial) loading = false;
    }
    schedule(); // same-direction continuation only; direction never changes here
  }

  retry.addEventListener('click', () => { clearFailure(); status.hidden = false; status.textContent = '正在读取原文…'; void pump(); });

  // Sentinels are observed against the OWNING transcript scroller, so inner
  // scrolls (not just viewport changes) drive continuation. The transcript
  // attaches each reader right after seating it (and the owning card re-runs
  // attachment once it is connected); this constructor also makes one
  // same-tick microtask attempt for direct embedders. There is deliberately
  // NO retry timer — a detached reader stays inert until its host seats it.
  // A passive scroll listener on the same scroller backs the observer up.
  let attached = false;
  const attach = () => {
    if (attached || disposed || !root.isConnected) return;
    scroller = root.closest('.tag-transcript, .snapshot-card-thread') || null;
    if (scroller) {
      lastScrollTop = scroller.scrollTop;
      scrollListener = onScroll;
      scroller.addEventListener('scroll', scrollListener, { passive: true });
    }
    if (typeof win.IntersectionObserver === 'function') {
      observer = new win.IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) schedule(); }, { root: scroller, rootMargin: LOOKAHEAD + 'px' });
      observer.observe(sentinel); observer.observe(topSentinel);
    }
    attached = true;
    schedule(); // evaluate the current geometry immediately (direction: down)
  };
  root.attach = attach;
  if (typeof win.queueMicrotask === 'function') win.queueMicrotask(attach); else win.setTimeout?.(attach, 0);

  root.dispose = () => {
    serial++; disposed = true; loading = false;
    observer?.disconnect(); observer = null;
    if (scrollListener && scroller) scroller.removeEventListener('scroll', scrollListener);
    scrollListener = null;
  };
  return root;
}
