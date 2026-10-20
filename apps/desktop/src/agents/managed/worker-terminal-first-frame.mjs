// This gate observes the existing PTY's parsed screen; it never writes input,
// resizes, attaches a second terminal, or treats a provider handshake as a frame.
export function hasTerminalFirstFrame(screen) {
  return screen?.seq > 0 && screen.lines?.some(line =>
    line.some(cell => !cell.invisible && /\S/u.test(cell.text)));
}

export async function waitForTerminalFirstFrame(attachment, {signal, timeout = 30000, interval = 20} = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval <= 0)
    throw new Error('invalid first-frame deadline');
  let timer, pollTimer, wake, abort, stopped = false;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal?.reason || new Error('terminal preparation cancelled'));
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    timer = setTimeout(() => reject(new Error('native terminal first frame timed out')), timeout);
  });
  const exited = attachment.exited.then(() => {throw new Error('native terminal exited before first frame');});
  const observe = async () => {
    for (;;) {
      if (stopped || signal?.aborted) throw signal?.reason || new Error('terminal preparation cancelled');
      if (attachment.closed) throw new Error('native terminal closed before first frame');
      const screen = await attachment.snapshot();
      if (stopped || signal?.aborted) throw signal?.reason || new Error('terminal preparation cancelled');
      if (attachment.closed) throw new Error('native terminal closed before first frame');
      if (hasTerminalFirstFrame(screen)) return {attachment, screen};
      await new Promise(resolve => {wake = resolve;pollTimer = setTimeout(resolve, interval);});
    }
  };
  try {return await Promise.race([observe(), cancelled, exited]);}
  finally {
    stopped = true;
    clearTimeout(timer);clearTimeout(pollTimer);
    wake?.();
    signal?.removeEventListener('abort', abort);
  }
}

// Single-flight across controller execution and renderer attachment requests.
// pause invalidates only preparation; it preserves the native PTY and thread.
// resume is an explicit new prepare call, never an automatic replay of a job.
export function createWorkerTerminalLifecycle({attach, getAttachment, isAllowed}) {
  const flights = new Map(), connections = new Map();
  function pause(target) {
    const flight = flights.get(target);
    if (flight) {flights.delete(target);flight.abort.abort(new Error('worker preparation paused'));}
  }
  function prepare(target, options = {}) {
    if (flights.has(target)) return flights.get(target).promise;
    const abort = new AbortController(), flight = {abort};
    const check = () => {
      if (abort.signal.aborted) throw abort.signal.reason;
      if (!isAllowed(target)) throw new Error('worker no longer executable');
    };
    flight.promise = (async () => {
      check();
      const existing = getAttachment(target);
      let connection = connections.get(target);
      if ((!existing || existing.closed) && !connection) {
        connection = Promise.resolve().then(() => attach(target, options));
        connections.set(target, connection);
        connection.finally(() => {if (connections.get(target) === connection) connections.delete(target);}).catch(() => {});
      }
      const attachment = existing && !existing.closed ? existing : await connection;
      check();
      const result = await waitForTerminalFirstFrame(attachment, {...options, signal: abort.signal});
      check();
      if (getAttachment(target) !== attachment) throw new Error('native terminal replaced before execution');
      return result;
    })().finally(() => {if (flights.get(target) === flight) flights.delete(target);});
    flights.set(target, flight);
    return flight.promise;
  }
  return {prepare, resume: prepare, pause, stop() {for (const target of flights.keys()) pause(target);}};
}
