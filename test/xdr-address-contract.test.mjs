import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { test } from 'node:test';
import { hasT1110, matchStrongPattern } from '../xdr/brute-force/match.mjs';
import { decide as bruteForceDecide } from '../xdr/brute-force/decide.mjs';

const modules = ['brute-force', 'web-injection', 'known-cve', 'persistence', 'privilege', 'exfiltration'];
const fixture = name => JSON.parse(readFileSync(new URL(`../xdr/fixtures/${name}.json`, import.meta.url), 'utf8'));

// Generate independent acceptance expectations with Node's reader-side parser.
// Exercise every compression position, dotted suffixes, scope zones, decimal
// octet boundaries, malformed group counts, and deterministic corruptions.
function addresses() {
  const values = new Set([
    '', '::', '::1', '2001:db8::1', '::ffff:192.0.2.1', '192.000.2.1',
    '0:0:0:0:0:ffff:192.0.2.1', '1:2:3:4:5:6:7:8',
    '[::1]', '[::1]:443', '192.0.2.1:443', 'localhost',
    '::1%eth0', 'fe80::1%12', '::ffff:192.0.2.1%en0',
    '::1%scope-name.0:1', '::1%' + 'a'.repeat(100),
    '::1%', '::1%%eth0', '::1%a_b', '::1%a/b', '192.0.2.1%en0',
  ]);
  for (let position = 0; position < 4; position++) {
    for (const octet of ['0', '1', '9', '10', '99', '100', '192', '254', '255', '256', '999', '00', '01', '000', '0255', '-1', '+1', '1e2', '１', '']) {
      const parts = ['192', '0', '2', '1'];
      parts[position] = octet;
      const dotted = parts.join('.');
      values.add(dotted);
      values.add('::ffff:' + dotted);
      values.add('1:2:3:4:5:6:' + dotted);
      values.add('1:2:3:4:5:6::' + dotted);
    }
  }
  for (let count = 0; count <= 9; count++) {
    const groups = Array.from({ length: count }, (_, i) => (0x100 + i).toString(16));
    values.add(groups.join(':'));
    values.add(groups.join(':') + ':192.0.2.1');
    for (let start = 0; start <= count; start++) {
      for (let end = start; end <= count; end++) {
        values.add(groups.slice(0, start).join(':') + '::' + groups.slice(end).join(':'));
      }
    }
  }
  for (const valid of ['192.0.2.1', '::', '2001:db8::1', '1:2:3:4:5:6:7:8', '::ffff:192.0.2.1']) {
    for (const extra of [' ', '\n', '\r', '\0', ':', '.', '%', '/', '[', 'g']) {
      values.add(extra + valid);
      values.add(valid + extra);
      values.add(valid.slice(0, Math.floor(valid.length / 2)) + extra + valid.slice(Math.floor(valid.length / 2)));
    }
  }
  let state = 0x1968;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const alphabet = '0123456789abcdefABCDEF:.%xyz-\n ';
  for (let index = 0; index < 1500; index++) {
    let value = '';
    const length = next() % 55;
    for (let i = 0; i < length; i++) value += alphabet[next() % alphabet.length];
    values.add(value);
  }
  return [...values, null, undefined, 192, [], {}];
}

const corpus = addresses();
for (const name of modules) {
  test(`${name}: isolated address decisions match the node:net.isIP reader oracle`, async () => {
    const entry = await import(`../xdr/${name}/decide.mjs`);
    const { extractAlert } = await import(`../xdr/${name}/read-alerts.mjs`);
    assert.deepEqual(Object.keys(entry), ['decide']);
    const original = fixture(name).alerts[0];
    assert.equal(entry.decide(original).action, 'block');
    for (const address of corpus) {
      const alert = { ...original, data: { ...original.data, srcip: address } };
      const valid = typeof address === 'string' && isIP(address) !== 0;
      const message = `${name} ${JSON.stringify(address)}`;
      assert.equal(extractAlert(alert).sourceAddress, valid ? address : null, message);
      assert.equal(entry.decide(alert).action === 'block', valid, message);
    }
  });
}

test('exfiltration applies the same address contract to the destination', async () => {
  const { decide } = await import('../xdr/exfiltration/decide.mjs');
  const original = fixture('exfiltration').alerts[0];
  for (const address of corpus) {
    const alert = { ...original, data: { ...original.data, dstip: address } };
    assert.equal(decide(alert).action === 'block', typeof address === 'string' && isIP(address) !== 0,
      `destination ${JSON.stringify(address)}`);
  }
});

test('brute-force independent matcher accepts every documented MITRE representation', () => {
  const original = fixture('brute-force').alerts.find(row => row.id === 'bf-02');
  for (const raw of [['T1110'], { id: ['T1110'] }, { id: 'T1110' }, ['T1110.003'], { id: 'T1110.003' }]) {
    for (const topLevel of [false, true]) {
      const alert = { ...original, rule: { ...original.rule, level: 6, mitre: raw } };
      if (topLevel) {
        delete alert.rule.mitre;
        alert.mitre = raw;
      }
      assert.equal(hasT1110(alert), true);
      assert.equal(bruteForceDecide(alert).action, 'block');
      assert.equal(matchStrongPattern(alert)?.name, bruteForceDecide(alert).reason);
      // A technique label still cannot corroborate a successful or ordinary login.
      alert.rule.description = 'Successful ordinary login';
      assert.equal(matchStrongPattern(alert), null);
      assert.notEqual(bruteForceDecide(alert).action, 'block');
    }
  }
  for (const raw of [null, 'T1110', { id: 'T1110.01' }, { id: ['T1110x003'] }, ['T1190']]) {
    const alert = { ...original, rule: { ...original.rule, level: 6, mitre: raw } };
    assert.equal(hasT1110(alert), false);
    assert.equal(matchStrongPattern(alert), null);
    assert.notEqual(bruteForceDecide(alert).action, 'block');
  }
});
