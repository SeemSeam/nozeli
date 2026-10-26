// Source coordinates come from the Markdown parser, never a search for matching words.
export function sourceLeaves(root) {
  return [...root.querySelectorAll('[data-md-from]')].filter(node => !node.querySelector('[data-md-from]') && !node.closest('.note-anchor'));
}
function sourcePoint(leaf, container, offset, end) {
  const from = Number(leaf.dataset.mdFrom), to = Number(leaf.dataset.mdTo);
  if (leaf.dataset.mdAtomic === 'true') return end ? to : from;
  const before = leaf.ownerDocument.createRange();
  before.selectNodeContents(leaf);
  before.setEnd(container, offset);
  return Math.min(to, from + before.toString().length);
}
export function markdownSelection(root, range, source) {
  if (!range || range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  if ([range.startContainer, range.endContainer].some(node => (node.nodeType === 1 ? node : node.parentElement)?.closest('.note-anchor,.conversation-copy'))) return null;
  const leaves = sourceLeaves(root).filter(node => range.intersectsNode(node));
  if (!leaves.length) return null;
  const first = leaves[0], last = leaves.at(-1);
  const start = first.contains(range.startContainer) ? sourcePoint(first, range.startContainer, range.startOffset, false) : Number(first.dataset.mdFrom);
  const end = last.contains(range.endContainer) ? sourcePoint(last, range.endContainer, range.endOffset, true) : Number(last.dataset.mdTo);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || end > source.length) return null;
  return {start, end, quote: source.slice(start, end)};
}
// A point maps through the same parser leaves as a selection; caret snapping
// alone is not enough — the pointer must sit inside the leaf's actual
// rendered line boxes, so blank chrome (padding/margins) never yields a point.
export function markdownPoint(root, x, y, source) {
  const caret = document.caretRangeFromPoint?.(x, y);
  if (!caret || !root.contains(caret.startContainer)) return null;
  const node = caret.startContainer.nodeType === 1 ? caret.startContainer : caret.startContainer.parentElement;
  if (!node || node.closest('.note-anchor,.conversation-copy')) return null;
  const leaf = node.closest('[data-md-from]');
  if (!leaf || !root.contains(leaf) || leaf.closest('.note-anchor')) return null;
  if (!hitRenderedText(leaf, x, y)) return null;
  const start = sourcePoint(leaf, caret.startContainer, caret.startOffset, false);
  if (!Number.isInteger(start) || start < 0 || start > source.length) return null;
  return { start, end: start, quote: '' };
}
// Range rects over the leaf contents are the real text line boxes (element
// padding is excluded), with a tiny slack for sub-pixel glyph edges.
function hitRenderedText(leaf, x, y) {
  const range = leaf.ownerDocument.createRange();
  range.selectNodeContents(leaf);
  const rects = range.getClientRects();
  for (const rect of rects) {
    if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) return true;
  }
  return false;
}
function domPoint(leaf, sourceOffset, end) {
  const from = Number(leaf.dataset.mdFrom), to = Number(leaf.dataset.mdTo);
  if (leaf.dataset.mdAtomic === 'true') return {node: leaf, offset: end ? leaf.childNodes.length : 0};
  let remaining = Math.max(0, Math.min(to - from, sourceOffset - from));
  const walker = leaf.ownerDocument.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
  let node, previous;
  while ((node = walker.nextNode())) {
    if (remaining <= node.length) return {node, offset: remaining};
    remaining -= node.length; previous = node;
  }
  return previous ? {node: previous, offset: previous.length} : {node: leaf, offset: 0};
}
export function markdownRange(root, anchor) {
  const leaves = sourceLeaves(root).filter(node => Number(node.dataset.mdTo) > anchor.start && Number(node.dataset.mdFrom) < anchor.end);
  if (!leaves.length) return null; // Only syntax/removed content: retain the record, don't guess a visible anchor.
  const start = domPoint(leaves[0], anchor.start, false), end = domPoint(leaves.at(-1), anchor.end, true);
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
  return range;
}
export function markdownPointRange(root, anchor) {
  if (!Number.isInteger(anchor?.start) || anchor.start !== anchor.end) return null;
  const leaf = sourceLeaves(root).find(node => Number(node.dataset.mdFrom) <= anchor.start && Number(node.dataset.mdTo) > anchor.start);
  if (!leaf) return null; // The position fell into syntax or removed content; keep the record, don't guess.
  const point = domPoint(leaf, anchor.start, false);
  const range = root.ownerDocument.createRange();
  range.setStart(point.node, point.offset); range.collapse(true);
  return range;
}
