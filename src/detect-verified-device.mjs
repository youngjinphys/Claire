// Optional stage-9 extension. NOT part of docs/DETECT_EVENTS.md v1.
// Never accept browser headers or unverified device/network claims as evidence.
// An operating engine must supply a trusted verifier callback for every event.
const WINDOW_MS = 10 * 60 * 1000;
const THRESHOLD = 120;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEVICE = /^[a-f0-9]{16}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

const observe = () => ({ action: 'observe' });

// The callback must return an independently verified, minimal projection:
// { at, method, subject, deviceId, decision, networkBaselineVerified,
//   networkDeviation }. Only these fields are read. No content or tokens.
function projectTrusted(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.at !== 'string' || !UTC.test(value.at)
      || value.method !== 'GET' || value.decision !== 'allow'
      || typeof value.subject !== 'string' || !SUBJECT.test(value.subject)
      || typeof value.deviceId !== 'string' || !DEVICE.test(value.deviceId)
      || value.networkBaselineVerified !== true
      || value.networkDeviation !== 'unusual') return null;
  const timestamp = Date.parse(value.at);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.at) return null;
  return { timestamp, subject: value.subject, deviceId: value.deviceId };
}

export function detectVerifiedDeviceAnomaly(events, { verifyEngineEvent } = {}) {
  if (!Array.isArray(events)) throw new TypeError('invalid_detection_events');
  if (typeof verifyEngineEvent !== 'function') return observe();

  const buckets = new Map();
  for (const raw of events) {
    let verified;
    try { verified = verifyEngineEvent(raw); } catch { continue; }
    const row = projectTrusted(verified);
    if (!row) continue;
    const key = row.subject + '\0' + row.deviceId;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row.timestamp);
  }

  let earliest = null;
  for (const [key, times] of buckets) {
    times.sort((a, b) => a - b);
    let first = 0;
    for (let last = 0; last < times.length; last += 1) {
      while (times[last] - times[first] > WINDOW_MS) first++;
      if (last - first + 1 > THRESHOLD) {
        const [subject, deviceId] = key.split('\0');
        const at = times[last];
        if (!earliest || at < earliest.at || at === earliest.at
          && (subject < earliest.subject || subject === earliest.subject
            && deviceId < earliest.deviceId)) {
          earliest = { at, subject, deviceId };
        }
        break;
      }
    }
  }
  return earliest
    ? { action: 'propose_revocation', reasonCode: 'unusual_network_burst',
        subject: earliest.subject, deviceId: earliest.deviceId }
    : observe();
}
