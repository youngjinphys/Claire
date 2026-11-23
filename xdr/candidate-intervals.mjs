// Offline adapters pass only independently validated, finite observations.
// Keep the stable scope ID and original display spelling while preserving the
// actual union of connected half-open validity intervals for that scope.
function mergeEvidence(entries, singlePattern) {
  const merged = { ...entries[0].candidate, evidenceAlertIds: [] };
  const evidence = new Set();
  const patterns = new Set();
  if (!singlePattern) merged.patterns = [];
  let first = Infinity;
  let last = -Infinity;
  for (const { candidate, startMs, expiresMs } of entries) {
    if (startMs < first) {
      first = startMs;
      merged.startsAt = candidate.startsAt;
    }
    if (expiresMs > last) {
      last = expiresMs;
      merged.expiresAt = candidate.expiresAt;
    }
    merged.confidence = Math.max(merged.confidence, candidate.confidence);
    for (const id of candidate.evidenceAlertIds) {
      if (singlePattern || !evidence.has(id)) merged.evidenceAlertIds.push(id);
      evidence.add(id);
    }
    if (!singlePattern) {
      for (const pattern of candidate.patterns) {
        if (!patterns.has(pattern)) merged.patterns.push(pattern);
        patterns.add(pattern);
      }
    }
  }
  return merged;
}

export function mergeCandidateIntervals(observations, { singlePattern = false } = {}) {
  const entries = observations.map((candidate, index) => ({
    candidate, index, startMs: Date.parse(candidate.startsAt), expiresMs: Date.parse(candidate.expiresAt),
  }));
  const candidate = mergeEvidence(entries, singlePattern);
  const components = [];
  for (const entry of [...entries].sort((left, right) => left.startMs - right.startMs || left.index - right.index)) {
    const previous = components.at(-1);
    if (!previous || entry.startMs > previous.expiresMs) {
      components.push({ expiresMs: entry.expiresMs, entries: [entry] });
    } else {
      previous.entries.push(entry);
      previous.expiresMs = Math.max(previous.expiresMs, entry.expiresMs);
    }
  }
  // A single connected interval retains the legacy candidate representation.
  // For separated components the outer dates/evidence are a summary, not an
  // authorization interval. Gates must select the matching component first.
  if (components.length > 1) {
    candidate.validityIntervals = components.map(component => {
      const merged = mergeEvidence(component.entries.sort((left, right) => left.index - right.index), singlePattern);
      return {
        startsAt: merged.startsAt, expiresAt: merged.expiresAt,
        evidenceAlertIds: merged.evidenceAlertIds, confidence: merged.confidence,
        ...(singlePattern ? { pattern: merged.pattern } : { patterns: merged.patterns }),
      };
    });
  }
  return candidate;
}
