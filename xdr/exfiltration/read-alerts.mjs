import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

const FIXTURE = new URL('../fixtures/exfiltration.json', import.meta.url);

// Explicitly project only the five permitted Wazuh alert fields.
// No destination, byte count, raw filename, query, password or payload is emitted.
export function sanitizeDescription(value) {
  if (typeof value !== 'string') return '';
  const limited = value.slice(0, 4096);
  if (/(?:password|passwd|pwd|secret|api[_-]?key|authorization|bearer|token|cookie|private[\s_-]*key|ghp_|github_pat_|sb_secret_|sb_publishable_|sk-proj-|eyJ[A-Za-z0-9_-]{12,}\.)/iu.test(limited)) {
    return '[REDACTED]';
  }
  return limited.replace(/[\r\n\t\u0000-\u001f]+/gu, ' ').slice(0, 512);
}

export function extractAlert(raw) {
  const ip = raw?.data?.srcip ?? raw?.sourceAddress;
  const user = raw?.data?.srcuser ?? raw?.account;
  const time = raw?.timestamp ?? raw?.at;
  const level = raw?.rule?.level ?? raw?.ruleLevel;
  const desc = raw?.rule?.description ?? raw?.description;
  return {
    at: typeof time === 'string' && Number.isFinite(Date.parse(time)) ? time : null,
    sourceAddress: typeof ip === 'string' && isIP(ip) ? ip : null,
    account: typeof user === 'string'
      && /^[a-z][a-z0-9._-]{0,47}$/iu.test(user)
      && !/^(?:password|secret|token|api[_-]?key)/iu.test(user) ? user : null,
    ruleLevel: Number.isInteger(level) && level >= 0 && level <= 16 ? level : null,
    description: sanitizeDescription(desc),
  };
}

export async function readAlerts(source = FIXTURE) {
  const fixture = JSON.parse(await readFile(source, 'utf8'));
  if (fixture?.schema !== 'aleph.xdr.fixture.v1'
      || fixture.moduleKey !== 'exfiltration' || !Array.isArray(fixture.alerts)) {
    throw new Error('exfiltration Wazuh 경보 묶음 형식이 아닙니다.');
  }
  const projected = fixture.alerts.map(extractAlert);
  if (projected.length !== fixture.alerts.length) {
    throw new Error('경보 건수와 추출 결과 수가 다릅니다.');
  }
  return projected;
}
