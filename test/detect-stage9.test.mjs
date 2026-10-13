import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect } from '../src/detect.mjs';
import { checkDetection } from '../scripts/detect-test.mjs';

const BASE = Date.UTC(2026, 9, 1, 0, 0, 0);
const pseudonym = 'learner_fixture';
const makeReads = (count, { sub = pseudonym, interval = 2000, start = BASE } = {}) =>
  Array.from({ length: count }, (_, index) => ({
    at: new Date(start + index * interval).toISOString(),
    method: 'GET',
    identity: { sub },
  }));

test('제공된 9단계 계약의 모의 사건 6종을 정확히 반환', async () => {
  const results = await checkDetection(detect);
  assert.equal(results.length, 6);
  assert.ok(results.every(x => x.passed), JSON.stringify(results));
});

test('121건만 제안하며 120건·다른 주체 합산·10분 바깥은 관찰만', () => {
  assert.deepEqual(detect(makeReads(120)), { action: 'observe' });
  assert.deepEqual(detect(makeReads(121)), {
    action: 'propose_revocation', reasonCode: 'burst_read', subject: pseudonym,
  });
  assert.deepEqual(detect([
    ...makeReads(100),
    ...makeReads(100, { sub: 'other_fixture' }),
  ]), { action: 'observe' });
  assert.deepEqual(detect(makeReads(200, { interval: 7000 })), { action: 'observe' });
  // The 121st access at exactly 10 minutes is still inside the inclusive window.
  assert.equal(detect(makeReads(121, { interval: 5000 })).action,
    'propose_revocation');
  assert.equal(detect(makeReads(121, { interval: 5001 })).action, 'observe');
});

test('입력 순서가 달라도 관측된 사건으로만 결정', () => {
  const events = makeReads(121);
  const scrambled = events.filter((_, i) => i % 2).reverse()
    .concat(events.filter((_, i) => !(i % 2)).reverse());
  assert.deepEqual(detect(scrambled), detect(events));
  assert.deepEqual(detect(makeReads(121).map(e => ({ ...e, method: 'POST' }))),
    { action: 'observe' });
  assert.deepEqual(detect(makeReads(121).map(e => ({ ...e, method: 'HEAD' }))),
    { action: 'observe' });
});

test('허용 계약에 없는 클라이언트 IP·기기·network·메모·토큰은 무시', () => {
  const events = makeReads(121).map(event => ({
    ...event,
    deviceId: 'unverified-device',
    network: 'unusual',
    region: 'foreign',
    headers: { 'x-forwarded-for': '192.0.2.1', 'x-network': 'unusual' },
    accessToken: 'FAKE-ONLY-DO-NOT-STORE',
    memo: { body: 'SYNTHETIC-NOTE-NOT-AN-EVENT' },
    identity: { ...event.identity, fullName: 'NOT-AN-IDENTITY-EVIDENCE' },
  }));
  const decision = detect(events);
  assert.deepEqual(decision, {
    action: 'propose_revocation', reasonCode: 'burst_read', subject: pseudonym,
  });
  assert.doesNotMatch(JSON.stringify(decision),
    /FAKE-ONLY|SYNTHETIC-NOTE|fullName|deviceId|192\.0\.2\.1/u);
  assert.deepEqual(detect(makeReads(30).map(event => ({
    ...event, network: 'unusual', deviceRegistered: false, eventType: 'read',
  }))), { action: 'observe' });
});

test('없는 필드를 정상값으로 채우거나 브라우저 데이터로 사건을 추가하지 않음', () => {
  const missing = [
    { method: 'GET', identity: { sub: pseudonym } },
    { at: new Date(BASE).toISOString(), identity: { sub: pseudonym } },
    { at: new Date(BASE).toISOString(), method: 'GET' },
    { at: new Date(BASE).toISOString(), method: 'GET', identity: { sub: null } },
    { at: new Date(BASE).toISOString(), method: 'GET', identity: { sub: 'fake@example.test' } },
    { at: 'invalid-time', method: 'GET', identity: { sub: pseudonym } },
    { at: '2026-02-30T00:00:00.000Z', method: 'GET', identity: { sub: pseudonym } },
    { at: '2026-10-01T12:00:00+09:00', method: 'GET',
      identity: { sub: pseudonym } },
  ];
  assert.deepEqual(detect([...makeReads(120), ...missing]), { action: 'observe' });
  assert.throws(() => detect({ events: [] }), /invalid_detection_events/u);
});

test('여러 사용자에게서 탐지하면 시간순 우선, 동시에는 ID 순서로 결정', () => {
  const earlier = makeReads(121, { sub: 'early_fixture', start: BASE });
  const later = makeReads(121, { sub: 'late_fixture', start: BASE + 1000 });
  assert.deepEqual(detect([...later, ...earlier]), {
    action: 'propose_revocation', reasonCode: 'burst_read', subject: 'early_fixture',
  });
  const c = makeReads(121, { sub: 'c_fixture', start: BASE });
  const b = makeReads(121, { sub: 'b_fixture', start: BASE });
  assert.equal(detect([...c, ...b]).subject, 'b_fixture');
});

test('엔진 데이터 계약은 기기·네트워크를 제공하지 않으므로 실제 기기 회수 증거가 아님', () => {
  const outcome = detect(makeReads(121));
  assert.equal(Object.hasOwn(outcome, 'deviceId'), false);
  assert.equal(Object.hasOwn(outcome, 'network'), false);
  assert.equal(Object.hasOwn(outcome, 'token'), false);
  assert.deepEqual(Object.keys(outcome).sort(), ['action', 'reasonCode', 'subject']);
});

test('9단계 제출 자기점검은 제안과 실기기 회수를 구분해 기록', async () => {
  const { runAttackChecks } = await import('../src/attack-check.mjs');
  const originalFetch = globalThis.fetch;
  const originalConfig = JSON.parse(await (await import('node:fs/promises'))
    .readFile(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  const config = { ...originalConfig, step: 9, publicAppUrl: 'https://fixture.vercel.app' };
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/aleph.json') return new Response(JSON.stringify({
        step: 9,
        originalApiUrl: config.originalApiUrl,
        protectedService: config.protectedService,
        allowedRoutes: config.allowedRoutes,
      }), { status: 200 });
      if (path === '/api/notes') return new Response(
        JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
      return new Response('<!doctype html>', { status: 200 });
    };
    const checks = await runAttackChecks(config);
    assert.equal(checks.length, 9);
    assert.ok(checks.every(check =>
      Object.keys(check).sort().join(',') === 'attackId,expected,observed'));
    assert.match(checks[0].observed, /6\/6/u);
    assert.match(checks[1].observed, /propose_revocation/u);
    assert.match(checks[2].observed, /observe/u);
    assert.match(checks[3].observed, /무시/u);
    assert.match(checks[4].observed, /9단계/u);
    assert.match(checks[5].observed, /HTTP 200/u);
    assert.match(checks[6].observed, /401/u);
    assert.match(checks[7].observed, /미실행/u);
    assert.match(checks[8].observed, /미실행/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
