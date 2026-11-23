import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decide as bruteForceDecide } from '../xdr/brute-force/decide.mjs';
import { extractAlert as bruteForceDisplay } from '../xdr/brute-force/read-alerts.mjs';
import { failureCount, isFailureDescription, matchStrongPattern } from '../xdr/brute-force/match.mjs';
import { buildDenyCandidates as bruteForceCandidates } from '../xdr/brute-force/ztna-gate.mjs';
import { candidateExpiry } from '../xdr/candidate-validation.mjs';

const names = ['brute-force', 'web-injection', 'known-cve', 'persistence', 'privilege', 'exfiltration'];
const contextFields = {
  'brute-force': ['sourceAddress', 'account'],
  'web-injection': ['sourceAddress', 'path'],
  'known-cve': ['sourceAddress', 'path', 'eventId'],
  persistence: ['deviceId', 'agentName', 'sourceAddress', 'account', 'eventId'],
  privilege: ['sessionId', 'subjectId', 'agentName', 'account', 'sourceAddress', 'eventId'],
  exfiltration: ['sourceAddress', 'destinationAddress', 'account', 'agentName', 'eventId'],
};

const flags = {
  'brute-force': [],
  'web-injection': [],
  'known-cve': [],
  persistence: ['agentBindingVerified'],
  privilege: ['subjectBindingVerified', 'sessionBindingVerified', 'eventCorrelatedVerified'],
  exfiltration: ['sourceBindingVerified', 'destinationBindingVerified', 'accountBindingVerified', 'eventCorrelatedVerified'],
};

function specimen(name) {
  const { alerts } = JSON.parse(readFileSync(new URL(`../xdr/fixtures/${name}.json`, import.meta.url), 'utf8'));
  const alert = name === 'brute-force' ? alerts.find(row => row.id === 'bf-02') : alerts[0];
  // A synthetic route supplies the candidate's required provenance; the
  // original CVE fixture deliberately contains only the raw lookup header.
  if (name === 'known-cve') alert.data.url = '/notes';
  return alert;
}

function proposal(alert, decide) {
  return { alertId: alert.id, ...decide(alert) };
}

function trustedContext(alert, name) {
  return {
    verifiedByServer: true,
    ...Object.fromEntries(flags[name].map(flag => [flag, true])),
    sourceAddress: alert.data.srcip,
    destinationAddress: alert.data.dstip,
    account: alert.data.srcuser,
    agentName: alert.agent.name,
    at: alert.timestamp,
    eventId: alert.id,
    path: new URL(alert.data.url ?? '/', 'https://offline.invalid').pathname,
    deviceId: '0123456789abcdef',
    subjectId: 'fixture-subject-0001',
    sessionId: 'fixture-session-0001',
  };
}

function malformedConfidences(valid, converted) {
  return [undefined, null, NaN, Infinity, -Infinity, -1, 0, 0.849999, 1.000001, 2,
    String(valid), true, false, [], [valid], {}, new Number(valid), Symbol('confidence'),
    { valueOf() { converted(); return valid; } },
    { [Symbol.toPrimitive]() { converted(); throw new Error('must not coerce confidence'); } }];
}

function freezeStoredInput(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeStoredInput(item);
    Object.freeze(value);
  }
  return value;
}

test('candidate expiry requires primitive safe milliseconds and a fully representable lifetime without coercion', () => {
  const limit = 8_640_000_000_000_000;
  const ttl = 15 * 60 * 1000;
  for (const start of [-limit, 0, limit - ttl]) {
    assert.deepEqual(candidateExpiry(start, ttl), {
      expiresMs: start + ttl, expiresAt: new Date(start + ttl).toISOString(),
    });
  }
  let conversions = 0;
  const coercible = { valueOf() { conversions++; return 0; } };
  const throwing = { [Symbol.toPrimitive]() { conversions++; throw new Error('milliseconds must not be coerced'); } };
  const invalid = [undefined, null, '', '0', true, false, NaN, Infinity, -Infinity, 0.5,
    Number.MAX_SAFE_INTEGER + 1, [], [0], {}, new Number(0), Symbol('milliseconds'), 0n, coercible, throwing];
  for (const value of invalid) {
    assert.equal(candidateExpiry(value, ttl), null);
    assert.equal(candidateExpiry(0, value), null);
  }
  for (const start of [-limit - 1, limit - ttl + 1, limit, limit + 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(candidateExpiry(start, ttl), null);
  }
  for (const invalidTtl of [0, -1, -ttl, Number.MAX_SAFE_INTEGER]) {
    assert.equal(candidateExpiry(0, invalidTtl), null);
  }
  assert.equal(conversions, 0);
});

for (const name of names) {
  const { decide } = await import(`../xdr/${name}/decide.mjs`);
  const { extractAlert } = await import(`../xdr/${name}/read-alerts.mjs`);
  const { buildDenyCandidates, checkZTNAExtra } = await import(`../xdr/${name}/${name === 'brute-force' ? 'ztna-gate' : 'respond'}.mjs`);

  test(`${name}: candidates retain an exact fifteen-minute lifetime at both Date range boundaries`, () => {
    const limit = 8_640_000_000_000_000;
    const ttl = 15 * 60 * 1000;
    for (const start of [-limit, limit - ttl, Date.parse('2026-11-23T00:00:00Z')]) {
      const alert = freezeStoredInput({ ...specimen(name), timestamp: new Date(start).toISOString() });
      assert.equal(decide(alert).action, 'block');
      const rules = buildDenyCandidates(freezeStoredInput([alert]), freezeStoredInput([proposal(alert, decide)]));
      assert.equal(rules.length, 1);
      assert.equal(rules[0].startsAt, alert.timestamp);
      assert.equal(Date.parse(rules[0].expiresAt), start + ttl);
      assert.equal(Date.parse(rules[0].expiresAt) - Date.parse(rules[0].startsAt), ttl);
      const context = trustedContext(alert, name);
      for (const [at, action] of [[start, 'deny'], [start + ttl - 1, 'deny'], [start + ttl, 'pass']]) {
        const trusted = freezeStoredInput({ ...context, at: new Date(at).toISOString() });
        assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: trusted, rules: freezeStoredInput(rules) }).action, action);
      }
    }
  });

  test(`${name}: unrepresentable candidate expiry is skipped without changing valid earlier or following evidence`, () => {
    const limit = 8_640_000_000_000_000;
    const ttl = 15 * 60 * 1000;
    for (const start of [limit - ttl + 1, limit]) {
      const base = specimen(name);
      const invalid = freezeStoredInput({ ...base, id: base.id + '-overflow', timestamp: new Date(start).toISOString() });
      assert.equal(decide(invalid).action, 'block', 'the original observation itself is a representable Date');
      assert.deepEqual(buildDenyCandidates([invalid], [proposal(invalid, decide)]), []);
      for (const timestamp of [base.timestamp, new Date(limit - ttl).toISOString()]) {
        const valid = freezeStoredInput({ ...base, timestamp });
        const expected = buildDenyCandidates([valid], [proposal(valid, decide)]);
        assert.equal(expected.length, 1);
        for (const alerts of [[invalid, valid], [valid, invalid]]) {
          const frozen = freezeStoredInput(alerts);
          const actual = buildDenyCandidates(frozen, freezeStoredInput(frozen.map(alert => proposal(alert, decide))));
          assert.deepEqual(actual, expected, 'overflow cannot append evidence, widen a window, or stop the batch');
        }
      }
    }
  });

  test(`${name}: candidate confidence must exactly match numeric independent evidence`, () => {
    const alert = specimen(name);
    const choice = proposal(alert, decide);
    const rules = buildDenyCandidates([alert], [choice]);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].confidence, choice.confidence);
    let conversions = 0;
    const invalid = malformedConfidences(choice.confidence, () => { conversions++; });
    invalid.push(...[0.85, 0.99, 1].filter(value => value !== choice.confidence));
    for (const confidence of invalid) {
      assert.deepEqual(buildDenyCandidates([alert], [{ ...choice, confidence }]), []);
    }
    const missing = { ...choice };
    delete missing.confidence;
    assert.deepEqual(buildDenyCandidates([alert], [missing]), []);
    assert.equal(conversions, 0);
  });

  test(`${name}: all server attestation flags require the exact boolean true`, () => {
    const alert = specimen(name);
    const rules = buildDenyCandidates([alert], [proposal(alert, decide)]);
    const context = trustedContext(alert, name);
    const gate = trusted => checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: trusted, rules });
    assert.equal(gate(context).action, 'deny');
    for (const flag of ['verifiedByServer', ...flags[name]]) {
      for (const value of [undefined, null, false, 'false', 'true', '', 0, 1, NaN, [], {}, new Boolean(true), Symbol('true')]) {
        const unverified = { ...context, [flag]: value };
        assert.equal(gate(unverified).action, 'pass', flag);
        for (const upstreamDecision of ['deny', 'step_up']) {
          assert.equal(checkZTNAExtra({ upstreamDecision, trustedContext: unverified, rules }).action, 'preserve');
        }
      }
      const missing = { ...context };
      delete missing[flag];
      assert.equal(gate(missing).action, 'pass');
    }
  });

  test(`${name}: trusted observation time is parsed only from a string without coercion`, () => {
    const alert = specimen(name);
    const [rule] = buildDenyCandidates([alert], [proposal(alert, decide)]);
    // This interval deliberately includes Date.parse(2000), so accepting a
    // numeric year cannot hide behind the fixture's otherwise expired window.
    const rules = freezeStoredInput([{ ...rule, startsAt: '1999-01-01T00:00:00Z', expiresAt: '2001-01-01T00:00:00Z' }]);
    const context = trustedContext(alert, name);
    const validAt = '2000-01-01T00:00:00Z';
    let conversions = 0;
    for (const at of [undefined, null, '', 'invalid-date', NaN, Infinity, 2000, true, false, {},
      [validAt], new String(validAt), new Date(validAt), Symbol('at'),
      { toString() { conversions++; return validAt; } },
      { [Symbol.toPrimitive]() { conversions++; throw new Error('must not coerce trusted dates'); } }]) {
      const trusted = freezeStoredInput({ ...context, at });
      assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: trusted, rules }).action, 'pass');
      for (const upstreamDecision of ['deny', 'step_up']) {
        assert.equal(checkZTNAExtra({ upstreamDecision, trustedContext: trusted, rules }).action, 'preserve');
      }
    }
    for (const at of [validAt, new Date(validAt).toISOString(), new Date(validAt).toUTCString()]) {
      const trusted = freezeStoredInput({ ...context, at });
      assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: trusted, rules }).action, 'deny');
    }
    assert.equal(conversions, 0);
  });

  test(`${name}: all consumed context scope fields require nonempty strings before interpretation`, () => {
    const alert = specimen(name);
    const rules = freezeStoredInput(buildDenyCandidates([alert], [proposal(alert, decide)]));
    const context = trustedContext(alert, name);
    let conversions = 0;
    for (const field of contextFields[name]) {
      for (const value of [undefined, null, '', 0, 2000, false, true, {}, [], [context[field]],
        new String(context[field]), Symbol(field),
        { toString() { conversions++; return context[field]; } },
        { [Symbol.toPrimitive]() { conversions++; throw new Error('must not coerce trusted scope'); } }]) {
        const trusted = freezeStoredInput({ ...context, [field]: value });
        assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: trusted, rules }).action, 'pass', field);
        for (const upstreamDecision of ['deny', 'step_up']) {
          assert.equal(checkZTNAExtra({ upstreamDecision, trustedContext: trusted, rules }).action, 'preserve');
        }
      }
      const missing = { ...context };
      delete missing[field];
      assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: freezeStoredInput(missing), rules }).action, 'pass', field);
    }
    assert.equal(conversions, 0);
    assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: freezeStoredInput(context), rules }).action, 'deny');
  });

  test(`${name}: equally missing or malformed scope values cannot bind a stored candidate to a context`, () => {
    const alert = specimen(name);
    const [rule] = buildDenyCandidates([alert], [proposal(alert, decide)]);
    const context = trustedContext(alert, name);
    for (const field of contextFields[name].filter(key => Object.hasOwn(rule, key))) {
      for (const value of [undefined, null, '', 0, false, {}, [], Symbol(field)]) {
        const badRule = freezeStoredInput({ ...rule, [field]: value });
        const trusted = freezeStoredInput({ ...context, [field]: value });
        assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: trusted, rules: freezeStoredInput([badRule]) }).action, 'pass', field);
        const withValidFollower = freezeStoredInput([badRule, { ...rule }]);
        assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: freezeStoredInput(context), rules: withValidFollower }).ruleId, rule.id, field);
      }
      const missingRule = { ...rule }, missingContext = { ...context };
      delete missingRule[field];
      delete missingContext[field];
      assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: freezeStoredInput(missingContext), rules: freezeStoredInput([missingRule]) }).action, 'pass', field);
    }
  });

  test(`${name}: malformed stored candidate confidence never creates a denial`, () => {
    const alert = specimen(name);
    const [rule] = buildDenyCandidates([alert], [proposal(alert, decide)]);
    assert.ok(rule);
    const context = trustedContext(alert, name);
    let conversions = 0;
    for (const confidence of malformedConfidences(rule.confidence, () => { conversions++; })) {
      const result = checkZTNAExtra({
        upstreamDecision: 'allow', trustedContext: context, rules: [{ ...rule, confidence }],
      });
      assert.equal(result.action, 'pass');
    }
    assert.equal(conversions, 0);
  });

  test(`${name}: stored rule identifiers and scope fields must retain their types`, () => {
    const alert = specimen(name);
    const [rule] = buildDenyCandidates([alert], [proposal(alert, decide)]);
    const context = freezeStoredInput(trustedContext(alert, name));
    const fields = ['id', 'sourceAddress', 'account', 'path', 'agentName', 'destinationAddress']
      .filter(field => Object.hasOwn(rule, field));
    for (const field of fields) {
      for (const value of [undefined, null, '', 0, false, {}, [rule[field]], Symbol(field)]) {
        const rules = freezeStoredInput([{ ...rule, [field]: value }]);
        assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules }).action, 'pass', field);
      }
      const missing = { ...rule };
      delete missing[field];
      const rules = freezeStoredInput([missing]);
      assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules }).action, 'pass', field);
    }
  });

  test(`${name}: stored evidence IDs must be a nonempty array of nonempty strings`, () => {
    const alert = specimen(name);
    const [rule] = buildDenyCandidates([alert], [proposal(alert, decide)]);
    const context = freezeStoredInput(trustedContext(alert, name));
    for (const evidenceAlertIds of [undefined, null, alert.id, 0, false, {}, [], [null], [''], [[alert.id]],
      [Symbol('id')], [alert.id, null], [alert.id, {}], [alert.id, [alert.id]]]) {
      const rules = freezeStoredInput([{ ...rule, evidenceAlertIds }]);
      assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules }).action, 'pass');
    }
    const missing = { ...rule };
    delete missing.evidenceAlertIds;
    assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules: freezeStoredInput([missing]) }).action, 'pass');
  });

  test(`${name}: stored pattern labels must be present with the generated scalar or array shape`, () => {
    const alert = specimen(name);
    const [rule] = buildDenyCandidates([alert], [proposal(alert, decide)]);
    const context = freezeStoredInput(trustedContext(alert, name));
    const field = name === 'brute-force' ? 'pattern' : 'patterns';
    const pattern = name === 'brute-force' ? rule.pattern : rule.patterns[0];
    const malformed = [undefined, null, 0, false, {}, [], [null], [''], [[pattern]], Symbol('pattern')];
    if (name === 'brute-force') malformed.push('', [pattern]);
    else malformed.push(pattern, [pattern, null], [pattern, {}], [pattern, [pattern]]);
    for (const value of malformed) {
      const rules = freezeStoredInput([{ ...rule, [field]: value }]);
      assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules }).action, 'pass');
    }
    const missing = { ...rule };
    delete missing[field];
    assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules: freezeStoredInput([missing]) }).action, 'pass');
  });

  test(`${name}: stored validity windows require string times and a finite increasing interval`, () => {
    const alert = specimen(name);
    const [rule] = buildDenyCandidates([alert], [proposal(alert, decide)]);
    const context = freezeStoredInput(trustedContext(alert, name));
    let conversions = 0;
    for (const field of ['startsAt', 'expiresAt']) {
      for (const value of [undefined, null, '', 'invalid-date', '999999999999999999999999', NaN, Infinity,
        field === 'startsAt' ? 2000 : 2099, true, false, {}, [rule[field]], new Date(rule[field]), Symbol(field),
        { toString() { conversions++; return rule[field]; } },
        { [Symbol.toPrimitive]() { conversions++; throw new Error('must not coerce stored dates'); } }]) {
        const rules = freezeStoredInput([{ ...rule, [field]: value }]);
        assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules }).action, 'pass', field);
      }
      const missing = { ...rule };
      delete missing[field];
      assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules: freezeStoredInput([missing]) }).action, 'pass');
    }
    for (const corrupt of [
      { ...rule, expiresAt: rule.startsAt },
      { ...rule, startsAt: rule.expiresAt, expiresAt: rule.startsAt },
    ]) {
      assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules: freezeStoredInput([corrupt]) }).action, 'pass');
    }
    assert.equal(conversions, 0);
  });

  test(`${name}: corrupt stored rows do not suppress valid following rules or alter interval boundaries`, () => {
    const alert = specimen(name);
    const [rule] = buildDenyCandidates([alert], [proposal(alert, decide)]);
    const context = freezeStoredInput(trustedContext(alert, name));
    const patternField = name === 'brute-force' ? 'pattern' : 'patterns';
    const corrupt = [null, undefined, [], 0, false, 'rule',
      { ...rule, evidenceAlertIds: null }, { ...rule, [patternField]: null },
      { ...rule, startsAt: Symbol('date') }, { ...rule, expiresAt: 2099 }];
    const valid = { ...JSON.parse(JSON.stringify(rule)), harmlessExtra: { label: 'retained' } };
    const rules = freezeStoredInput([...corrupt, valid]);
    const expected = { action: 'deny', reason: name === 'brute-force' ? rule.pattern : rule.patterns[0], ruleId: rule.id };
    assert.deepEqual(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules }), expected);
    for (const upstreamDecision of ['deny', 'step_up']) {
      assert.equal(checkZTNAExtra({ upstreamDecision, trustedContext: context, rules }).action, 'preserve');
    }
    for (const format of [value => value, value => new Date(value).toISOString(), value => new Date(value).toUTCString()]) {
      const formatted = freezeStoredInput([{ ...rule, startsAt: format(rule.startsAt), expiresAt: format(rule.expiresAt) }]);
      assert.deepEqual(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: context, rules: formatted }), expected);
      for (const [at, action] of [
        [new Date(Date.parse(rule.startsAt) - 1).toISOString(), 'pass'],
        [rule.startsAt, 'deny'],
        [new Date(Date.parse(rule.expiresAt) - 1).toISOString(), 'deny'],
        [rule.expiresAt, 'pass'],
      ]) {
        const trusted = freezeStoredInput({ ...context, at });
        assert.equal(checkZTNAExtra({ upstreamDecision: 'allow', trustedContext: trusted, rules: formatted }).action, action);
      }
    }
  });

  test(`${name}: raw semantic bounds do not change the redacted five-field display contract`, () => {
    const alert = specimen(name);
    for (const padding of [0, 511, 512, 550, 1023, 1024, 4096]) {
      const raw = {
        ...alert,
        rule: { ...alert.rule, description: ' '.repeat(padding) + alert.rule.description },
      };
      const bounded = { ...raw, rule: { ...raw.rule, description: raw.rule.description.slice(0, 1024) } };
      assert.deepEqual(decide(raw), decide(bounded));
    }
    const sensitive = {
      ...alert,
      rule: { ...alert.rule, description: 'token=fixture-private-marker ' + alert.rule.description },
    };
    const display = extractAlert(sensitive);
    assert.deepEqual(Object.keys(display), ['at', 'sourceAddress', 'account', 'ruleLevel', 'description']);
    assert.ok(display.description.length <= 512);
    assert.doesNotMatch(display.description, /fixture-private-marker/u);
    const candidate = buildDenyCandidates([sensitive], [proposal(sensitive, decide)]);
    assert.doesNotMatch(JSON.stringify(candidate), /fixture-private-marker/u);
    assert.deepEqual(buildDenyCandidates([display], [proposal(sensitive, decide)]), []);
  });
}

test('brute-force corroboration uses all 1,024 raw description characters, independently of display truncation', () => {
  const alert = specimen('brute-force');
  const original = bruteForceDecide(alert);
  for (const padding of [550, 1024 - alert.rule.description.length]) {
    const padded = { ...alert, rule: { ...alert.rule, description: ' '.repeat(padding) + alert.rule.description } };
    assert.deepEqual(bruteForceDecide(padded), original);
    assert.deepEqual(matchStrongPattern(padded), { name: original.reason, confidence: original.confidence });
    assert.equal(bruteForceCandidates([padded], [proposal(padded, bruteForceDecide)]).length, 1);
    assert.equal(bruteForceDisplay(padded).description.length, 512);
  }
});

function countedAlert() {
  const base = specimen('brute-force');
  return {
    ...base,
    rule: { ...base.rule, level: 6, description: 'Failed login from the same IP within 5 minutes. ' },
    data: { srcip: base.data.srcip, srcuser: base.data.srcuser },
  };
}

test('brute-force textual failure counts share the semantic boundary and cannot forge a block candidate', () => {
  const base = countedAlert();
  const suffix = '50 failed login attempts';
  for (const offset of [base.rule.description.length, 550, 1024 - suffix.length, 1024, 1146]) {
    const alert = {
      ...base,
      data: { ...base.data },
      rule: { ...base.rule, description: base.rule.description.padEnd(offset, ' ') + suffix },
    };
    const visible = offset + suffix.length <= 1024;
    assert.equal(failureCount(alert), visible ? 50 : 0);
    assert.equal(bruteForceDecide(alert).action, visible ? 'block' : 'alert');
    assert.deepEqual(matchStrongPattern(alert), visible ? { name: 'rapid_source_login_failures', confidence: 0.96 } : null);
    const forged = { alertId: alert.id, action: 'block', confidence: 0.96, reason: 'rapid_source_login_failures' };
    assert.equal(bruteForceCandidates([alert], [forged]).length, visible ? 1 : 0);
    alert.data.failures = '50';
    assert.equal(failureCount(alert), 50, 'explicit numeric evidence remains independent of textual truncation');
    assert.equal(bruteForceDecide(alert).action, 'block');
    assert.equal(matchStrongPattern(alert)?.name, 'rapid_source_login_failures');
  }
});

test('brute-force count aliases accept only bounded numeric scalars without coercing descriptions or values', () => {
  let conversions = 0;
  const coercible = { toString() { conversions++; return '50'; } };
  for (const field of ['count', 'failures', 'failure_count', 'failCount', 'attempts', 'login_failures', 'failedAttempts']) {
    const alert = countedAlert();
    const target = field === 'failedAttempts' ? alert : alert.data;
    for (const value of [20, '20', 50, '99999']) {
      target[field] = value;
      assert.equal(failureCount(alert), Number(value));
      assert.equal(bruteForceDecide(alert).action, 'block');
      assert.equal(matchStrongPattern(alert)?.name, bruteForceDecide(alert).reason);
    }
    for (const value of [0, '0', undefined, null, false, NaN, Infinity, -1, 1.5, 100000, '100000', '5e1', ' 50', [50], coercible, Symbol('50'), 50n]) {
      target[field] = value;
      assert.equal(failureCount(alert), 0);
      assert.equal(bruteForceDecide(alert).action, 'alert');
      assert.equal(matchStrongPattern(alert), null);
    }
  }
  for (const description of [null, undefined, [], ['50 failed login attempts'], Symbol('description'), {
    toString() { conversions++; return '50 failed login attempts'; },
  }]) {
    const alert = countedAlert();
    alert.rule.description = description;
    assert.equal(failureCount(alert), 0);
    assert.equal(isFailureDescription(description), false);
    assert.equal(bruteForceDecide(alert).action, 'record');
    assert.equal(matchStrongPattern(alert), null);
  }
  assert.equal(conversions, 0);
});

test('brute-force raw fields retain precedence and actual five-field projections stay independently classifiable', () => {
  const raw = specimen('brute-force');
  const hybrid = {
    ...raw, at: 'invalid', sourceAddress: 'not-an-ip', account: 'other_user',
    ruleLevel: 0, description: 'Successful ordinary login',
  };
  assert.deepEqual(bruteForceDecide(hybrid), bruteForceDecide(raw));
  assert.deepEqual(matchStrongPattern(hybrid), matchStrongPattern(raw));
  assert.equal(bruteForceCandidates([hybrid], [proposal(hybrid, bruteForceDecide)]).length, 1);
  const { alerts } = JSON.parse(readFileSync(new URL('../xdr/fixtures/brute-force.json', import.meta.url), 'utf8'));
  for (const alert of alerts) {
    const row = bruteForceDisplay(alert);
    const decision = bruteForceDecide(row);
    assert.deepEqual(matchStrongPattern(row), decision.action === 'block'
      ? { name: decision.reason, confidence: decision.confidence } : null);
    assert.deepEqual(bruteForceCandidates([row], [{ alertId: alert.id, ...decision }]), []);
  }
});

test('web-injection repetition evidence cannot come from beyond its bounded description', async () => {
  const { decide } = await import('../xdr/web-injection/decide.mjs');
  const { buildDenyCandidates } = await import('../xdr/web-injection/respond.mjs');
  const base = specimen('web-injection');
  delete base.data.count;
  const prefix = '같은 주소에서 SQL 구문 요청이 반복됐습니다. ';
  const suffix = '12번 반복됐습니다.';
  for (const offset of [prefix.length, 550, 1024 - suffix.length, 1024, 1146]) {
    const alert = { ...base, data: { ...base.data }, rule: { ...base.rule, description: prefix.padEnd(offset, ' ') + suffix } };
    const visible = offset + suffix.length <= 1024;
    assert.equal(decide(alert).action, visible ? 'block' : 'alert');
    const forged = { alertId: alert.id, action: 'block', confidence: 0.95, reason: 'repeated_sql_injection' };
    assert.equal(buildDenyCandidates([alert], [forged]).length, visible ? 1 : 0);
    alert.data.count = '12';
    assert.equal(decide(alert).action, 'block');
    assert.equal(buildDenyCandidates([alert], [proposal(alert, decide)]).length, 1);
  }
});
