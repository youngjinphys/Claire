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

function validWazuhId(value) {
  return typeof value === 'string' && /^pv-[a-z0-9-]{1,40}$/iu.test(value);
}

// Off-line deny/revocation *candidates* only; Wazuh usernames are NOT SDP subjectIds.
// Correlation must happen in a trusted server component, never by a browser claim.
export function buildDenyCandidates(alerts, decisions) {
  if (!Array.isArray(alerts) || !Array.isArray(decisions)
      || alerts.length !== decisions.length) {
    throw new Error('경보와 판정 결과 건수가 다릅니다.');
  }
  const decisionMap = new Map(decisions.map(d => [d.alertId, d]));
  const normalSources = new Set();
  for (const alert of alerts) {
    const row = extractAlert(alert);
    if (row.sourceAddress && decide(alert).action === 'record') {
      normalSources.add(row.sourceAddress);
    }
  }
  const candidates = new Map();
  for (const alert of alerts) {
    if (!validWazuhId(alert?.id)) continue;
    const proposal = decisionMap.get(alert.id);
    const verified = decide(alert);
    if (!proposal || proposal.alertId !== alert.id || proposal.action !== 'block'
        || proposal.confidence !== verified.confidence
        || proposal.reason !== verified.reason || verified.action !== 'block'
        || verified.confidence < 0.85) continue;

    const row = extractAlert(alert);
    const agent = normalizedAgent(alert);
    const occurredAt = Date.parse(row.at);
    if (!agent || !row.sourceAddress || !row.account
        || !isIP(row.sourceAddress) || !Number.isFinite(occurredAt)
        || normalSources.has(row.sourceAddress)) continue;

    const scopedKey = agent + '\0' + row.sourceAddress + '\0' + row.account;
    const existing = candidates.get(scopedKey);
    const expiry = occurredAt + TTL_MS;
    if (existing) {
      if (!existing.evidenceAlertIds.includes(alert.id)) existing.evidenceAlertIds.push(alert.id);
      if (Date.parse(existing.startsAt) > occurredAt) existing.startsAt = row.at;
      if (Date.parse(existing.expiresAt) < expiry) existing.expiresAt = new Date(expiry).toISOString();
      existing.confidence = Math.max(existing.confidence, verified.confidence);
      if (!existing.patterns.includes(verified.reason)) existing.patterns.push(verified.reason);
    } else {
      candidates.set(scopedKey, {
        id: 'xdr.privilege.' + createHash('sha256').update(scopedKey).digest('hex').slice(0, 16),
        agentName: agent, sourceAddress: row.sourceAddress, account: row.account,
        startsAt: row.at, expiresAt: new Date(expiry).toISOString(),
        evidenceAlertIds: [alert.id], patterns: [verified.reason],
        confidence: verified.confidence,
        requiresVerifiedSubjectBinding: true,
        requiresVerifiedSessionBinding: true,
        requiresEventCorrelation: true,
        // No trustworthy sessionId exists in the Wazuh alert. Never manufacture one.
        sessionId: null,
      });
    }
  }
  return [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// Additional deny gate only. This DOES NOT revoke an existing session.
// A ZTNA session revocation executor needs its own trusted subject/session bindings.
export function checkZTNAExtra({ upstreamDecision, trustedContext, rules }) {
  if (upstreamDecision !== 'allow') {
    return { action: 'preserve', reason: 'upstream_policy_first' };
  }
  if (!Array.isArray(rules)
      || trustedContext?.verifiedByServer !== true
      || trustedContext?.subjectBindingVerified !== true
      || trustedContext?.sessionBindingVerified !== true
      || trustedContext?.eventCorrelatedVerified !== true) {
    return { action: 'pass', reason: 'missing_verified_session_context' };
  }

  const { sessionId, subjectId, agentName, account, sourceAddress, eventId, at } = trustedContext;
  const timestamp = Date.parse(at);
  if (typeof sessionId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{7,127}$/iu.test(sessionId)
      || typeof subjectId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{7,127}$/iu.test(subjectId)
      || !validWazuhId(eventId) || !Number.isFinite(timestamp)
      || !isIP(sourceAddress ?? '')) {
    return { action: 'pass', reason: 'invalid_verified_session_context' };
  }

  const rule = rules.find(r => r.requiresVerifiedSubjectBinding === true
    && r.requiresVerifiedSessionBinding === true
    && r.requiresEventCorrelation === true
    && r.agentName === agentName && r.sourceAddress === sourceAddress
    && r.account === account && r.confidence >= 0.85
    && Array.isArray(r.evidenceAlertIds) && r.evidenceAlertIds.includes(eventId)
    && Date.parse(r.startsAt) <= timestamp && timestamp < Date.parse(r.expiresAt));
  return rule
    ? { action: 'deny', reason: rule.patterns[0], ruleId: rule.id }
    : { action: 'pass', reason: 'no_active_scoped_rule' };
}

export async function respondToDecisions({ root, alerts, decisions }) {
  if (!root || !Array.isArray(alerts) || !Array.isArray(decisions)
      || alerts.length !== decisions.length) {
    throw new Error('경보와 판정 결과 건수가 다릅니다.');
  }
  const rules = buildDenyCandidates(alerts, decisions);
  const folder = join(root, 'xdr', 'privilege');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'deny-rules.json'), JSON.stringify({
    schema: 'aleph.xdr.ztna-candidates.v1',
    moduleKey: 'privilege',
    mode: 'simulation_only',
    effect: 'request_denial_proposal_not_live_session_revocation',
    note: 'ZTNA v1 lacks a server-attested Wazuh account-to-subject/session mapping and a revocation executor.',
    rules,
  }, null, 2) + '\n', 'utf8');

  const logPath = join(root, 'xdr', 'alerts.log');
  let old = '';
  try { old = await readFile(logPath, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const seen = new Set();
  for (const line of old.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.moduleKey === 'privilege') seen.add(event.alertId + '\0' + event.action);
    } catch { /* Preserve unrecognized lines; never execute them. */ }
  }

  const added = [];
  for (let i = 0; i < alerts.length; i += 1) {
    const alert = alerts[i], result = decisions[i];
    if (!['block', 'alert'].includes(result?.action)) continue;
    if (!validWazuhId(alert?.id) || result.alertId !== alert.id
        || !/^[a-z][a-z0-9_]{0,63}$/u.test(result.reason ?? '')
        || !Number.isFinite(result.confidence)
        || result.confidence < (result.action === 'block' ? 0.85 : 0.5)
        || (result.action === 'alert' && result.confidence >= 0.85)) {
      throw new Error('알림에 올바르지 않은 판정 결과가 있습니다.');
    }
    const correct = decide(alert);
    if (correct.action !== result.action || correct.confidence !== result.confidence
        || correct.reason !== result.reason) throw new Error('원본 경보와 판정 결과가 다릅니다.');
    const row = extractAlert(alert);
    if (!row.at) continue;
    const key = alert.id + '\0' + result.action;
    if (seen.has(key)) continue;
    seen.add(key);
    // Never log a sessionId, raw Wazuh message, IP, account name or token.
    added.push(JSON.stringify({
      at: row.at, moduleKey: 'privilege', alertId: alert.id,
      action: result.action, reason: result.reason,
    }));
  }
  if (added.length) await appendFile(logPath, added.join('\n') + '\n', 'utf8');
  return { candidates: rules, logged: added.length };
}
