import { anchorText } from './tag-anchors.mjs';

export const userActor = Object.freeze({ id: 'user:local', kind: 'user', name: '你', mark: '你' });
export const externalActor = Object.freeze({ id: 'external:unknown', kind: 'external', name: '外部修改', mark: '外' });
export function agentActor(projectId, role, context = {}) {
  if (!['qa', 'task'].includes(role)) throw new Error('Unknown document agent role.');
  const number = role === 'qa' ? 1 : 2;
  return { id: `agent:${projectId}:${role}`, kind: 'agent' + number, name: 'Agent' + number, mark: 'A' + number, role, provider: context.provider || null, sessionId: context.sessionId || null, sessionInstance: context.sessionInstance || null };
}

// Only changed UTF-16/LF text acquires the new modifier. Exact editor changes
// preserve repeated-text identity; equal gaps retain their previous attribution.
export function changeRecord(before, after, changes, { id, actor, time, revision, beforeDigest, afterDigest, operationId = null, fingerprint = null, type = 'edit' }) {
  before = anchorText(before); after = anchorText(after);
  const edits = [];
  changes.iterChanges((from, to, newFrom, newTo) => edits.push({ from, to, newFrom, newTo, line:1+before.slice(0,from).split('\n').length-1, removed: before.slice(from, to), insert: after.slice(newFrom, newTo) }));
  return { id, actor: { ...actor }, time, revision, beforeDigest, afterDigest, operationId, fingerprint, type, edits };
}
export function mapAttribution(spans, points, changes, event) {
  const next = [];
  const gaps = [];
  changes.iterGaps((oldFrom, newFrom, length) => gaps.push({ oldFrom, newFrom, length }));
  let gapIndex = 0;
  for (const span of spans) {
    while (gapIndex < gaps.length && gaps[gapIndex].oldFrom + gaps[gapIndex].length <= span.from) gapIndex++;
    for (let i = gapIndex; i < gaps.length && gaps[i].oldFrom < span.to; i++) {
      const gap = gaps[i], start = Math.max(span.from, gap.oldFrom), end = Math.min(span.to, gap.oldFrom + gap.length);
      if (start < end) next.push({ from: gap.newFrom + start - gap.oldFrom, to: gap.newFrom + end - gap.oldFrom, eventId: span.eventId });
    }
  }
  const deleted = points.map(point => ({ ...point, from: changes.mapPos(point.from, 1) }));
  for (const edit of event.edits) {
    if (edit.newFrom < edit.newTo) next.push({ from: edit.newFrom, to: edit.newTo, eventId: event.id });
    if (edit.removed && !edit.insert) deleted.push({ from: edit.newFrom, eventId: event.id });
  }
  next.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const span of next) {
    const prior = merged.at(-1);
    if (prior?.to === span.from && prior.eventId === span.eventId) prior.to = span.to;
    else merged.push(span);
  }
  return { spans: merged, points: deleted };
}
export function publicChanges(ledger) {
  if (!ledger) return null;
  const events = new Map(ledger.events.map(event => [event.id, event]));
  const decorate = item => { const event = events.get(item.eventId); return { ...item, actor: event.actor, time: event.time, revision: event.revision, type: event.type }; };
  return { docId: ledger.docId, revision: ledger.revision, digest: ledger.digest, length: ledger.text.length, spans: ledger.spans.map(decorate), points: ledger.points.map(decorate), eventCount: ledger.events.length, lastChange: ledger.events.length ? { ...decorate({ eventId: ledger.events.at(-1).id }) } : null };
}
export function changeTitle(item) {
  const time = new Date(item.time).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return `${item.actor.name} · ${time}${item.actor.kind === 'external' ? '（检测时间）' : ''}${item.pending ? ' · 未保存' : ''}`;
}
export function lineChanges(text, attribution) {
  if (!attribution) return [];
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineAt = offset => {
    let lo = 0, hi = starts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= offset) lo = mid; else hi = mid; }
    return lo;
  };
  const lines = new Map();
  for (const item of [...attribution.spans, ...attribution.points]) {
    const first = lineAt(item.from), last = lineAt(Math.max(item.from, (item.to ?? item.from + 1) - 1));
    for (let line = first; line <= last; line++) {
      const actors = lines.get(line) || new Map(), prior = actors.get(item.actor.id);
      if (!prior || prior.revision < item.revision) actors.set(item.actor.id, item);
      lines.set(line, actors);
    }
  }
  return [...lines].map(([line, actors]) => ({ line: line + 1, from: starts[line], items: [...actors.values()].sort((a,b) => b.revision - a.revision) })).sort((a,b) => a.line - b.line);
}
