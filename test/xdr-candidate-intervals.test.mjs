import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const names = ['brute-force', 'web-injection', 'known-cve', 'persistence', 'privilege', 'exfiltration'];
const start = Date.parse('2026-11-23T10:00:00.000Z');
const ttl = 15 * 60_000;
const iso = value => new Date(value).toISOString();

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

function context(alert, at = Date.parse(alert.timestamp)) {
  return {
    verifiedByServer: true, agentBindingVerified: true,
    subjectBindingVerified: true, sessionBindingVerified: true, eventCorrelatedVerified: true,
    sourceBindingVerified: true, destinationBindingVerified: true, accountBindingVerified: true,
    sourceAddress: alert.data.srcip, destinationAddress: alert.data.dstip,
    account: alert.data.srcuser, agentName: alert.agent.name,
    eventId: alert.id, at: iso(at),
    path: new URL(alert.data.url ?? '/', 'https://offline.invalid').pathname,
    deviceId: '0123456789abcdef', subjectId: 'fixture-subject-0001', sessionId: 'fixture-session-0001',
  };
}

function permutations(rows) {
  if (rows.length < 2) return [rows];
  return rows.flatMap((row, index) => permutations(rows.filter((_, position) => position !== index))
    .map(tail => [row, ...tail]));
}

for (const name of names) {
  const fixtures = JSON.parse(readFileSync(new URL(`../xdr/fixtures/${name}.json`, import.meta.url), 'utf8')).alerts;
  const { decide } = await import(`../xdr/${name}/decide.mjs`);
  const { buildDenyCandidates, checkZTNAExtra } = await import(`../xdr/${name}/${name === 'brute-force' ? 'ztna-gate' : 'respond'}.mjs`);
  const base = structuredClone(name === 'brute-force' ? fixtures.find(alert => alert.id === 'bf-02') : fixtures[0]);
  if (name === 'known-cve') base.data.url = '/notes';
  const event = (offset, suffix = 'copy') => ({ ...structuredClone(base), id: base.id + '-' + suffix, timestamp: iso(start + offset) });
  const build = alerts => buildDenyCandidates(freeze(alerts), freeze(alerts.map(alert => ({ alertId: alert.id, ...decide(alert) }))));
  const gate = (trustedContext, rules, upstreamDecision = 'allow') => checkZTNAExtra({
    trustedContext: freeze(trustedContext), rules: freeze(rules), upstreamDecision,
  });

  test(`${name}: separated windows preserve scope ID and match the union of individual time support`, () => {
    const alerts = [event(0, 'first'), event(2 * ttl, 'second'), event(4 * ttl, 'third')];
    const individual = alerts.map(alert => build([alert]));
    assert.ok(individual.every(rules => rules.length === 1));
    assert.equal(new Set(individual.map(rules => rules[0].id)).size, 1, 'scope identity remains independent of event time');
    const times = [-1, 0, ttl - 1, ttl, ttl + 1, 2 * ttl - 1, 2 * ttl,
      3 * ttl - 1, 3 * ttl, 4 * ttl - 1, 4 * ttl, 5 * ttl - 1, 5 * ttl];
    for (const rows of [alerts, [...alerts].reverse()]) {
      const rules = build(rows);
      assert.equal(rules.length, 1, 'one candidate per scope avoids duplicate rule IDs');
      assert.equal(rules[0].id, individual[0][0].id);
      assert.deepEqual(rules[0].validityIntervals.map(interval => ({
        start: Date.parse(interval.startsAt), end: Date.parse(interval.expiresAt), ids: interval.evidenceAlertIds,
      })), alerts.map(alert => ({ start: Date.parse(alert.timestamp), end: Date.parse(alert.timestamp) + ttl, ids: [alert.id] })));
      for (const alert of alerts) {
        for (const offset of times) {
          const trusted = context(alert, start + offset);
          const expected = individual.some(candidate => gate(trusted, candidate).action === 'deny') ? 'deny' : 'pass';
          assert.equal(gate(trusted, rules).action, expected, `${alert.id} at ${offset}`);
        }
      }
    }
  });

  test(`${name}: overlap, adjacency and out-of-order bridges retain connected membership; a one-ms gap stays open`, () => {
    for (const separation of [0, ttl - 1, ttl, ttl + 1]) {
      const first = event(0, 'first'), second = event(separation, 'second');
      for (const rows of [[first, second], [second, first]]) {
        const [rule] = build(rows);
        assert.equal(Date.parse(rule.startsAt), start);
        assert.equal(Date.parse(rule.expiresAt), start + separation + ttl);
        if (separation <= ttl) {
          assert.equal(Object.hasOwn(rule, 'validityIntervals'), false, 'legacy connected representation remains intact');
          for (const alert of [first, second]) {
            assert.equal(gate(context(alert, start + separation + ttl - 1), [rule]).action, 'deny',
              'a connected component keeps its existing shared evidence membership');
          }
        } else {
          assert.equal(rule.validityIntervals.length, 2);
          assert.equal(gate(context(first, start + ttl), [rule]).action, 'pass');
          assert.equal(gate(context(second, start + separation), [rule]).action, 'deny');
        }
        assert.equal(gate(context(second, start + separation + ttl), [rule]).action, 'pass');
      }
    }
    const first = event(0, 'first'), last = event(2 * ttl, 'last'), bridge = event(ttl, 'bridge');
    const expectedId = build([first])[0].id;
    for (const rows of permutations([first, last, bridge])) {
      const [rule] = build(rows);
      assert.equal(rule.id, expectedId);
      assert.equal(Object.hasOwn(rule, 'validityIntervals'), false);
      assert.equal(Date.parse(rule.startsAt), start);
      assert.equal(Date.parse(rule.expiresAt), start + 3 * ttl);
      assert.deepEqual([...rule.evidenceAlertIds].sort(), [first.id, last.id, bridge.id].sort());
      for (const alert of rows) assert.equal(gate(context(alert, start + ttl), [rule]).action, 'deny');
    }
  });

  test(`${name}: epoch ordering, representable extremes and distinct scopes remain independent`, () => {
    const limit = 8_640_000_000_000_000;
    const early = { ...event(0, 'early'), timestamp: iso(-limit) };
    const late = { ...event(0, 'late'), timestamp: iso(limit - ttl) };
    const ordinary = { ...event(0, 'ordinary'), timestamp: '2026-11-23T11:00:00+01:00' };
    const overflow = { ...event(0, 'overflow'), timestamp: iso(limit - ttl + 1) };
    const [rule] = build([late, ordinary, overflow, early]);
    assert.deepEqual(rule.validityIntervals.map(interval => Date.parse(interval.startsAt)), [-limit, start, limit - ttl]);
    assert.deepEqual(new Set(rule.evidenceAlertIds), new Set([late.id, ordinary.id, early.id]));
    assert.equal(rule.id, build([early])[0].id);
    for (const alert of [early, ordinary, late]) {
      const time = Date.parse(alert.timestamp);
      for (const [at, expected] of [[time, 'deny'], [time + ttl - 1, 'deny'], [time + ttl, 'pass']]) {
        assert.equal(gate(context(alert, at), [rule]).action, expected);
      }
    }
    for (const scope of ['source', 'account', 'path', 'agent', 'destination']) {
      const changed = event(2 * ttl, 'other-' + scope);
      const applicable = scope === 'source'
        || scope === 'account' && Object.hasOwn(rule, 'account')
        || scope === 'path' && Object.hasOwn(rule, 'path')
        || scope === 'agent' && Object.hasOwn(rule, 'agentName')
        || scope === 'destination' && Object.hasOwn(rule, 'destinationAddress');
      if (!applicable) continue;
      if (scope === 'source') changed.data.srcip = '192.0.2.234';
      if (scope === 'account') changed.data.srcuser = 'fixture-other-account';
      if (scope === 'path') {
        const url = new URL(changed.data.url, 'https://offline.invalid');
        changed.data.url = '/different-route' + url.search;
      }
      if (scope === 'agent') changed.agent.name = 'fixture-other-agent';
      if (scope === 'destination') changed.data.dstip = '203.0.113.234';
      const original = event(0, 'same');
      const split = build([changed, original]);
      assert.equal(split.length, 2, scope);
      assert.equal(new Set(split.map(candidate => candidate.id)).size, 2, scope);
      assert.deepEqual(split.map(candidate => candidate.id), [...split.map(candidate => candidate.id)].sort(), scope);
      assert.equal(gate(context(changed), build([original])).action, 'pass', scope);
    }
  });

  test(`${name}: active component owns its evidence, pattern and confidence after serialization`, () => {
    const first = event(0, 'first');
    const firstDecision = decide(first);
    const path = context(first).path;
    let second;
    for (const specimen of fixtures) {
      const candidate = structuredClone(specimen);
      candidate.id = base.id + '-different';
      candidate.timestamp = iso(start + 2 * ttl);
      candidate.agent.name = first.agent.name;
      candidate.data.srcip = first.data.srcip;
      candidate.data.srcuser = first.data.srcuser;
      if (['web-injection', 'known-cve'].includes(name)) {
        const url = new URL(candidate.data.url ?? path, 'https://offline.invalid');
        candidate.data.url = path + url.search;
      }
      if (name === 'exfiltration') candidate.data.dstip = first.data.dstip;
      const outcome = decide(candidate);
      if (outcome.action === 'block' && outcome.reason !== firstDecision.reason && build([candidate]).length === 1) {
        second = candidate;
        break;
      }
    }
    assert.ok(second, 'the fixture must provide independent strong evidence with another pattern');
    for (const rows of [[first, second], [second, first]]) {
      const rules = JSON.parse(JSON.stringify(build(rows)));
      assert.equal(rules.length, 1);
      for (const alert of [first, second]) {
        const expected = decide(alert);
        const interval = rules[0].validityIntervals.find(item => item.evidenceAlertIds.includes(alert.id));
        assert.equal(interval.confidence, expected.confidence);
        assert.equal(name === 'brute-force' ? interval.pattern : interval.patterns[0], expected.reason);
        const actual = gate(context(alert), rules);
        assert.deepEqual(actual, { action: 'deny', reason: expected.reason, ruleId: rules[0].id });
        const other = alert === first ? second : first;
        assert.equal(gate({ ...context(alert), eventId: other.id }, rules).action,
          rules[0].requiresEventCorrelation ? 'pass' : 'deny');
      }
    }
  });

  test(`${name}: malformed interval evidence never falls back to the envelope or masks a valid following rule`, () => {
    const first = event(0, 'first'), second = event(2 * ttl, 'second');
    const [valid] = build([first, second]);
    const standalone = build([first])[0];
    const corrupt = [];
    for (const value of [undefined, null, false, 1, 'intervals', {}, [], new Array(2), Symbol('intervals')]) {
      corrupt.push({ ...structuredClone(valid), validityIntervals: value });
    }
    for (const value of [undefined, null, false, 1, 'interval', [], Symbol('interval')]) {
      const rule = structuredClone(valid);
      rule.validityIntervals[0] = value;
      corrupt.push(rule);
    }
    const mutate = change => { const rule = structuredClone(valid); change(rule); corrupt.push(rule); };
    mutate(rule => rule.validityIntervals.reverse());
    mutate(rule => { rule.validityIntervals[1].startsAt = rule.validityIntervals[0].expiresAt; });
    mutate(rule => { rule.validityIntervals[0].startsAt = iso(start + 1); });
    mutate(rule => { rule.validityIntervals[1].expiresAt = iso(start + 3 * ttl + 1); });
    mutate(rule => { rule.validityIntervals[0].expiresAt = rule.validityIntervals[0].startsAt; });
    mutate(rule => { rule.validityIntervals[0].evidenceAlertIds = [base.id + '-foreign']; });
    mutate(rule => { rule.evidenceAlertIds.push(base.id + '-unassociated'); });
    let conversions = 0;
    const coercible = { [Symbol.toPrimitive]() { conversions++; throw new Error('interval value must not be coerced'); } };
    for (const field of ['startsAt', 'expiresAt', 'evidenceAlertIds', 'confidence', name === 'brute-force' ? 'pattern' : 'patterns']) {
      for (const value of [undefined, null, false, 0, {}, [], Symbol(field), coercible]) {
        mutate(rule => { rule.validityIntervals[0][field] = value; });
      }
    }
    for (const confidence of [0.84, 1.01, NaN, Infinity]) {
      mutate(rule => { rule.validityIntervals[0].confidence = confidence; });
    }
    for (const rule of corrupt) {
      assert.equal(gate(context(first), [rule]).action, 'pass');
      assert.equal(gate(context(first, start + ttl), [rule]).action, 'pass');
      assert.deepEqual(gate(context(first), [rule, standalone]), gate(context(first), [standalone]));
      for (const upstream of ['deny', 'step_up']) assert.equal(gate(context(first), [rule], upstream).action, 'preserve');
    }
    assert.equal(conversions, 0);
    const extra = structuredClone(valid);
    Object.assign(extra.validityIntervals[0], {
      id: 'different-id', sourceAddress: '192.0.2.234', destinationAddress: '203.0.113.234',
      account: 'other-account', path: '/different-route', agentName: 'other-agent',
    });
    assert.deepEqual(gate(context(first), [extra]), gate(context(first), [valid]), 'nested extras cannot override scope');
  });
}
