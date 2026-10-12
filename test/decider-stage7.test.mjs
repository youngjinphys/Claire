import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, RULE_IDS } from '../src/decider.mjs';
import { fixtureRequests } from '../scripts/fixture-7.mjs';
import { checkDecider } from '../scripts/decider-test.mjs';
import { runAttackChecks } from '../src/attack-check.mjs';

const verdict = async (input) => {
  const output = await decide(input);
  assert.deepEqual(Object.keys(output).sort(),
    ['decision', 'reasonCode', 'requestId', 'ruleIds', 'schema']);
  assert.equal(output.schema, 'aleph.decision.v1');
  assert.equal(output.requestId, input.requestId);
  assert.ok(output.ruleIds.every(id => RULE_IDS.includes(id)));
  return output;
};

test('엔진 계약의 정상 사건 allow, 복합 가상 사건 step_up, 확인된 재판정 allow', async () => {
  const { normal, suspicious } = fixtureRequests();
  assert.deepEqual(RULE_IDS, ['device_registered', 'step_up_required']);
  assert.deepEqual((await verdict(normal)).ruleIds, ['device_registered']);
  const risk = await verdict(suspicious);
  assert.equal(risk.decision, 'step_up');
  assert.equal(risk.reasonCode, 'step_up_required');
  assert.deepEqual(risk.ruleIds, RULE_IDS);
  const refreshed = await verdict({ ...suspicious,
    stepUp: { verified: true, authAgeSeconds: 60 },
  });
  assert.equal(refreshed.decision, 'allow');
  assert.equal(refreshed.reasonCode, 'approved');

  const localChecks = await checkDecider({ decide, ruleIds: RULE_IDS });
  assert.equal(localChecks.length, 4);
  assert.ok(localChecks.every(x => x.passed), JSON.stringify(localChecks));
});

test('독립된 위험 신호·지역 한 항목으로는 추가 확인하지 않음', async () => {
  const { normal, suspicious } = fixtureRequests();
  const changes = [
    { signals: { ...suspicious.signals, hour: 14 } },
    { signals: { ...suspicious.signals, network: 'usual' } },
    { recentEvents: [] },
    { recentEvents: [{ kind: 'risk_signal', ageSeconds: 60, count: 19 }] },
    { recentEvents: [{ kind: 'risk_signal', ageSeconds: 121, count: 20 }] },
    { signals: { ...normal.signals, region: 'foreign' } },
  ];
  for (const change of changes) {
    const output = await verdict({ ...suspicious, ...change });
    assert.equal(output.decision, 'allow', JSON.stringify(change));
    assert.equal(output.reasonCode, 'approved');
  }
});

test('검증 후 시간이 오래됐거나 확인되지 않은 가상 재로그인은 계속 step_up', async () => {
  const { suspicious } = fixtureRequests();
  for (const stepUp of [
    { verified: false, authAgeSeconds: null },
    { verified: true, authAgeSeconds: 121 },
    { verified: true, authAgeSeconds: 900 },
  ]) {
    const output = await verdict({ ...suspicious, stepUp });
    assert.equal(output.decision, 'step_up');
    assert.equal(output.reasonCode, 'step_up_required');
  }
  const invalid = await verdict({ ...suspicious,
    stepUp: { verified: true, authAgeSeconds: -1 },
  });
  assert.equal(invalid.decision, 'deny');
});

test('위치·행동 출처가 미확인·누락이면 정상 지역/네트워크로 대체하지 않음', async () => {
  const { normal, suspicious } = fixtureRequests();
  const badCases = [
    { signals: undefined },
    { signals: { ...normal.signals, source: 'browser_header' } },
    { signals: { ...normal.signals, source: 'forwarded_header' } },
    { signals: { ...normal.signals, region: undefined } },
    { signals: { ...normal.signals, network: undefined } },
    { signals: { ...normal.signals, hour: undefined } },
    { signals: { ...normal.signals, hour: '14' } },
    { signals: { ...normal.signals, network: 'unknown' } },
    { signals: { source: 'none', region: 'local', network: 'usual', hour: 14 } },
    { recentEvents: undefined },
    { recentEvents: [{ kind: 'risk_signal', count: 20 }] },
    { recentEvents: [{ kind: 'risk_signal', count: '20', ageSeconds: 60 }] },
    { recentEvents: Array.from({ length: 13 }, () => ({
      kind: 'risk_signal', count: 20, ageSeconds: 60,
    })) },
    { at: undefined },
    { stepUp: undefined },
  ];
  for (const changes of badCases) {
    const result = await verdict({ ...normal, ...changes });
    assert.equal(result.decision, 'deny', JSON.stringify(changes));
    assert.equal(result.reasonCode, 'starter_not_ready');
  }
  const bare = await verdict({ ...suspicious,
    signals: { source: 'none', region: 'unknown', network: 'unknown', hour: 3 },
    headers: { 'x-forwarded-for': '127.0.0.1', 'x-region': 'foreign',
      'x-network': 'unusual' },
    geo: { region: 'foreign' },
  });
  // Engine "none" provides NO source evidence. Base device policy stays in
  // effect; client-controlled headers cannot trigger or satisfy risk criteria.
  assert.equal(bare.decision, 'allow');
  assert.deepEqual(bare.ruleIds, ['device_registered']);
});

test('기존 기기 미등록 거부가 step_up보다 우선하며 클라이언트 헤더는 무시', async () => {
  const { normal, suspicious } = fixtureRequests();
  const extra = { headers: { 'x-region': 'local', 'x-network': 'usual' },
    identity: { role: 'owner' }, geo: { region: 'local' } };
  assert.equal((await verdict({ ...normal, ...extra })).decision, 'allow');
  assert.equal((await verdict({ ...suspicious, ...extra })).decision, 'step_up');
  const deviceFailure = await verdict({ ...suspicious, ...extra,
    deviceRegistered: false, stepUp: { verified: true, authAgeSeconds: 10 },
  });
  assert.equal(deviceFailure.decision, 'deny');
  assert.equal(deviceFailure.reasonCode, 'device_not_registered');
  assert.deepEqual(deviceFailure.ruleIds, ['device_registered']);
});

test('7단계 bundle 자기점검은 운영 재로그인 미실행을 분리 기록', async () => {
  const previous = globalThis.fetch;
  const config = {
    step: 7,
    publicAppUrl: 'https://student-defense.vercel.app',
    protectedService: { serviceId: 'notes', readRoute: 'GET /notes/:id' },
  };
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/aleph.json') {
        return new Response(JSON.stringify({
          step: 7, protectedService: config.protectedService,
        }), { status: 200 });
      }
      if (path === '/api/notes') {
        return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
      }
      return new Response('<!doctype html><title>Training</title>', { status: 200 });
    };
    const checks = await runAttackChecks(config);
    assert.equal(checks.length, 8);
    assert.ok(checks.every(x =>
      Object.keys(x).sort().join(',') === 'attackId,expected,observed'));
    assert.match(checks[0].observed, /allow/u);
    assert.match(checks[1].observed, /step_up_required/u);
    assert.match(checks[2].observed, /실제 재로그인 미검증/u);
    assert.match(checks[3].observed, /출처 거부/u);
    assert.match(checks[4].observed, /step=7/u);
    assert.match(checks[5].observed, /HTTP 200/u);
    assert.match(checks[6].observed, /401/u);
    assert.match(checks[7].observed, /미실행/u);
  } finally {
    globalThis.fetch = previous;
  }
});
