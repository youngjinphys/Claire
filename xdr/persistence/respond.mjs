import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decide } from './decide.mjs';
import { extractAlert } from './read-alerts.mjs';
import { candidateExpiry, findActiveDenyCandidate } from '../candidate-validation.mjs';
import { mergeCandidateIntervals } from '../candidate-intervals.mjs';
import { addressIdentity } from '../address-identity.mjs';
import { hasNormalEvidence } from '../normal-evidence.mjs';

const TTL_MS = 15 * 60 * 1000;

function normalizedAgent(alert) {
  const value = alert?.agent?.name;
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(value)
    ? value : null;
}

// Produces offline device-quarantine *candidates* only. The Wazuh agent name is
// not an SDP deviceId; it must never be treated as an authoritative binding.
export function buildDenyCandidates(alerts, decisions) {
  if (!Array.isArray(alerts) || !Array.isArray(decisions)
      || alerts.length !== decisions.length) throw new Error('경보와 판정 건수가 다릅니다.');
  const byId = new Map(decisions.map(item => [item.alertId, item]));
  const normalSources = new Set();
  for (const alert of alerts) {
    const row = extractAlert(alert);
    const sourceIdentity = addressIdentity(row.sourceAddress);
    if (sourceIdentity && row.account && normalizedAgent(alert)
        && hasNormalEvidence('persistence', alert, row, decide(alert))) {
      normalSources.add(sourceIdentity);
    }
  }
  const grouped = new Map();
  for (const alert of alerts) {
    if (typeof alert?.id !== 'string' || !/^ps-[a-z0-9-]{1,40}$/iu.test(alert.id)) continue;
    const proposed = byId.get(alert.id);
    const actual = decide(alert);
    if (!proposed || proposed.action !== 'block' || actual.action !== 'block'
        || proposed.alertId !== alert.id || proposed.reason !== actual.reason
        || proposed.confidence !== actual.confidence || proposed.confidence < 0.85) continue;
    const row = extractAlert(alert), agentName = normalizedAgent(alert);
    const sourceIdentity = addressIdentity(row.sourceAddress);
    const startMs = Date.parse(row.at);
    if (!agentName || !sourceIdentity || !row.account
        || !Number.isFinite(startMs) || normalSources.has(sourceIdentity)) continue;
    const expiry = candidateExpiry(startMs, TTL_MS);
    if (!expiry) continue;
    const key = agentName + '\0' + sourceIdentity + '\0' + row.account;
    const observations = grouped.get(key) ?? [];
    observations.push({
      id: 'xdr.persistence.' + createHash('sha256').update(key).digest('hex').slice(0, 16),
      agentName, sourceAddress: row.sourceAddress, account: row.account,
      startsAt: row.at, expiresAt: expiry.expiresAt,
      evidenceAlertIds: [alert.id], patterns: [actual.reason],
      confidence: actual.confidence, requiresVerifiedDeviceBinding: true,
      requiresEventCorrelation: true,
    });
    grouped.set(key, observations);
  }
  return [...grouped.values()].map(observations => mergeCandidateIntervals(observations))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Only an independent additional check. Upstream deny / step_up remain intact.
// Host quarantine requires a trusted SDP-device-to-Wazuh-agent binding that
// the present engine request contract does not supply.
export function checkZTNAExtra({ upstreamDecision, trustedContext, rules }) {
  if (upstreamDecision !== 'allow') {
    return { action: 'preserve', reason: 'upstream_policy_first' };
  }
  if (trustedContext?.verifiedByServer !== true
      || trustedContext?.agentBindingVerified !== true || !Array.isArray(rules)) {
    return { action: 'pass', reason: 'missing_verified_device_binding' };
  }
  const { deviceId, agentName, sourceAddress, account, eventId, at } = trustedContext;
  const sourceIdentity = addressIdentity(sourceAddress);
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (typeof deviceId !== 'string' || !/^[0-9a-f]{16}$/u.test(deviceId)
      || !sourceIdentity
      || typeof agentName !== 'string' || !agentName || typeof account !== 'string' || !account
      || typeof eventId !== 'string' || !/^ps-[a-z0-9-]{1,40}$/iu.test(eventId)
      || !Number.isFinite(atMs)) {
    return { action: 'pass', reason: 'invalid_trusted_context' };
  }
  const hit = findActiveDenyCandidate(rules, atMs, rule => rule.requiresVerifiedDeviceBinding === true
    && rule.requiresEventCorrelation === true
    && rule.agentName === agentName && addressIdentity(rule.sourceAddress) === sourceIdentity
    && rule.account === account
    && rule.evidenceAlertIds.includes(eventId));
  return hit
    ? { action: 'deny', reason: hit.patterns[0], ruleId: hit.id }
    : { action: 'pass', reason: 'no_active_correlated_rule' };
}

export async function respondToDecisions({ root, alerts, decisions }) {
  if (!root || !Array.isArray(alerts) || !Array.isArray(decisions)
      || alerts.length !== decisions.length) throw new Error('경보와 판정 건수가 다릅니다.');
  const candidates = buildDenyCandidates(alerts, decisions);
  const dir = join(root, 'xdr', 'persistence');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'deny-rules.json'), JSON.stringify({
    schema: 'aleph.xdr.ztna-candidates.v1',
    moduleKey: 'persistence',
    mode: 'simulation_only',
    note: 'The SDP request contract does not attest a Wazuh agent ID or bind it to deviceId.',
    rules: candidates,
  }, null, 2) + '\n', 'utf8');

  const logPath = join(root, 'xdr', 'alerts.log');
  let prior = '';
  try { prior = await readFile(logPath, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const seen = new Set();
  for (const line of prior.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.moduleKey === 'persistence') seen.add(entry.alertId + '\0' + entry.action);
    } catch { /* Other module data is untrusted and must be preserved as-is. */ }
  }
  const additions = [];
  for (let i = 0; i < alerts.length; i += 1) {
    const alert = alerts[i], decision = decisions[i];
    if (!['block','alert'].includes(decision?.action)) continue;
    if (!/^ps-[a-z0-9-]{1,40}$/iu.test(alert?.id ?? '')
      || decision.alertId !== alert.id || !/^[a-z][a-z0-9_]{0,63}$/u.test(decision.reason ?? '')
      || !Number.isFinite(decision.confidence)
      || decision.confidence < (decision.action === 'block' ? 0.85 : 0.5)
      || (decision.action === 'alert' && decision.confidence >= 0.85)) {
      throw new Error('알림 판정 형식이 올바르지 않습니다.');
    }
    const actual = decide(alert);
    if (actual.action !== decision.action || actual.reason !== decision.reason
        || actual.confidence !== decision.confidence) {
      throw new Error('Wazuh 경보와 판정 결과가 불일치합니다.');
    }
    const row = extractAlert(alert);
    if (!row.at) continue;
    const key = alert.id + '\0' + decision.action;
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(JSON.stringify({
      at: row.at, moduleKey: 'persistence', alertId: alert.id,
      action: decision.action, reason: decision.reason,
    }));
  }
  if (additions.length) await appendFile(logPath, additions.join('\n') + '\n', 'utf8');
  return { candidates, logged: additions.length };
}
