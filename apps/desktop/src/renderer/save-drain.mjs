// Close-time save draining for one renderer. Retention must capture document
// identity only after this renderer's own in-flight saves settled: a racing
// autosave flips digests and dirty flags mid-retention, reads as
// RECOVERY_CHANGED, and blocks exit behind a save that actually succeeded.
// Only renderer-started save promises are tracked — never a host flush
// receipt of this surface — so draining can never self-wait on a barrier or
// lifecycle flush.
export function createSaveDrain() {
  const pending = new Set();
  return {
    track(run) {
      pending.add(run);
      Promise.resolve(run).catch(() => {}).finally(() => pending.delete(run));
      return run;
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    size() { return pending.size; },
  };
}
