import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { addressIdentity } from '../xdr/address-identity.mjs';

const names = ['brute-force', 'web-injection', 'known-cve', 'persistence', 'privilege', 'exfiltration'];
const flags = {
  'brute-force': [], 'web-injection': [], 'known-cve': [],
  persistence: ['agentBindingVerified'],
  privilege: ['subjectBindingVerified', 'sessionBindingVerified', 'eventCorrelatedVerified'],
  exfiltration: ['sourceBindingVerified', 'destinationBindingVerified', 'accountBindingVerified', 'eventCorrelatedVerified'],
};
const sameAddresses = [
  ['2001:db8::1234', '2001:0DB8:0000:0000:0000:0000:0000:1234'],
  ['fe80::1234%eth0', 'FE80:0000:0000:0000:0000:0000:0000:1234%eth0'],
  ['::ffff:c000:201', '0:0:0:0:0:FFFF:192.0.2.1'],
  ['2001:db8::c000:201', '2001:0DB8::192.0.2.1'],
  ['::', '0000:0000:0000:0000:0000:0000:0000:0000'],
  ['fe80::1%12', 'FE80:0:0:0:0:0:0:0001%12'],
];
const differentAddresses = [
  ['2001:db8::1234', '2001:db8::1235'],
  ['fe80::1234%eth0', 'fe80::1234%eth1'],
  ['fe80::1234%eth0', 'fe80::1234%Eth0'],
  ['fe80::1%12', 'fe80::1%012'],
  ['fe80::1234%eth0', 'fe80::1234'],
  ['192.0.2.1', '::ffff:192.0.2.1'],
];
const fixture = name => JSON.parse(readFileSync(new URL(`../xdr/fixtures/${name}.json`, import.meta.url), 'utf8')).alerts;
const proposal = (alert, decide) => ({ alertId: alert.id, ...decide(alert) });

function specimen(name, sourceAddress) {
  const alert = fixture(name)[0];
  alert.data.srcip = sourceAddress;
  if (name === 'known-cve') alert.data.url = '/notes';
  return alert;
}

function trustedContext(name, alert) {
  return {
    verifiedByServer: true, ...Object.fromEntries(flags[name].map(flag => [flag, true])),
    sourceAddress: alert.data.srcip, destinationAddress: alert.data.dstip,
    account: alert.data.srcuser, agentName: alert.agent.name,
    at: alert.timestamp, eventId: alert.id,
    path: new URL(alert.data.url ?? '/', 'https://offline.invalid').pathname,
    deviceId: '0123456789abcdef', subjectId: 'fixture-subject-0001', sessionId: 'fixture-session-0001',
  };
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function invalidAddresses(converted) {
  return [undefined, null, '', 'localhost', 'not-an-ip', '192.000.2.1', '2001:db8::gggg',
    '[2001:db8::1]', '192.0.2.1:443', '127.1', '0x7f000001', 'fe80::1%', 'fe80::1%%eth0',
    ' fe80::1', 'fe80::1\n', 0, 2000, false, true, [], {}, Symbol('address'),
    new String('192.0.2.1'), ['192.0.2.1'],
    { toString() { converted(); return '192.0.2.1'; } },
    { [Symbol.toPrimitive]() { converted(); throw new Error('address must not be coerced'); } }];
}

test('address identity validates literals, canonicalizes only IPv6 value and retains family and exact zone', () => {
  for (const [expected, alternate] of sameAddresses) {
    assert.equal(addressIdentity(expected), expected);
    assert.equal(addressIdentity(alternate), expected);
  }
  for (const [left, right] of differentAddresses) {
    assert.notEqual(addressIdentity(left), addressIdentity(right));
  }
  for (const ipv4 of ['0.0.0.0', '127.0.0.1', '192.0.2.1', '255.255.255.255']) {
    assert.equal(addressIdentity(ipv4), ipv4);
  }
  assert.equal(addressIdentity('FE80:0000:0000:0000:0000:0000:0000:0001%Scope-name.0:1'), 'fe80::1%Scope-name.0:1');
  let conversions = 0;
  for (const value of invalidAddresses(() => { conversions++; })) assert.equal(addressIdentity(value), null);
  assert.equal(conversions, 0);
});

for (const name of names) {
  const { decide } = await import(`../xdr/${name}/decide.mjs`);
  const { extractAlert } = await import(`../xdr/${name}/read-alerts.mjs`);
  const { buildDenyCandidates, checkZTNAExtra } = await import(`../xdr/${name}/${name === 'brute-force' ? 'ztna-gate' : 'respond'}.mjs`);
  const build = alerts => buildDenyCandidates(freeze(alerts), freeze(alerts.map(alert => proposal(alert, decide))));
  const gate = (context, rules, upstreamDecision = 'allow') => checkZTNAExtra({
    upstreamDecision, trustedContext: freeze(context), rules: freeze(rules),
  });

  test(`${name}: equivalent source spellings match both new and previously serialized candidates`, () => {
    for (const [canonical, alternate] of sameAddresses) {
      const alert = specimen(name, alternate);
      assert.equal(decide(alert).action, 'block');
      const [rule] = build([alert]);
      assert.ok(rule);
      assert.equal(rule.sourceAddress, alternate, 'candidate display retains original evidence spelling');
      assert.equal(extractAlert(alert).sourceAddress, alternate, 'five-field evidence display remains unchanged');
      const context = trustedContext(name, alert);
      assert.equal(gate({ ...context, sourceAddress: canonical }, [rule]).action, 'deny');
      assert.equal(gate({ ...context, sourceAddress: alternate }, [{ ...rule, sourceAddress: canonical }]).action, 'deny');
      assert.equal(gate({ ...context, sourceAddress: canonical, verifiedByServer: false }, [rule]).action, 'pass');
      for (const upstreamDecision of ['deny', 'step_up']) {
        assert.equal(gate({ ...context, sourceAddress: canonical }, [rule], upstreamDecision).action, 'preserve');
      }
      for (const field of ['account', 'path', 'agentName'].filter(field => Object.hasOwn(rule, field))) {
        assert.equal(gate({ ...context, sourceAddress: canonical, [field]: 'different-scope' }, [rule]).action, 'pass', field);
      }
      if (rule.requiresEventCorrelation) {
        assert.equal(gate({ ...context, sourceAddress: canonical, eventId: alert.id + '-other' }, [rule]).action, 'pass');
      }
    }
  });

  test(`${name}: equivalent sources share one stable grouping ID and keep all evidence`, () => {
    for (const [canonical, alternate] of sameAddresses) {
      const first = specimen(name, alternate);
      const second = specimen(name, canonical);
      second.id += '-copy';
      second.timestamp = new Date(Date.parse(first.timestamp) + 1000).toISOString();
      const [firstOnly] = build([first]), [secondOnly] = build([second]);
      assert.equal(firstOnly.id, secondOnly.id, 'hash depends on IP value, not spelling');
      for (const alerts of [[first, second], [second, first]]) {
        const rules = build(alerts);
        assert.equal(rules.length, 1);
        assert.equal(rules[0].id, firstOnly.id);
        assert.deepEqual([...rules[0].evidenceAlertIds].sort(), [first.id, second.id].sort());
        assert.equal(rules[0].sourceAddress, alerts[0].data.srcip);
        assert.equal(rules[0].startsAt, first.timestamp);
        assert.equal(rules[0].expiresAt, secondOnly.expiresAt);
        for (const alert of alerts) assert.equal(gate(trustedContext(name, alert), rules).action, 'deny');
      }
    }
  });

  test(`${name}: different numeric addresses, families and exact zones stay separate`, () => {
    for (const [left, right] of differentAddresses) {
      const first = specimen(name, left), second = specimen(name, right);
      second.id += '-copy';
      const rules = build([first, second]);
      assert.equal(rules.length, 2);
      assert.notEqual(rules[0].id, rules[1].id);
      const firstRules = build([first]);
      assert.equal(gate({ ...trustedContext(name, first), sourceAddress: right }, firstRules).action, 'pass');
    }
  });

  test(`${name}: malformed addresses cannot bind or coerce and cannot suppress a valid following alert or rule`, () => {
    const valid = specimen(name, '192.0.2.1');
    const [validRule] = build([valid]);
    const context = trustedContext(name, valid);
    let conversions = 0;
    for (const sourceAddress of invalidAddresses(() => { conversions++; })) {
      const invalid = { ...valid, id: valid.id + '-bad', data: { ...valid.data, srcip: sourceAddress } };
      const rules = build([invalid, valid]);
      assert.equal(rules.length, 1);
      assert.deepEqual(rules[0], validRule);
      const corrupt = { ...validRule, sourceAddress };
      assert.equal(gate({ ...context, sourceAddress }, [corrupt]).action, 'pass');
      assert.equal(gate(context, [corrupt]).action, 'pass');
      assert.equal(gate({ ...context, sourceAddress }, [validRule]).action, 'pass');
      assert.equal(gate(context, [corrupt, validRule]).ruleId, validRule.id);
      for (const upstreamDecision of ['deny', 'step_up']) {
        assert.equal(gate({ ...context, sourceAddress }, [corrupt], upstreamDecision).action, 'preserve');
      }
    }
    assert.equal(conversions, 0);
  });

  if (['web-injection', 'known-cve', 'persistence', 'privilege'].includes(name)) {
    test(`${name}: normal-source protection uses address identity without merging different scopes`, () => {
      for (const [maliciousSource, normalSource] of [...sameAddresses, ...differentAddresses]) {
        const malicious = specimen(name, maliciousSource);
        const normal = fixture(name).find(alert => decide(alert).action === 'record');
        assert.ok(normal);
        normal.data.srcip = normalSource;
        assert.equal(decide(normal).action, 'record');
        const same = sameAddresses.some(pair => pair[0] === maliciousSource && pair[1] === normalSource);
        for (const alerts of [[malicious, normal], [normal, malicious]]) {
          assert.equal(build(alerts).length, same ? 0 : 1);
        }
      }
    });
  }

  if (name === 'exfiltration') {
    test('exfiltration: equivalent destination spellings share gates, stable IDs and benign protection', () => {
      for (const [canonical, alternate] of sameAddresses) {
        const first = specimen(name, '2001:db8::1234');
        first.data.dstip = alternate;
        const second = structuredClone(first);
        second.id += '-copy';
        second.data.dstip = canonical;
        const [firstOnly] = build([first]), [secondOnly] = build([second]);
        assert.equal(firstOnly.destinationAddress, alternate);
        assert.equal(firstOnly.id, secondOnly.id);
        assert.equal(gate({ ...trustedContext(name, first), destinationAddress: canonical }, [firstOnly]).action, 'deny');
        assert.equal(gate(trustedContext(name, first), [{ ...firstOnly, destinationAddress: canonical }]).action, 'deny');
        for (const alerts of [[first, second], [second, first]]) {
          const rules = build(alerts);
          assert.equal(rules.length, 1);
          assert.equal(rules[0].id, firstOnly.id);
          assert.deepEqual([...rules[0].evidenceAlertIds].sort(), [first.id, second.id].sort());
          assert.equal(rules[0].destinationAddress, alerts[0].data.dstip);
        }
        const normal = fixture(name).find(alert => decide(alert).action === 'record');
        normal.data.dstip = canonical;
        assert.equal(decide(normal).action, 'record');
        assert.deepEqual(build([first, normal]), []);
        assert.deepEqual(build([normal, first]), []);
      }
    });

    test('exfiltration: different destination addresses, zones and families never share gates or benign exclusions', () => {
      for (const [left, right] of differentAddresses) {
        const first = specimen(name, '2001:db8::1234');
        first.data.dstip = left;
        const second = structuredClone(first);
        second.id += '-copy';
        second.data.dstip = right;
        const rules = build([first, second]);
        assert.equal(rules.length, 2);
        assert.notEqual(rules[0].id, rules[1].id);
        const firstRules = build([first]);
        assert.equal(gate({ ...trustedContext(name, first), destinationAddress: right }, firstRules).action, 'pass');
        const normal = fixture(name).find(alert => decide(alert).action === 'record');
        normal.data.dstip = right;
        assert.equal(decide(normal).action, 'record');
        assert.equal(build([first, normal]).length, 1);
      }
    });

    test('exfiltration: malformed destination evidence cannot bind, coerce or suppress a valid candidate', () => {
      const valid = specimen(name, '192.0.2.1');
      const [validRule] = build([valid]);
      const context = trustedContext(name, valid);
      let conversions = 0;
      for (const destinationAddress of invalidAddresses(() => { conversions++; })) {
        const corrupt = { ...validRule, destinationAddress };
        assert.equal(gate({ ...context, destinationAddress }, [corrupt]).action, 'pass');
        assert.equal(gate(context, [corrupt, validRule]).ruleId, validRule.id);
        const invalid = { ...valid, id: valid.id + '-bad', data: { ...valid.data, dstip: destinationAddress } };
        assert.deepEqual(build([invalid, valid]), [validRule]);
      }
      assert.equal(conversions, 0);
    });
  }
}
