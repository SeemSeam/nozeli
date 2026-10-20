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
