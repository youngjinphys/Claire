import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractAlert } from './read-alerts.mjs';
import { matchStrongPattern } from './match.mjs';
import { candidateExpiry, findActiveDenyCandidate } from '../candidate-validation.mjs';
import { mergeCandidateIntervals } from '../candidate-intervals.mjs';
import { addressIdentity } from '../address-identity.mjs';

const RULE_TTL_MS = 15 * 60 * 1000;

// Candidates are scoped to source AND account. The class engine's v1 request
// has neither a verified source IP nor a verified Wazuh-account mapping.
export function buildDenyCandidates(alerts, decisions) {
  const decisionById = new Map(decisions.map((d) => [d.alertId, d]));
  const byPair = new Map();
  for (const alert of alerts) {
    if (typeof alert?.id !== 'string' || !/^bf-[a-zA-Z0-9-]{1,40}$/.test(alert.id)) continue;
    const choice = decisionById.get(alert.id);
    const evidence = matchStrongPattern(alert);
    if (!choice || choice.action !== 'block' || !Number.isFinite(choice.confidence)
      || choice.confidence < 0.85 || choice.confidence > 1
      || !evidence || choice.reason !== evidence.name
      || choice.confidence !== evidence.confidence) continue;
    const row = extractAlert(alert);
    const sourceIdentity = addressIdentity(row.sourceAddress);
    const start = Date.parse(row.at);
    if (!Number.isFinite(start) || !sourceIdentity || !row.account) continue;
    const expiry = candidateExpiry(start, RULE_TTL_MS);
    if (!expiry) continue;
    const key = sourceIdentity + '\0' + row.account;
    const observations = byPair.get(key) ?? [];
    observations.push({
      id: 'xdr.t1110.' + createHash('sha256').update(key).digest('hex').slice(0, 16),
      sourceAddress: row.sourceAddress,
      account: row.account,
      startsAt: row.at,
      expiresAt: expiry.expiresAt,
      evidenceAlertIds: [alert.id],
      pattern: evidence.name,
      confidence: evidence.confidence,
    });
    byPair.set(key, observations);
  }
  return [...byPair.values()].map(observations => mergeCandidateIntervals(observations, { singlePattern: true }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// An additive server-side check only. Never call this with browser-supplied
// source/account claims, and never change a preexisting deny or step_up to allow.
export function checkZTNAExtra({ upstreamDecision, trustedContext, rules }) {
  if (upstreamDecision !== 'allow') {
    return { action: 'preserve', reason: 'upstream_policy_first' };
  }
  if (trustedContext?.verifiedByServer !== true || !Array.isArray(rules)) {
    return { action: 'pass', reason: 'missing_trusted_context' };
  }
  const { sourceAddress, account, at } = trustedContext;
  const sourceIdentity = addressIdentity(sourceAddress);
  const now = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(now)) return { action: 'pass', reason: 'invalid_time' };
  if (!sourceIdentity || typeof account !== 'string' || !account) {
    return { action: 'pass', reason: 'invalid_trusted_context' };
  }
  const active = findActiveDenyCandidate(rules, now, rule =>
    addressIdentity(rule.sourceAddress) === sourceIdentity && rule.account === account,
  { singlePattern: true });
  return active
    ? { action: 'deny', reason: active.pattern, ruleId: active.id }
    : { action: 'pass', reason: 'no_active_scoped_rule' };
}

export async function writeIntegrationArtifacts({ root, alerts, decisions }) {
  if (!Array.isArray(alerts) || !Array.isArray(decisions)
    || alerts.length !== decisions.length) {
    throw new Error('경보와 판단 결과 건수가 일치하지 않습니다.');
  }
  const directory = join(root, 'xdr', 'brute-force');
  await mkdir(directory, { recursive: true });
  const candidates = buildDenyCandidates(alerts, decisions);
  await writeFile(join(directory, 'deny-rules.json'), JSON.stringify({
    schema: 'aleph.xdr.ztna-candidates.v1',
    mode: 'simulation_only',
    note: 'Validated server-side IP and identity mapping are unavailable in aleph.decision.v1.',
    rules: candidates,
  }, null, 2) + '\n', 'utf8');

}
