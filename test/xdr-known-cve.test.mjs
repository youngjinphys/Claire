import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { extractAlert, readAlerts } from '../xdr/known-cve/read-alerts.mjs';
import { decide } from '../xdr/known-cve/decide.mjs';
import { buildDenyCandidates, checkZTNAExtra, respondToDecisions } from '../xdr/known-cve/respond.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(root, 'xdr', 'fixtures', 'known-cve.json');
const fixtureText = await readFile(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);
const patterns = JSON.parse(await readFile(join(root, 'xdr/known-cve/patterns.json'), 'utf8'));
const decisions = fixture.alerts.map(alert => ({ alertId: alert.id, ...decide(alert) }));

test('경보 24건을 허용된 다섯 필드로만 추출하며 fixture를 보존', async () => {
  const rows = await readAlerts();
  assert.equal(rows.length, fixture.alerts.length);
  assert.equal(rows.length, 24);
  assert.deepEqual(Object.keys(rows[0]), ['at', 'sourceAddress', 'account', 'ruleLevel', 'description']);
  assert.equal(rows[0].sourceAddress, fixture.alerts[0].data.srcip);
  assert.equal(rows[0].account, null);
  assert.equal(rows[16].account, 'user01');
  const withSecret = structuredClone(fixture.alerts[0]);
  withSecret.rule.description = 'password=very_private';
  withSecret.data.secret = 'NEVER_EXPOSE';
  const safe = extractAlert(withSecret);
  assert.equal(safe.description, '[REDACTED]');
  assert.equal('secret' in safe, false);
  assert.equal(await readFile(fixturePath, 'utf8'), fixtureText);
});

test('MITRE T1190와 CVE-2021-44228 패턴의 조건·단일 행 근거가 명시됨', async () => {
  assert.equal(patterns.technique, 'T1190');
  assert.equal(patterns.cve, 'CVE-2021-44228');
  assert.ok(patterns.patterns.length >= 4);
  const names = new Set();
  for (const p of patterns.patterns) {
    assert.match(p.name, /^[a-z][a-z0-9_]+$/u);
    assert.equal(names.has(p.name), false); names.add(p.name);
    assert.ok(p.condition && typeof p.condition === 'object');
    assert.ok(typeof p.condition.signal === 'string' && p.condition.signal);
    assert.ok(typeof p.evidence === 'string' && /T1190/u.test(p.evidence));
    assert.equal(p.evidence.includes('\n'), false);
    assert.ok(Number.isFinite(p.confidence) && p.confidence >= 0 && p.confidence <= 1);
  }
  const source = await readFile(join(root, 'xdr/known-cve/decide.mjs'), 'utf8');
  const embedded = source.match(/const PATTERNS = Object\.freeze\((\[[\s\S]*?\])\);/u);
  assert.ok(embedded, 'embedded PATTERNS missing');
  assert.deepEqual(JSON.parse(embedded[1]), patterns.patterns, 'patterns.json and embedded copy differ');
});

test('8개 명확 차단, 8개 검토 알림, 8개 정상 기록', () => {
  const counts = decisions.reduce((acc, d) => (acc[d.action]++, acc),
    { block: 0, alert: 0, record: 0 });
  assert.deepEqual(counts, { block: 8, alert: 8, record: 8 });
  assert.ok(decisions.every(d => /^[a-z][a-z0-9_]+$/u.test(d.reason)
    && Number.isFinite(d.confidence) && d.confidence >= 0 && d.confidence <= 1));
  assert.ok(decisions.filter(d => d.action === 'block').every(d => d.confidence >= 0.85));
  assert.ok(decisions.filter(d => d.action === 'alert').every(d => d.confidence >= 0.5 && d.confidence < 0.85));
  assert.ok(decisions.filter(d => d.action === 'record').every(d => d.confidence < 0.5));
  assert.ok(fixture.alerts.slice(16).every(a => decide(a).action === 'record'));
  assert.ok((decide(fixture.alerts[0])).action === 'block');
});

test('원격 조회 구문 없이는 높은 rule.level이라도 자동 차단하지 않음', () => {
  const benignReference = structuredClone(fixture.alerts[8]);
  benignReference.rule.level = 15;
  assert.equal(decide(benignReference).action, 'alert');
  const citationOnly = structuredClone(fixture.alerts[0]);
  delete citationOnly.data.useragent;
  assert.equal(decide(citationOnly).action, 'alert');
  const missingIp = structuredClone(fixture.alerts[0]);
  delete missingIp.data.srcip;
  assert.equal(decide(missingIp).action, 'alert');
  const encoded = structuredClone(fixture.alerts[0]);
  encoded.data.useragent = encodeURIComponent(encoded.data.useragent);
  assert.equal(decide(encoded).action, 'block');
  const success = structuredClone(fixture.alerts[18]);
  success.rule.level = 14;
  assert.equal(decide(success).action, 'record');
  assert.equal(decide(null).action, 'record');
});

test('심판 격리 실행: decide.mjs 한 파일만 복사하고 동기적으로 판정', async () => {
  const path = join(root, 'xdr/known-cve/decide.mjs');
  const source = await readFile(path, 'utf8');
  assert.doesNotMatch(source, /^\s*(?:import\b|export\s+[^;]*\s+from\b)/mu);
  assert.doesNotMatch(source, /\b(?:require\s*\(|fetch\s*\(|process\.env|readFile|writeFile|node:fs|node:net|XMLHttpRequest)\b/u);
  assert.equal((source.match(/\bexport function decide\s*\(/gu) ?? []).length, 1);
  const dir = await mkdtemp(join(tmpdir(), 'aleph-xdr03-isolated-'));
  try {
    await copyFile(path, join(dir, 'decide.mjs'));
    const inputs = [fixture.alerts[0], fixture.alerts[8], fixture.alerts[16]];
    const script = [
      'globalThis.fetch = () => { throw new Error("network disabled"); };',
      'const mod = await import("./decide.mjs");',
      'if (Object.keys(mod).join(",") !== "decide") throw new Error("Unexpected export");',
      'const inputs = ' + JSON.stringify(inputs) + ';',
      'const answers = inputs.map(item => mod.decide(item));',
      'if (answers.some(x => x && typeof x.then === "function")) throw new Error("async result");',
      'process.stdout.write(JSON.stringify(answers));',
    ].join('\n');
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: dir, encoding: 'utf8', timeout: 4000, env: { PATH: process.env.PATH ?? '' },
    });
    assert.equal(run.status, 0, run.stderr || String(run.error));
    assert.equal(run.stderr, '');
    const actual = JSON.parse(run.stdout);
    assert.deepEqual(actual.map(r => r.action), ['block', 'alert', 'record']);
    for (const item of actual) {
      assert.deepEqual(Object.keys(item).sort(), ['action', 'confidence', 'reason']);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ZTNA 추가 검사: 검증된 근거 경보·주소·경로·시각만 일치하면 거부', () => {
  const rules = buildDenyCandidates(fixture.alerts, decisions);
  assert.equal(rules.length, 6); // Two header-only events lack an attested route.
  assert.ok(rules.every(r => r.confidence >= 0.85
    && Date.parse(r.expiresAt) > Date.parse(r.startsAt)
    && r.requiresEventCorrelation && r.evidenceAlertIds.length));
  const raw = fixture.alerts[1];
  const trusted = {
    verifiedByServer: true, sourceAddress: raw.data.srcip, path: '/search',
    eventId: raw.id, at: raw.timestamp,
  };
  assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: trusted, rules }).action, 'deny');
  assert.equal(checkZTNAExtra({ upstreamDecision: 'deny', trustedContext: trusted, rules }).action, 'preserve');
  assert.equal(checkZTNAExtra({ upstreamDecision: 'step_up', trustedContext: trusted, rules }).action, 'preserve');
  assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: { ...trusted, verifiedByServer: false }, rules }).action, 'pass');
  assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: { ...trusted, eventId: 'kc-17' }, rules }).action, 'pass');
  assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: { ...trusted, path: '/unrelated' }, rules }).action, 'pass');
  assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: { ...trusted, at: '2026-10-13T00:00:00Z' }, rules }).action, 'pass');
  for (const normal of fixture.alerts.slice(16)) {
    const result = checkZTNAExtra({ upstreamDecision: 'allow', rules, trustedContext: {
      verifiedByServer: true, sourceAddress: normal.data.srcip,
      path: new URL(normal.data.url, 'https://xdr.invalid').pathname,
      eventId: normal.id, at: normal.timestamp,
    } });
    assert.equal(result.action, 'pass', normal.id);
  }
  const forged = decisions.map(d => d.alertId === 'kc-17'
    ? { ...d, action: 'block', confidence: 0.99, reason: decisions[0].reason } : d);
  assert.equal(buildDenyCandidates(fixture.alerts, forged).length, rules.length);
  const sharedNormal = structuredClone(fixture.alerts[16]);
  sharedNormal.id = 'kc-test-shadow';
  sharedNormal.data.srcip = raw.data.srcip;
  const sharedAlerts = [...fixture.alerts, sharedNormal];
  const sharedDecisions = [...decisions, { alertId: sharedNormal.id, ...decide(sharedNormal) }];
  assert.equal(buildDenyCandidates(sharedAlerts, sharedDecisions)
    .some(r => r.sourceAddress === raw.data.srcip), false);
});

test('respond 로그는 중복 없이 생성되고 다른 XDR 기록은 보존', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aleph-xdr03-response-'));
  try {
    await mkdir(join(dir, 'xdr'), { recursive: true });
    const unrelated = JSON.stringify({ moduleKey: 'brute-force', alertId: 'bf-other', action: 'alert' });
    const logFile = join(dir, 'xdr/alerts.log');
    await writeFile(logFile, unrelated + '\n');
    const first = await respondToDecisions({ root: dir, alerts: fixture.alerts, decisions });
    assert.equal(first.length, 6);
    const once = await readFile(logFile, 'utf8');
    const log = once.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(log.length, 17);
    assert.equal(log[0].moduleKey, 'brute-force');
    assert.equal(log.filter(row => row.moduleKey === 'known-cve' && row.action === 'block').length, 8);
    assert.equal(log.filter(row => row.moduleKey === 'known-cve' && row.action === 'alert').length, 8);
    assert.ok(log.every(row => !('url' in row) && !('sourceAddress' in row) && !('account' in row)));
    const again = await respondToDecisions({ root: dir, alerts: fixture.alerts, decisions });
    assert.equal(again.length, 6);
    assert.equal(await readFile(logFile, 'utf8'), once);
    const candidates = JSON.parse(await readFile(join(dir, 'xdr/known-cve/deny-rules.json'), 'utf8'));
    assert.equal(candidates.mode, 'simulation_only');
    assert.equal(candidates.rules.length, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
