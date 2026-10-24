const MAX_PNG_BYTES = 8 * 1024 * 1024;

/** Append a persisted host receipt, never a replacement composer snapshot.
 * Delivery tombstones survive removal/send so replay cannot resurrect a chip. */
export function appendDrawingMaterial(materials, delivery) {
  if (delivery?.type !== 'drawing-material' || delivery.target !== 'frontdesk' || typeof delivery.projectId !== 'string' || !delivery.projectId || typeof delivery.deliveryId !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(delivery.deliveryId)) throw Error('涂鸦交接身份无效');
  const a = delivery.attachment;
  if (!a || a.mime !== 'image/png' || a.kind !== 'image' || a.source !== 'drawing' || !/^[a-f0-9]{64}$/.test(a.digest) || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > MAX_PNG_BYTES || typeof a.name !== 'string' || !a.name || a.name.length > 255 || /[\\/\x00-\x1f]/.test(a.name)) throw Error('涂鸦附件无效');
  const deliveries = Array.isArray(materials?.deliveredDrawingIds) ? materials.deliveredDrawingIds : [];
  if (deliveries.includes(delivery.deliveryId)) return materials;
  const pending = Array.isArray(materials?.pending) ? materials.pending : [];
  const entry = { key: 'drawing-' + delivery.deliveryId, deliveryId: delivery.deliveryId, name: a.name, mime: a.mime, size: a.size, digest: a.digest, kind: 'image', source: 'drawing', status: 'ok', sources: Array.isArray(delivery.sources) ? structuredClone(delivery.sources) : [] };
  return { ...materials, pending: [...pending, entry], quote: materials?.quote ?? null, deliveredDrawingIds: [...deliveries, delivery.deliveryId] };
}

/** A stale renderer may not have observed a durable delivery yet. Preserve its
 * edits, adding only unseen host receipts; seen-but-removed chips stay removed. */
export function mergeDrawingMaterials(incoming, hostSaved) {
  const pending = Array.isArray(incoming?.pending) ? incoming.pending : [];
  const seen = new Set(incoming?.deliveredDrawingIds || []);
  const identity = a => a.deliveryId || (a.source === 'drawing' && a.key?.startsWith('drawing-') ? a.key.slice(8) : null);
  for (const entry of pending) { const id = identity(entry); if (id) seen.add(id); }
  const additions = [];
  for (const entry of hostSaved?.pending || []) {
    const id = identity(entry);
    if (entry.source === 'drawing' && id && !seen.has(id)) { additions.push(entry); seen.add(id); }
  }
  return { ...incoming, pending: [...pending, ...additions], quote: incoming?.quote ?? null, deliveredDrawingIds: [...new Set([...seen, ...(hostSaved?.deliveredDrawingIds || [])])] };
}
