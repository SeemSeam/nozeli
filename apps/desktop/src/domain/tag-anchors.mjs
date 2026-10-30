import { ChangeSet, Text } from '@codemirror/state';
import { diff } from '@codemirror/merge';

// CodeMirror's document model uses UTF-16 positions and LF line separators.
export const anchorText = text => text.replace(/\r\n?/g, '\n');
const result = (anchor, locationStatus, contentStatus, method) => ({ anchor, locationStatus, contentStatus, method });
// Position confidence is advisory for discussions, not a material-access gate.
export function anchorAdvisory(resolution, kind) {
  if (!resolution?.anchor) return '原位置未找到';
  if (kind === 'file') return null;
  return resolution.locationStatus === 'exact' && resolution.contentStatus === 'unchanged' ? null : '位置可能偏移';
}
export function validTextAnchor(anchor, text) {
  return Number.isSafeInteger(anchor?.start) && Number.isSafeInteger(anchor?.end) && anchor.start >= 0 && anchor.end > anchor.start && anchor.end <= text.length && text.slice(anchor.start, anchor.end) === anchor.quote;
}
// Zero-length anchors mark a position, not a span: quote stays empty and the
// point is only ever mapped with an explicit rule, never a guess.
export function validTextPointAnchor(anchor, text) {
  return Number.isSafeInteger(anchor?.start) && Number.isSafeInteger(anchor?.end) && anchor.start === anchor.end && anchor.start >= 0 && anchor.start <= text.length && anchor.quote === '';
}
export function mapTextPointAnchor(anchor, before, after, changes) {
  before = anchorText(before); after = anchorText(after);
  if (!validTextPointAnchor(anchor, before)) return result(null, 'unresolved', 'unknown', 'invalid-source');
  let replaced = false, leftConsumed = false, rightConsumed = false;
  changes.iterChanges((from, to) => {
    if (from < anchor.start && anchor.start < to) replaced = true;
    if (from < to && to === anchor.start) leftConsumed = true;
    if (from < to && from === anchor.start) rightConsumed = true;
  });
  // A hunk strictly containing the point, or adjacent hunks consuming the
  // characters on both sides of it, destroy the position's own text: the
  // point is orphaned rather than mapped to an arbitrary spot in the new
  // content. A hunk touching only one side keeps the boundary (half-open
  // convention, same as range anchors), and a pure insertion exactly at the
  // point maps by the recorded affinity below.
  if (replaced || (leftConsumed && rightConsumed)) return result(null, 'orphaned', 'modified', 'point-replaced');
  const start = changes.mapPos(anchor.start, 1);
  return result({ start, end: start, quote: '' }, 'exact', 'unchanged', 'transaction');
}
export function resolveTextPointAnchor(anchor, before, after) {
  before = anchorText(before); after = anchorText(after);
  if (!validTextPointAnchor(anchor, before)) return result(null, 'unresolved', 'unknown', 'invalid-source');
  if (before === after) return result({ ...anchor }, 'exact', 'unchanged', 'same-material');
  const changes = textChangeSet(before, after);
  // An external diff that inserts exactly at the point carries no affinity
  // evidence; unlike a live editor transaction it cannot pick a side, so the
  // point stays pending instead of guessing before/after the new text.
  let insertedAtPoint = false;
  changes.iterChanges((from, to) => { if (from === to && from === anchor.start) insertedAtPoint = true; });
  if (insertedAtPoint) return result(null, 'unresolved', 'unknown', 'point-ambiguous');
  const mapped = mapTextPointAnchor(anchor, before, after, changes);
  if (mapped.anchor) return mapped;
  if (mapped.method === 'point-replaced') return result(null, 'orphaned', 'modified', 'point-replaced');
  return result(null, 'unresolved', 'unknown', 'point-ambiguous');
}
export function textChangeSet(before, after, json) {
  before = anchorText(before); after = anchorText(after);
  if (json != null) {
    const changes = ChangeSet.fromJSON(json);
    if (changes.length !== before.length || changes.apply(Text.of(before.split('\n'))).toString() !== after) throw new Error('Edit mapping does not match source versions.');
    return changes;
  }
  const changes = diff(before, after, { scanLimit: 1000, timeout: 50 });
  return ChangeSet.of(changes.map(c => ({ from: c.fromA, to: c.toA, insert: after.slice(c.fromB, c.toB) })), before.length);
}
export function mapTextAnchor(anchor, before, after, changes) {
  before = anchorText(before); after = anchorText(after);
  if (!validTextAnchor(anchor, before)) return result(null, 'unresolved', 'unknown', 'invalid-source');
  let touched = false, replacement = null, removed = false;
  changes.iterChanges((from, to, newFrom, newTo) => {
    if (from < anchor.end && to > anchor.start || from === to && from > anchor.start && from < anchor.end) touched = true;
    if (from <= anchor.start && to >= anchor.end && from !== to) {
      removed = newFrom === newTo;
      replacement = { start: newFrom, end: newTo };
    }
  });
  if (removed) return result(null, 'orphaned', 'modified', 'transaction-delete');
  const start = replacement?.start ?? changes.mapPos(anchor.start, 1);
  const end = replacement?.end ?? changes.mapPos(anchor.end, -1);
  if (end <= start) return result(null, 'orphaned', 'modified', 'transaction-delete');
  return result({ ...anchor, start, end, quote: after.slice(start, end) }, 'exact', touched ? 'modified' : 'unchanged', 'transaction');
}
export function resolveTextAnchor(anchor, before, after) {
  before = anchorText(before); after = anchorText(after);
  if (!validTextAnchor(anchor, before)) return result(null, 'unresolved', 'unknown', 'invalid-source');
  if (before === after) return result({ ...anchor }, 'exact', 'unchanged', 'same-material');
  const candidates = [];
  for (let pos = after.indexOf(anchor.quote); pos !== -1; pos = after.indexOf(anchor.quote, pos + 1)) {
    candidates.push(pos);
    if (candidates.length > 1000) return result(null, 'unresolved', 'unknown', 'ambiguous-quote');
  }
  if (candidates.length === 0) return result(null, 'unresolved', 'modified', 'quote-missing');
  const prefix = before.slice(Math.max(0, anchor.start - 32), anchor.start);
  const suffix = before.slice(anchor.end, anchor.end + 32);
  const contextual = candidates.filter(pos => (!prefix || after.slice(Math.max(0, pos - prefix.length), pos) === prefix) && (!suffix || after.slice(pos + anchor.quote.length, pos + anchor.quote.length + suffix.length) === suffix));
  const picked = contextual.length === 1 ? contextual[0] : candidates.length === 1 ? candidates[0] : null;
  if (picked == null) return result(null, 'unresolved', 'unknown', 'ambiguous-quote');
  // Diff proves byte equality for the mapped span, not the identity of moved content.
  const mapped = mapTextAnchor(anchor, before, after, textChangeSet(before, after));
  const unchanged = mapped.contentStatus === 'unchanged' && mapped.anchor?.start === picked && contextual.length === 1 && Boolean(prefix || suffix);
  return result({ ...anchor, start: picked, end: picked + anchor.quote.length }, unchanged ? 'exact' : 'estimated', 'unchanged', unchanged ? 'diff-context' : 'unique-quote');
}

export function validateImageAnchor(anchor) {
  const point = p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && n >= 0 && n <= 1);
  return anchor?.coordinateSpace === 'image-normalized' && Number.isSafeInteger(anchor.imageWidth) && anchor.imageWidth > 0 && Number.isSafeInteger(anchor.imageHeight) && anchor.imageHeight > 0 && Array.isArray(anchor.polygon) && anchor.polygon.length >= 3 && anchor.polygon.length <= 1000 && anchor.polygon.every(point);
}
// Affine transform of normalized EXIF-oriented coordinates; caller must bind the
// matrix to verified before/after digests. No feature matching or semantic guess.
export function mapImageAnchor(anchor, matrix, { width, height, binding = 'region', contentChanged = false } = {}) {
  if (!validateImageAnchor(anchor) || !Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite) || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 || !['region', 'content'].includes(binding)) throw new Error('Invalid image transform.');
  const [a, b, c, d, e, f] = matrix;
  if (Math.abs(a * d - b * c) < 1e-12) throw new Error('Singular image transform.');
  if (binding === 'content' && contentChanged) return result(null, 'unresolved', 'modified', 'content-changed');
  let polygon = anchor.polygon.map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const clipped = polygon.some(p => p.some(n => n < 0 || n > 1));
  for (const [axis, limit, sign] of [[0, 0, 1], [0, 1, -1], [1, 0, 1], [1, 1, -1]]) {
    const output = [];
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length];
      const insideP = sign * (p[axis] - limit) >= 0, insideQ = sign * (q[axis] - limit) >= 0;
      if (insideP) output.push(p);
      if (insideP !== insideQ) {
        const t = (limit - p[axis]) / (q[axis] - p[axis]);
        output.push(p.map((n, j) => j === axis ? limit : n + t * (q[j] - n)));
      }
    }
    polygon = output;
  }
  const area = Math.abs(polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]; return sum + p[0] * q[1] - p[1] * q[0]; }, 0)) / 2;
  if (polygon.length < 3 || area < 1e-12) return result(null, 'orphaned', 'modified', 'image-crop');
  return { ...result({ ...anchor, polygon, imageWidth: width, imageHeight: height }, 'exact', contentChanged ? 'modified' : 'unchanged', 'affine-transform'), clipped };
}
