import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hasT1110, matchStrongPattern } from '../xdr/brute-force/match.mjs';

const cases = [
  { name: 'brute-force', tags: ['T1110', 'T1110.003'], level: 6, absent: 'alert', tagged: 'block' },
  { name: 'web-injection', tags: ['T1190'], level: 1, absent: 'record', tagged: 'block' },
  { name: 'known-cve', tags: ['T1190'], level: 1, absent: 'record', tagged: 'block' },
  { name: 'persistence', tags: ['T1543', 'T1543.003', 'T1053', 'T1053.005', 'T1547', 'T1547.001'], level: 1, absent: 'record', tagged: 'alert' },
  { name: 'privilege', tags: ['T1068', 'T1078', 'T1098', 'T1098.007', 'T1548'], level: 1, absent: 'record', tagged: 'alert' },
  { name: 'exfiltration', tags: ['T1041', 'T1048', 'T1048.003'], level: 1, absent: 'record', tagged: 'alert' },
];

function specimen(name) {
  const { alerts } = JSON.parse(readFileSync(new URL(`../xdr/fixtures/${name}.json`, import.meta.url), 'utf8'));
  return name === 'brute-force' ? alerts.find(row => row.id === 'bf-02') : alerts[0];
}

function withTags(original, level, raw, topLevel) {
  const alert = { ...original, rule: { ...original.rule, level } };
  delete alert.rule.mitre;
  delete alert.mitre;
  if (topLevel) alert.mitre = raw;
  else alert.rule.mitre = raw;
  return alert;
}

function malformedTags(tag, converted) {
  return [
    ['nested array', [tag]],
    ['deeply nested array', [[tag]]],
    ['boxed string', new String(tag)],
    ['ordinary object', { id: tag }],
    ['string conversion', { toString() { converted(); return tag; } }],
    ['primitive conversion', { [Symbol.toPrimitive]() { converted(); return tag; } }],
    ['throwing conversion', { toString() { converted(); throw new Error('must not coerce MITRE tags'); } }],
    ['symbol', Symbol(tag)],
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
    ['number', 1110],
    ['bigint', 1110n],
  ];
}

for (const { name, tags, level, absent, tagged } of cases) {
  test(`${name}: only actual MITRE strings contribute evidence`, async () => {
    const { decide } = await import(`../xdr/${name}/decide.mjs`);
    const original = specimen(name);
    const baseline = decide(withTags(original, level, [], false));
    assert.equal(baseline.action, absent);
    let conversions = 0;
    for (const tag of tags) {
      const expected = decide(withTags(original, level, [tag], false));
      assert.equal(expected.action, tagged);
      const malformed = malformedTags(tag, () => { conversions++; });
      for (const topLevel of [false, true]) {
        for (const raw of [[tag], { id: [tag] }, { id: tag }]) {
          assert.deepEqual(decide(withTags(original, level, raw, topLevel)), expected);
        }
        for (const [label, value] of malformed) {
          // Array-valued id is a supported container, so its elements are tested
          // one level deeper. Scalar id values must themselves be strings.
          const invalidForms = [[value], { id: [value] }];
          if (!Array.isArray(value)) invalidForms.push({ id: value });
          for (const raw of invalidForms) {
            assert.deepEqual(decide(withTags(original, level, raw, topLevel)), baseline,
              `${name}: ${label}, top-level=${topLevel}`);
          }
        }
        const mixed = [...malformed.map(([, value]) => value), tag];
        for (const raw of [mixed, { id: mixed }]) {
          assert.deepEqual(decide(withTags(original, level, raw, topLevel)), expected);
        }
      }
    }
    assert.equal(conversions, 0, 'MITRE processing must never invoke input conversion hooks');
  });
}

test('brute-force independent matching rejects coercible tags and retains real tag corroboration', () => {
  const original = specimen('brute-force');
  let conversions = 0;
  for (const tag of ['T1110', 'T1110.003']) {
    const malformed = malformedTags(tag, () => { conversions++; });
    for (const topLevel of [false, true]) {
      for (const [label, value] of malformed) {
        const invalidForms = [[value], { id: [value] }];
        if (!Array.isArray(value)) invalidForms.push({ id: value });
        for (const raw of invalidForms) {
          const alert = withTags(original, 6, raw, topLevel);
          assert.equal(hasT1110(alert), false, label);
          assert.equal(matchStrongPattern(alert), null, label);
        }
      }
      const mixed = [...malformed.map(([, value]) => value), tag];
      for (const raw of [[tag], { id: [tag] }, { id: tag }, mixed, { id: mixed }]) {
        const alert = withTags(original, 6, raw, topLevel);
        assert.equal(hasT1110(alert), true);
        assert.equal(matchStrongPattern(alert)?.name, 'cross_account_password_spray');
        alert.rule.description = 'Successful ordinary login';
        assert.equal(matchStrongPattern(alert), null);
      }
    }
  }
  assert.equal(conversions, 0, 'independent matching must never invoke input conversion hooks');
});
