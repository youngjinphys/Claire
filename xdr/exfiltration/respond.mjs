import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decide } from './decide.mjs';
import { extractAlert } from './read-alerts.mjs';

const TTL_MS = 15 * 60 * 1000;

const validId = value => typeof value === 'string' && /^ex-[a-z0-9-]{1,40}$/iu.test(value);

function validAgent(alert) {
  const name = alert?.agent?.name;
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(name)
    ? name : null;
}

function validDestination(alert) {
  const dest = alert?.data?.dstip;
  return typeof dest === 'string' && isIP(dest) ? dest : null;
}

function verifiedBlock(alert, submitted) {
  const actual = decide(alert);
  return submitted?.alertId === alert?.id && submitted?.action === 'block'
    && actual.action === 'block' && actual.confidence >= 0.85
    && submitted.confidence === actual.confidence && submitted.reason === actual.reason
    ? actual : null;
}

// Only candidates for additional, scoped ZTNA destination denial.
// A source or destination alone must never cause an indiscriminate ban.
export function buildDenyCandidates(alerts, decisions) {
  if (!Array.isArray(alerts) || !Array.isArray(decisions)
      || alerts.length !== decisions.length) {
    throw new Error('경보 수와 판정 수가 다릅니다.');
  }
  const mapped = new Map(decisions.map(v => [v.alertId, v]));
  const benignDestinations = new Set();
  for (const alert of alerts) {
    const dst = validDestination(alert);
    if (dst && decide(alert).action === 'record') benignDestinations.add(dst);
  }

  const candidates = new Map();
  for (const alert of alerts) {
    if (!validId(alert?.id)) continue;
    const decision = verifiedBlock(alert, mapped.get(alert.id));
    if (!decision) continue;
    const row = extractAlert(alert), dst = validDestination(alert), agent = validAgent(alert);
    const started = Date.parse(row.at);
    const bytesRaw = alert?.data?.bytes;
    const bytes = typeof bytesRaw === 'string' || typeof bytesRaw === 'number'
      ? Number(bytesRaw) : NaN;
    if (!row.sourceAddress || !row.account || !dst || !agent
        || !Number.isFinite(started) || !Number.isSafeInteger(bytes)
        || bytes < 50_000_000 || benignDestinations.has(dst)) continue;
    const scope = agent + '\0' + row.sourceAddress + '\0' + row.account + '\0' + dst;
    const until = started + TTL_MS;
    const known = candidates.get(scope);
    if (known) {
      if (!known.evidenceAlertIds.includes(alert.id)) known.evidenceAlertIds.push(alert.id);
      if (Date.parse(known.startsAt) > started) known.startsAt = row.at;
      if (Date.parse(known.expiresAt) < until) known.expiresAt = new Date(until).toISOString();
      known.confidence = Math.max(known.confidence, decision.confidence);
      if (!known.patterns.includes(decision.reason)) known.patterns.push(decision.reason);
    } else {
      candidates.set(scope, {
        id: 'xdr.exfiltration.' + createHash('sha256').update(scope).digest('hex').slice(0, 16),
        agentName: agent,
        sourceAddress: row.sourceAddress,
        account: row.account,
        destinationAddress: dst,
        startsAt: row.at,
        expiresAt: new Date(until).toISOString(),
        evidenceAlertIds: [alert.id],
        patterns: [decision.reason],
        confidence: decision.confidence,
        requiresVerifiedSourceBinding: true,
        requiresVerifiedDestinationBinding: true,
        requiresVerifiedAccountBinding: true,
        requiresEventCorrelation: true,
      });
    }
  }
  return [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// Separate additive gate: never replace an upstream deny/step_up or trust
// browser-supplied destination details. Caller must be a trusted server.
export function checkZTNAExtra({ upstreamDecision, trustedContext, rules }) {
  if (upstreamDecision !== 'allow') {
    return { action: 'preserve', reason: 'upstream_policy_first' };
  }
  if (!Array.isArray(rules)
      || trustedContext?.verifiedByServer !== true
      || trustedContext?.sourceBindingVerified !== true
      || trustedContext?.destinationBindingVerified !== true
      || trustedContext?.accountBindingVerified !== true
      || trustedContext?.eventCorrelatedVerified !== true) {
    return { action: 'pass', reason: 'missing_verified_transfer_context' };
  }
  const { sourceAddress, destinationAddress, account, agentName, eventId, at } = trustedContext;
  const moment = Date.parse(at);
  if (!isIP(sourceAddress ?? '') || !isIP(destinationAddress ?? '')
      || !validId(eventId) || !Number.isFinite(moment)
      || typeof account !== 'string' || typeof agentName !== 'string') {
    return { action: 'pass', reason: 'invalid_verified_transfer_context' };
  }

  const matched = rules.find(rule =>
    rule.requiresVerifiedSourceBinding === true
    && rule.requiresVerifiedDestinationBinding === true
    && rule.requiresVerifiedAccountBinding === true
    && rule.requiresEventCorrelation === true
    && rule.agentName === agentName
    && rule.sourceAddress === sourceAddress
    && rule.destinationAddress === destinationAddress
    && rule.account === account
    && rule.confidence >= 0.85
    && Array.isArray(rule.evidenceAlertIds)
    && rule.evidenceAlertIds.includes(eventId)
    && Date.parse(rule.startsAt) <= moment && moment < Date.parse(rule.expiresAt)
  );
  return matched
    ? { action: 'deny', reason: matched.patterns[0], ruleId: matched.id }
    : { action: 'pass', reason: 'no_active_scoped_rule' };
}

export async function respondToDecisions({ root, alerts, decisions }) {
  if (!root || !Array.isArray(alerts) || !Array.isArray(decisions)
      || alerts.length !== decisions.length) {
    throw new Error('경보·판정 배열이 올바르지 않습니다.');
  }
  const candidates = buildDenyCandidates(alerts, decisions);
  const outputDir = join(root, 'xdr', 'exfiltration');
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'deny-rules.json'), JSON.stringify({
    schema: 'aleph.xdr.ztna-candidates.v1',
    moduleKey: 'exfiltration',
    mode: 'simulation_only',
    note: 'ALEPH ZTNA v1 lacks server-attested destination IP and Wazuh event correlation.',
    rules: candidates,
  }, null, 2) + '\n', 'utf8');

  const logPath = join(root, 'xdr', 'alerts.log');
  let previous = '';
  try { previous = await readFile(logPath, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const seen = new Set();
  for (const line of previous.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.moduleKey === 'exfiltration') seen.add(item.alertId + '\0' + item.action);
    } catch { /* Preserve unrelated lines without interpreting instructions. */ }
  }
  const added = [];
  for (let i = 0; i < alerts.length; i += 1) {
    const alert = alerts[i], output = decisions[i];
    if (!['block', 'alert'].includes(output?.action)) continue;
    if (!validId(alert?.id) || output.alertId !== alert.id
        || !/^[a-z][a-z0-9_]{0,63}$/u.test(output.reason ?? '')
        || !Number.isFinite(output.confidence)
        || output.confidence < (output.action === 'block' ? 0.85 : 0.5)
        || (output.action === 'alert' && output.confidence >= 0.85)) {
      throw new Error('알림 판정 형식이 잘못되었습니다.');
    }
    const actual = decide(alert);
    if (actual.action !== output.action || actual.confidence !== output.confidence
        || actual.reason !== output.reason) throw new Error('원본 경보와 판정이 불일치합니다.');
    const row = extractAlert(alert);
    if (!row.at) continue;
    const key = alert.id + '\0' + output.action;
    if (seen.has(key)) continue;
    seen.add(key);
    // Never expose destination IP, filenames, request body or raw Wazuh data in logs.
    added.push(JSON.stringify({
      at: row.at, moduleKey: 'exfiltration',
      alertId: alert.id, action: output.action, reason: output.reason,
    }));
  }
  if (added.length) await appendFile(logPath, added.join('\n') + '\n', 'utf8');
  return { candidates, logged: added.length };
}
