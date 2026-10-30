// Only visible content invalidates a card. Anchor coordinates move independently.
export function tagProjectionContent(item) {
  return JSON.stringify({
    id:item.id, ordinal:item.ordinal, kind:item.kind, note:item.note,
    text:item.status === 'draft' ? null : item.text, status:item.status,
    reply:item.replyText, history:item.history, drift:item.anchorDrift,
    advisory:item.resolution?.advisory,locationStatus:item.resolution?.locationStatus,contentStatus:item.resolution?.contentStatus,
    replyAvailability:item.replyAvailability,
    quote:item.anchor?.quote, image:item.anchor?.imageDataUrl,
    material:item.material, information:item.information, relPath:item.relPath,
    displayLocation:item.displayLocation,
  });
}
