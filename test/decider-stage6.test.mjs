import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, RULE_IDS } from '../src/decider.mjs';
import { fixtureRequests } from '../scripts/fixture-7.mjs';
import { checkDecider } from '../scripts/decider-test.mjs';
import { deploymentIdentity } from '../scripts/deployment-identity.mjs';
import { validateProtectedService } from '../scripts/config-contract.mjs';
import { runAttackChecks } from '../src/attack-check.mjs';

async function assertVerdict(input, decision, reasonCode) {
  const result = await decide(input);
  assert.equal(result.schema, 'aleph.decision.v1');
  assert.equal(result.requestId, input.requestId);
  assert.equal(result.decision, decision);
  assert.equal(result.reasonCode, reasonCode);
  assert.ok(result.ruleIds.includes('device_registered'));
  assert.deepEqual(Object.keys(result).sort(),
    ['decision', 'reasonCode', 'requestId', 'ruleIds', 'schema']);
}

test('등록 기기는 허용하고 미등록 기기는 거부', async () => {
  const { normal } = fixtureRequests();
  assert.ok(RULE_IDS.includes('device_registered'));
  assert.ok(RULE_IDS.includes('step_up_required'));
  await assertVerdict(normal, 'allow', 'approved');
  await assertVerdict({ ...normal, deviceRegistered: false }, 'deny', 'device_not_registered');
  await assertVerdict({ ...normal, deviceRegistered: null }, 'deny', 'device_not_registered');
  const checks = await checkDecider({ decide, ruleIds: RULE_IDS });
  assert.equal(checks.length, 4);
  assert.ok(checks.every(x => x.passed));
});

test('계정·기기 확인 실패와 엔진이 거부한 다른 사용자 기기는 거부', async () => {
  const { normal } = fixtureRequests();
  for (const change of [
    { subjectId: '' },
    { deviceId: '' },
    { deviceId: 'Z'.repeat(16) },
    { deviceId: 'abcd1234' },
    { subjectId: null },
    { subjectId: 'different_subject', deviceRegistered: false },
    { deviceRegistered: undefined },
  ]) {
    await assertVerdict({ ...normal, ...change }, 'deny', 'device_not_registered');
  }
  // V1 has no independent binding proof. The engine must mark a mismatched
  // pair as deviceRegistered:false; a forged true attestation is out of scope.
});

test('보호 범위 밖의 서비스·동작·경로는 기본 거부', async () => {
  const { normal } = fixtureRequests();
  for (const change of [
    { service: 'other-service' },
    { method: 'POST' },
    { route: 'POST /notes/:id' },
    { route: 'GET /api/notes/:id' },
    { path: '/notes/demo/extra' },
    { schema: 'other.schema' },
    { classId: '' },
    { projectId: '' },
  ]) {
    await assertVerdict({ ...normal, ...change }, 'deny', 'starter_not_ready');
  }
});

test('6단계 보호 서비스 설정·배포 정보는 서비스 ID와 읽기 경로만 포함', () => {
  const config = {
    step: 6,
    protectedService: { serviceId: 'notes', readRoute: 'GET /notes/:id' },
    allowedRoutes: ['/api/notes', '/api/notes/:id'],
    identityProvider: { issuer: 'https://project.supabase.co/auth/v1' },
    originalApiUrl: 'https://project.supabase.co/rest/v1/learning_notes',
    judgeIssuer: 'https://aleph-judge-production.up.railway.app/defense/judge',
  };
  const env = {
    VERCEL_GIT_PROVIDER: 'github',
    VERCEL_GIT_REPO_OWNER: 'Student-A',
    VERCEL_GIT_REPO_SLUG: 'aleph-defense',
    VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
    VERCEL_URL: 'student-defense-123.vercel.app',
  };
  assert.deepEqual(validateProtectedService(config), config.protectedService);
  const manifest = deploymentIdentity(env, config);
  assert.equal(manifest.step, 6);
  assert.deepEqual(manifest.protectedService, config.protectedService);
  assert.deepEqual(manifest.allowedRoutes, config.allowedRoutes);
  assert.throws(() => deploymentIdentity(env, {
    ...config, protectedService: { ...config.protectedService, key: 'unexpected' },
  }));
  assert.throws(() => deploymentIdentity(env, {
    ...config, protectedService: { serviceId: 'unknown', readRoute: 'GET /notes/:id' },
  }));
});

test('6단계 자기점검은 로컬 모의 시험과 실제 HTTP 관측을 구분', async () => {
  const previous = globalThis.fetch;
  const config = {
    step: 6,
    publicAppUrl: 'https://student-defense.vercel.app',
    protectedService: { serviceId: 'notes', readRoute: 'GET /notes/:id' },
  };
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/aleph.json') return new Response(JSON.stringify({
        step: 6, protectedService: config.protectedService,
      }), { status: 200 });
      if (path === '/api/notes') return new Response(JSON.stringify({
        error: 'UNAUTHORIZED',
      }), { status: 401 });
      return new Response('<!doctype html>', { status: 200,
        headers: { 'content-type': 'text/html' } });
    };
    const results = await runAttackChecks(config);
    assert.equal(results.length, 5);
    assert.ok(results.every(row =>
      Object.keys(row).sort().join(',') === 'attackId,expected,observed'));
    assert.match(results[0].observed, /로컬 가상/u);
    assert.match(results[1].observed, /로컬 가상/u);
    assert.match(results[2].observed, /일치/u);
    assert.match(results[3].observed, /엔진/u);
    assert.match(results[4].observed, /401/u);
  } finally {
    globalThis.fetch = previous;
  }
});
