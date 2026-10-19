import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectVerifiedDeviceAnomaly } from '../src/detect-verified-device.mjs';
import { detect } from '../src/detect.mjs';

const BASE = Date.UTC(2026, 9, 1, 0, 0, 0);
const subject = 'learner_fixture';
const deviceA = 'a'.repeat(16);
const deviceB = 'b'.repeat(16);

// The test-only Map simulates a trusted engine, not a browser-provided flag.
const attested = new WeakMap();
const verifyEngineEvent = input => attested.get(input) ?? null;

function reads(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => {
    const input = { headers: { 'x-network': 'normal' }, token: 'TEST_ONLY',
      body: 'DO_NOT_READ', fullName: 'SHOULD_NOT_APPEAR' };
    attested.set(input, {
      at: new Date(BASE + i * (overrides.interval ?? 2000)).toISOString(),
      method: 'GET', subject, deviceId: deviceA,
      decision: 'allow', networkDeviation: 'unusual',
      networkBaselineVerified: true,
      ...overrides,
    });
    return input;
  });
}
const examine = items => detectVerifiedDeviceAnomaly(items, { verifyEngineEvent });

test('공식 v1 세 필드 계약은 계속 보존', () => {
  const v1 = Array.from({ length: 121 }, (_, i) => ({
    at: new Date(BASE + i * 2000).toISOString(),
    method: 'GET', identity: { sub: subject },
  }));
  assert.deepEqual(detect(v1), {
    action: 'propose_revocation', reasonCode: 'burst_read', subject,
  });
  const forged = v1.map(x => ({ ...x, deviceId: deviceA,
    network: 'unusual', decision: 'allow', token: 'TEST_ONLY' }));
  assert.deepEqual(detect(forged), detect(v1));
});

test('검증된 같은 기기의 비정상 네트워크+121건만 기기별 회수 제안', () => {
  const output = examine(reads(121));
  assert.deepEqual(output, {
    action: 'propose_revocation', reasonCode: 'unusual_network_burst',
    subject, deviceId: deviceA,
  });
  assert.equal(JSON.stringify(output).includes('DO_NOT_READ'), false);
  assert.equal(Object.hasOwn(output, 'token'), false);
  assert.deepEqual(examine(reads(120)), { action: 'observe' });
  assert.deepEqual(examine(reads(200, { interval: 7000 })), { action: 'observe' });
});

test('지역만 다르거나 121회만 있거나 판정 미허용이면 정상 관찰 유지', () => {
  assert.deepEqual(examine(reads(121, {networkDeviation:'usual'})), {action:'observe'});
  assert.deepEqual(examine(reads(121, {networkBaselineVerified:false})), {action:'observe'});
  assert.deepEqual(examine(reads(121, {decision:'deny'})), {action:'observe'});
  assert.deepEqual(examine(reads(121, {method:'POST'})), {action:'observe'});
  assert.deepEqual(examine(reads(1)), {action:'observe'});
});

test('서로 다른 기기·가명 사용자는 합산하지 않음', () => {
  assert.deepEqual(examine([...reads(70), ...reads(70, {deviceId:deviceB})]),
    {action:'observe'});
  assert.deepEqual(examine([...reads(70), ...reads(70, {subject:'another_fixture'})]),
    {action:'observe'});
});

test('엔진 증명이 없거나 검증기에서 자료를 거부하면 클라이언트 위조는 무효', () => {
  const input = reads(121);
  assert.deepEqual(detectVerifiedDeviceAnomaly(input), {action:'observe'});
  assert.deepEqual(detectVerifiedDeviceAnomaly(input, {
    verifyEngineEvent: () => null,
  }), {action:'observe'});
  assert.deepEqual(detectVerifiedDeviceAnomaly(input, {
    verifyEngineEvent: () => { throw new Error('not verified'); },
  }), {action:'observe'});
  const forged = Array.from({length:121}, () => ({
    method:'GET',deviceId:deviceA,networkDeviation:'unusual',
    networkBaselineVerified:true,
    headers:{'x-network':'unusual'},
  }));
  assert.deepEqual(examine(forged), {action:'observe'});
});
