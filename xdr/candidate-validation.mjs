import { addressIdentity } from './address-identity.mjs';

const nonemptyString = value => typeof value === 'string' && value.length > 0;

function nonemptyStringList(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    if (!nonemptyString(value[index])) return false;
  }
  return true;
}

// A finite millisecond sum can still lie outside Date's representable range.
// Preserve the requested lifetime exactly or reject it before serializing or
// mutating a grouped candidate; never clamp the deadline to the Date boundary.
export function candidateExpiry(startMs, ttlMs) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0
      || !Number.isFinite(new Date(startMs).getTime())) return null;
  const expiresMs = startMs + ttlMs;
  if (!Number.isSafeInteger(expiresMs)) return null;
  const expiry = new Date(expiresMs);
  return Number.isFinite(expiry.getTime()) ? { expiresMs, expiresAt: expiry.toISOString() } : null;
}

function evidenceInterval(rule, singlePattern) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || !Number.isFinite(rule.confidence) || rule.confidence < 0.85 || rule.confidence > 1
      || !nonemptyStringList(rule.evidenceAlertIds)
      || typeof rule.startsAt !== 'string' || typeof rule.expiresAt !== 'string') return null;
  if (singlePattern ? !nonemptyString(rule.pattern) : !nonemptyStringList(rule.patterns)) return null;
  const startsAt = Date.parse(rule.startsAt);
  const expiresAt = Date.parse(rule.expiresAt);
  return Number.isFinite(startsAt) && Number.isFinite(expiresAt) && startsAt < expiresAt
    ? { startsAt, expiresAt } : null;
}

// Shared by the offline response adapters only; judge entries stay standalone.
// A scoped candidate can have disconnected validity components. Its outer
// dates summarize them; they must never authorize the inactive time between.
function activeCandidate(rule, at, { singlePattern = false } = {}) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || !nonemptyString(rule.id) || addressIdentity(rule.sourceAddress) === null
      || !Number.isFinite(at)) return null;
  const bounds = evidenceInterval(rule, singlePattern);
  if (!bounds || at < bounds.startsAt || at >= bounds.expiresAt) return null;
  if (!('validityIntervals' in rule)) return rule;
  if (!Array.isArray(rule.validityIntervals) || rule.validityIntervals.length === 0) return null;
  const ids = new Set(rule.evidenceAlertIds);
  const coveredIds = new Set();
  const patterns = singlePattern ? null : new Set(rule.patterns);
  let previousEnd = null;
  let active = null;
  for (const interval of rule.validityIntervals) {
    const window = evidenceInterval(interval, singlePattern);
    if (!window || (previousEnd === null ? window.startsAt !== bounds.startsAt : window.startsAt <= previousEnd)
        || window.expiresAt > bounds.expiresAt || interval.confidence > rule.confidence
        || interval.evidenceAlertIds.some(id => !ids.has(id))
        || (!singlePattern && interval.patterns.some(pattern => !patterns.has(pattern)))) return null;
    previousEnd = window.expiresAt;
    for (const id of interval.evidenceAlertIds) coveredIds.add(id);
    if (window.startsAt <= at && at < window.expiresAt) active = interval;
  }
  if (previousEnd !== bounds.expiresAt || coveredIds.size !== ids.size || !active) return null;
  // Only interval evidence is projected; nested data cannot override scope,
  // attestation requirements or the stable candidate ID.
  return {
    ...rule, startsAt: active.startsAt, expiresAt: active.expiresAt,
    evidenceAlertIds: active.evidenceAlertIds, confidence: active.confidence,
    ...(singlePattern ? { pattern: active.pattern } : { patterns: active.patterns }),
  };
}

export function isActiveDenyCandidate(rule, at, options) {
  return activeCandidate(rule, at, options) !== null;
}

export function findActiveDenyCandidate(rules, at, matches, options) {
  for (const rule of rules) {
    const active = activeCandidate(rule, at, options);
    if (active && matches(active)) return active;
  }
  return null;
}
