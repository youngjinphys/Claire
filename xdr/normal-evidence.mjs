import { addressIdentity } from './address-identity.mjs';

const NORMAL = new Map([
  ['web-injection', { id: /^wi-[A-Za-z0-9-]{1,40}$/u, reason: 'normal_web_activity' }],
  ['known-cve', { id: /^kc-[A-Za-z0-9-]{1,40}$/u, reason: 'normal_application_activity' }],
  ['persistence', { id: /^ps-[a-z0-9-]{1,40}$/iu, reason: 'known_benign_system_activity' }],
  ['privilege', { id: /^pv-[a-z0-9-]{1,40}$/iu, reason: 'normal_account_activity' }],
  ['exfiltration', { id: /^ex-[a-z0-9-]{1,40}$/iu, reason: 'normal_document_activity' }],
]);

// A local record result can also mean missing/invalid/unsupported evidence.
// Callers supply their independently recomputed decision and existing reader
// projection, then check the module's route/agent/account/destination scope.
export function hasNormalEvidence(moduleKey, alert, row, decision) {
  const expected = NORMAL.get(moduleKey);
  if (!expected || !alert || typeof alert !== 'object' || Array.isArray(alert)
      || typeof alert.id !== 'string' || !expected.id.test(alert.id)) return false;
  for (const container of [alert.rule, alert.data]) {
    if (container != null && (typeof container !== 'object' || Array.isArray(container))) return false;
  }
  const description = alert.rule?.description ?? alert.description;
  // Semantic evidence uses the complete bounded raw text. The reader's
  // shortened display may contain only leading whitespace; retain its
  // redaction veto without using display nonemptiness as semantic evidence.
  return typeof description === 'string' && description.length <= 1024 && description.trim().length > 0
    && typeof row?.description === 'string' && row.description !== '[REDACTED]'
    && typeof row?.at === 'string' && Number.isFinite(Date.parse(row.at))
    && addressIdentity(row?.sourceAddress) !== null
    && Number.isInteger(row?.ruleLevel) && row.ruleLevel >= 0 && row.ruleLevel <= 16
    && decision?.action === 'record' && decision.reason === expected.reason
    && Number.isFinite(decision.confidence) && decision.confidence >= 0 && decision.confidence < 0.5;
}
