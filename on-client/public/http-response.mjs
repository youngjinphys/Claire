// Response ownership shared by browser and Node transports. Cleanup is best
// effort and never awaited: an uncooperative stream cannot extend a deadline.
export function createResponseLifetime(signal) {
  let body = null, reader = null, closed = Boolean(signal?.aborted);
  const disposed = new WeakSet();
  const discard = target => {
    if (!target || (typeof target !== 'object' && typeof target !== 'function') || disposed.has(target)) return;
    disposed.add(target);
    const release = () => { try { target.releaseLock?.(); } catch { /* A pending read may still own the lock. */ } };
    try {
      const pending = target.cancel();
      // Releasing ownership must not wait for an uncooperative underlying
      // cancellation promise. Retry after settlement if a pending read held it.
      release();
      Promise.resolve(pending).then(release, release);
    }
    catch { release(); }
  };
  const close = () => {
    closed = true;
    signal?.removeEventListener('abort', close);
    discard(reader || body);
  };
  if (!closed) signal?.addEventListener('abort', close, { once: true });
  return Object.freeze({
    response(value) {
      body = value?.body ?? null;
      if (closed || signal?.aborted) discard(body);
      return value;
    },
    reader(value) {
      reader = value;
      if (closed || signal?.aborted) discard(reader);
      return value;
    },
    close,
  });
}
