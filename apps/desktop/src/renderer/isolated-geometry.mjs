// Geometry acknowledgements are serialized; only the latest waiting rectangle survives.
export function createGeometryQueue({send, current, onError}) {
  let active = null, pending = null, applied = null, sequence = 0, disposed = false;
  const waiters = [];
  const stamp = value => JSON.stringify(value);
  function settle(error) {
    for (const waiter of waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve();
  }
  async function drain() {
    if (active || !pending || disposed) return;
    const next = pending; pending = null; active = next;
    try {
      const result = await send({...next.value, boundsSequence: ++sequence});
      if (disposed) return;
      if (stamp(current()) !== next.epoch) throw Error('预览布局归属已变化；请重新核对窗口。');
      if (!result.ok || result.value?.stale || result.value?.applied !== true || result.value.boundsSequence !== sequence || result.value.windowId !== next.value.windowId || result.value.surfaceGeneration !== next.value.surfaceGeneration) throw Error(result.error?.message || '预览布局回执过期或序号不匹配。');
      applied = next.signature;
    } catch (error) {
      applied = null; pending = null; onError(error); settle(error);
    } finally {
      active = null;
      if (!disposed && pending) void drain();
      else if (!disposed) settle();
    }
  }
  return {
    request(bounds) {
      if (disposed) return Promise.reject(Error('预览已关闭。'));
      const owner = current(), value = {...owner, bounds}, signature = stamp(value);
      if (active?.signature !== signature) pending = signature === applied && !active ? null : {value, signature, epoch: stamp(owner)};
      else pending = null;
      if (!active && !pending) return Promise.resolve();
      const promise = new Promise((resolve, reject) => waiters.push({resolve, reject}));
      void drain(); return promise;
    },
    reset(bounds) { applied = bounds ? stamp({...current(), bounds}) : null; },
    dispose() { disposed = true; pending = null; settle(Error('预览已关闭。')); }
  };
}
