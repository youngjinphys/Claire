// Stage 9: deterministic detection of verified, pseudonymous engine events.
// The v1 contract carries ONLY { at, method, identity: { sub } }.
// A device ID, network baseline, client header, or revocation executor is
// deliberately NOT inferred from extra caller-controlled properties.
const WINDOW_MS = 10 * 60 * 1000;
const THRESHOLD = 120;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UTC_ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u;

// Projection intentionally accesses only three allowed fields. Invalid events
// are not treated as authenticated reads; secrets/contents are never retained.
function projectEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || !Object.hasOwn(event, 'at') || !Object.hasOwn(event, 'method')
    || !Object.hasOwn(event, 'identity')) return null;

  const identity = event.identity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || !Object.hasOwn(identity, 'sub') || event.method !== 'GET'
      || typeof identity.sub !== 'string' || !SUBJECT.test(identity.sub)
      || typeof event.at !== 'string') return null;

  const match = UTC_ISO.exec(event.at);
  if (!match) return null;
  const timestamp = Date.parse(event.at);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = match[1] + '.' + (match[2] ?? '').padEnd(3, '0') + 'Z';
  if (new Date(timestamp).toISOString() !== normalized) return null;
  return { timestamp, subject: identity.sub };
}

// Propose only; actual revocation, device resolution and network correlation
// belong to the verifying engine. Do not change src/decider.mjs's response.
export function detect(events) {
  if (!Array.isArray(events)) throw new TypeError('invalid_detection_events');

  const bySubject = new Map();
  for (const event of events) {
    const projected = projectEvent(event);
    if (!projected) continue;
    let times = bySubject.get(projected.subject);
    if (!times) {
      times = [];
      bySubject.set(projected.subject, times);
    }
    times.push(projected.timestamp);
  }

  let earliest = null;
  for (const [subject, times] of bySubject) {
    times.sort((a, b) => a - b);
    let first = 0;
    for (let last = 0; last < times.length; last += 1) {
      while (times[last] - times[first] > WINDOW_MS) first += 1;
      if (last - first + 1 > THRESHOLD) {
        const at = times[last];
        if (!earliest || at < earliest.at
            || (at === earliest.at && subject < earliest.subject)) {
          earliest = { at, subject };
        }
        break;
      }
    }
  }

  return earliest ? {
    action: 'propose_revocation',
    reasonCode: 'burst_read',
    subject: earliest.subject,
  } : { action: 'observe' };
}
