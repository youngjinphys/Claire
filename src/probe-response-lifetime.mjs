// Pure response ownership for submission checks and server probes. No Node
// imports: the isolated course runner exposes only a small builtin allowlist.
export function createResponseLifetime(signal) {
  let body = null, reader = null, closed = Boolean(signal?.aborted);
  const disposed = new WeakSet();
  const discard = target => {
    if (!target || (typeof target !== 'object' && typeof target !== 'function') || disposed.has(target)) return;
    disposed.add(target);
    const release = () => { try { target.releaseLock?.(); } catch { /* A pending read can retain the lock. */ } };
    try {
      const cancelled = target.cancel();
      // Cancellation itself may never settle. Release immediately when allowed,
      // then retry after a pending read/cancellation eventually settles.
      release();
      Promise.resolve(cancelled).then(release, release);
    } catch { release(); }
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

// One deadline owns request headers, body bytes, decoding, and parsing. A fetch
// adapter or stream may ignore AbortSignal, so the public operation also races
// a timer. Timely HTTP headers remain evidence even when the body is unusable.
export async function probeResponse({ url, fetchImpl = globalThis.fetch, init = {},
  timeoutMs = 8000, consume, now = () => performance.now() }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    throw new Error('INVALID_PROBE_TIMEOUT');
  }
  const controller = new AbortController();
  const lifetime = createResponseLifetime(controller.signal);
  const deadline = now() + timeoutMs;
  let response = null, timer;
  const failed = error => ({ response, value: null, error });
  const check = () => {
    if (controller.signal.aborted || now() >= deadline) {
      controller.abort();
      throw new Error('PROBE_TIMEOUT');
    }
  };
  const stopped = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(failed('PROBE_TIMEOUT')); }, timeoutMs);
  });
  const work = async () => {
    try {
      check();
      const arrived = lifetime.response(await fetchImpl(url, { ...init, signal: controller.signal }));
      check();
      if (!arrived || !Number.isInteger(arrived.status) || arrived.status < 100 || arrived.status > 599
          || typeof arrived.headers?.get !== 'function') throw new Error('INVALID_PROBE_RESPONSE');
      response = arrived;
      const value = typeof consume === 'function'
        ? await consume(arrived, { lifetime, check }) : null;
      check();
      return { response, value, error: null };
    } catch (error) {
      return failed(error?.message === 'PROBE_TIMEOUT' ? 'PROBE_TIMEOUT' : 'PROBE_UNAVAILABLE');
    } finally { lifetime.close(); }
  };
  try {
    const result = await Promise.race([work(), stopped]);
    return controller.signal.aborted || now() >= deadline ? failed('PROBE_TIMEOUT') : result;
  } finally {
    clearTimeout(timer);
    controller.abort();
    lifetime.close();
  }
}

export async function readBoundedText(response, { lifetime, check }, {
  maxBytes = 24 * 1024, contentType,
} = {}) {
  try {
    check();
    if (contentType && !contentType.test(response.headers.get('content-type') || '')) return null;
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared)
        || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) return null;
    const reader = response.body?.getReader ? lifetime.reader(response.body.getReader()) : null;
    if (!reader) return null;
    const parts = [];
    let length = 0;
    for (;;) {
      check();
      const next = await reader.read();
      check();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) return null;
      length += next.value.byteLength;
      if (length > maxBytes) return null;
      parts.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    check();
    return text;
  } catch { return null; }
  finally { lifetime.close(); }
}

export async function readBoundedJson(response, ownership, options) {
  const text = await readBoundedText(response, ownership, options);
  if (text === null) return null;
  try {
    ownership.check();
    const value = JSON.parse(text);
    ownership.check();
    return value;
  } catch { return null; }
}
