// Display ordinals are local to a document/category; IDs remain durable identity.
export function tagDisplayOrdinals(notes = [], conversations = []) {
  const result = new Map();
  for (const category of [notes.filter(note => !note.projection && !note.removed), conversations.filter(tag => !tag.removed)]) {
    let ordinal = 0;
    for (const item of category) {
      if (result.has(item.id)) continue;
      result.set(item.id, ++ordinal);
    }
  }
  return result;
}
