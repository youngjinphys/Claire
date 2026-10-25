import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decide } from './decide.mjs';
import { extractAlert } from './read-alerts.mjs';

const TTL_MS = 15 * 60 * 1000;

function normalizedAgent(alert) {
  const value = alert?.agent?.name;
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(value)
    ? value : null;
}

const eventKey = (row, agentName) => agentName + '\0' + row.sourceAddress + '\0' + row.account;

// Produces offline device-quarantine *candidates* only. The Wazuh agent name is
// not an SDP deviceId; it must never be treated as an authoritative binding.
export function buildDenyCandidates(alerts, decisions) {
  if (!Array.isArray(alerts) || !Array.isArray(decisions)
      || alerts.length !== decisions.length) throw new Error('경보와 판정 건수가 다릅니다.');
  const byId = new Map(decisions.map(item => [item.alertId, item]));
  const normalSources = new Set();
  for (const alert of alerts) {
    const row = extractAlert(alert);
    if (row.sourceAddress && decide(alert).action === 'record') {
      normalSources.add(row.sourceAddress);
    }
  }
  const grouped = new Map();
  for (const alert of alerts) {
    if (!/^ps-[a-z0-9-]{1,40}$/iu.test(alert?.id ?? '')) continue;
    const proposed = byId.get(alert.id);
    const actual = decide(alert);
    if (!proposed || proposed.action !== 'block' || actual.action !== 'block'
        || proposed.alertId !== alert.id || proposed.reason !== actual.reason
        || proposed.confidence !== actual.confidence || proposed.confidence < 0.85) continue;
    const row = extractAlert(alert), agentName = normalizedAgent(alert);
    const startMs = Date.parse(row.at);
    if (!agentName || !row.sourceAddress || !row.account
        || !Number.isFinite(startMs) || !isIP(row.sourceAddress)
        || normalSources.has(row.sourceAddress)) continue;
    const key = eventKey(row, agentName);
    const expiresMs = startMs + TTL_MS;
    const previous = grouped.get(key);
    if (previous) {
      if (!previous.evidenceAlertIds.includes(alert.id)) previous.evidenceAlertIds.push(alert.id);
      if (Date.parse(previous.startsAt) > startMs) previous.startsAt = row.at;
      if (Date.parse(previous.expiresAt) < expiresMs) previous.expiresAt = new Date(expiresMs).toISOString();
      previous.confidence = Math.max(previous.confidence, actual.confidence);
      if (!previous.patterns.includes(actual.reason)) previous.patterns.push(actual.reason);
    } else {
      grouped.set(key, {
        id: 'xdr.persistence.' + createHash('sha256').update(key).digest('hex').slice(0, 16),
        agentName, sourceAddress: row.sourceAddress, account: row.account,
        startsAt: row.at, expiresAt: new Date(expiresMs).toISOString(),
        evidenceAlertIds: [alert.id], patterns: [actual.reason],
        confidence: actual.confidence, requiresVerifiedDeviceBinding: true,
        requiresEventCorrelation: true,
      });
    }
  }
  return [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
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
  const atMs = Date.parse(at);
  if (!/^[0-9a-f]{16}$/u.test(deviceId ?? '') || !isIP(sourceAddress ?? '')
      || typeof eventId !== 'string' || !/^ps-[a-z0-9-]{1,40}$/iu.test(eventId)
      || !Number.isFinite(atMs)) {
    return { action: 'pass', reason: 'invalid_trusted_context' };
  }
  const hit = rules.find(rule => rule.requiresVerifiedDeviceBinding === true
    && rule.requiresEventCorrelation === true
    && rule.agentName === agentName && rule.sourceAddress === sourceAddress
    && rule.account === account && rule.confidence >= 0.85
    && Array.isArray(rule.evidenceAlertIds) && rule.evidenceAlertIds.includes(eventId)
    && Date.parse(rule.startsAt) <= atMs && atMs < Date.parse(rule.expiresAt));
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
