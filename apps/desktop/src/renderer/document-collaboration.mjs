import { ChangeSet, Text } from '@codemirror/state';

function overlaps(left, right) {
  let conflict = false;
  left.iterChangedRanges((from, to) => right.iterChangedRanges((otherFrom, otherTo) => {
    // Two insertions at the same boundary are ordered by ChangeSet.map. An
    // insertion strictly inside a replacement cannot be merged losslessly.
    if (from === to && otherFrom === otherTo) return;
    if (from === to ? from > otherFrom && from < otherTo
      : otherFrom === otherTo ? otherFrom > from && otherFrom < to
        : from < otherTo && otherFrom < to) conflict = true;
  }));
  return conflict;
}

// Both changesets use the last saved document, never a guessed text diff.
export function rebaseDocumentEvent({ before, current, transactions, event }) {
  const incoming = ChangeSet.fromJSON(event.changes);
  if (incoming.length !== before.length || incoming.apply(Text.of(before.split('\n'))).toString() !== event.text) throw new RangeError('Incoming document changes do not match their saved baseline.');
  const local = transactions.reduce((changes, next) => changes.compose(next), ChangeSet.empty(before.length));
  if (local.apply(Text.of(before.split('\n'))).toString() !== current) throw new RangeError('Local document changes do not match their saved baseline.');
  if (overlaps(incoming, local)) throw new RangeError('Incoming document changes intersect unsaved input.');
  const remote = incoming.map(local);
  const pending = local.map(incoming, true);
  return { remote, pending };
}
