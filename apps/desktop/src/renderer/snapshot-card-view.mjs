// Snapshot discussion-card view migration. The legacy persisted placement was
// card.offset — a [dx,dy] pixel DISPLACEMENT from the stroke-anchored natural
// panel position — riding on the capture record. The unified view store keeps
// absolute manual placements, so the displacement is converted exactly once,
// only while the natural position is measurable and the stored view has never
// been committed (revision 0 auto). The original record is never rewritten or
// destroyed; an unmeasurable or already-migrated record stays unconsumed.

// Returns the view to mount: a manual placement derived from the legacy
// displacement when (and only when) migration is legitimate.
export function migrateLegacyCardOffset(view, legacyOffset, natural) {
  const measurable = Array.isArray(natural) && natural.length === 2 && natural.every(value => Number.isFinite(value));
  const legacy = Array.isArray(legacyOffset) && legacyOffset.length === 2 && legacyOffset.every(value => Number.isFinite(value))
    ? legacyOffset.map(value => Math.round(value))
    : null;
  if (!legacy || !measurable) return view;
  if (!view || view.schema !== 1 || view.revision !== 0 || view.placement?.mode !== 'auto') return view;
  return {...view, placement: {mode: 'manual', x: Math.round(natural[0] + legacy[0]), y: Math.round(natural[1] + legacy[1])}};
}

// Whether a legacy displacement record may be handed to the store for the
// atomic first write ({state,legacy}): only when it would actually be applied,
// so an unmeasurable record is never consumed by an auto placement.
export function consumableLegacyCardOffset(legacyOffset, natural) {
  return migrateLegacyCardOffset({schema: 1, revision: 0, placement: {mode: 'auto'}}, legacyOffset, natural).placement.mode === 'manual'
    ? (Array.isArray(legacyOffset) && legacyOffset.every(value => Number.isFinite(value)) ? legacyOffset : null)
    : null;
}

// Stable DISPLAY identity for a snapshot discussion window, carried on the
// record itself (card.windowOwnerId): minted once from the capture session
// that first opens the card, then persisted and copied verbatim through every
// save and recovery fork — forks of one record share it (placement survives
// 仅保存本地→恢复), while two independent doodles over an identical view get
// independent ids. Never derived from content: identical frozen backgrounds
// must NOT merge window identities. Purely a display field — the anchor rect,
// ink, sources and delivery identity are untouched by it.
export function cardWindowOwnerId(card, captureId) {
  if (typeof card?.windowOwnerId === 'string' && card.windowOwnerId) return card.windowOwnerId;
  return typeof captureId === 'string' && captureId ? 'snapwin-' + captureId : null;
}
