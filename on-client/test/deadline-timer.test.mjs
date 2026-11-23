import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ownedDeadlineTimer} from '../public/deadline-timer.mjs';

function scheduler(t) {
  let next = 0;
  const active = new Set(), records = new Map();
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const token = next++;
    records.set(token, {callback, delay, clears: 0});
    active.add(token);
    return token;
  });
  t.mock.method(globalThis, 'clearTimeout', token => {
    assert.ok(records.has(token));
    records.get(token).clears++;
    active.delete(token);
  });
  return {
    active, records,
    only() { assert.equal(active.size, 1); return [...active][0]; },
    fire(token) { assert.ok(active.delete(token)); records.get(token).callback(); },
    stale(token) { records.get(token).callback(); },
    released() { assert.equal(active.size, 0); for (const row of records.values()) assert.equal(row.clears, 1); },
  };
}

test('owned deadline retains its absolute ceiling across repeated early wakes and stale tokens', t => {
  const timers = scheduler(t), deadline = 10.5, reason = {code: 'EXACT_DEADLINE'};
  let now = 0, samples = 0;
  const failures = [];
  const timer = ownedDeadlineTimer(() => {
    samples++;
    const remaining = deadline - now;
    if (remaining <= 0) throw reason;
    return remaining;
  }, error => { failures.push(error); timer.arm(100); });
  t.after(() => timer.dispose());
  timer.arm(10.5);
  assert.equal(samples, 0, 'arming does not add an initial clock read');
  const first = timers.only();
  assert.equal(timers.records.get(first).delay, 11);
  now = 9.25; timers.fire(first);
  const second = timers.only();
  assert.notEqual(second, first);
  assert.equal(timers.records.get(second).delay, 2);
  const acquired = timers.records.size;
  timers.stale(first);
  assert.equal(timers.records.size, acquired);
  assert.equal(timers.only(), second);
  now = 10.25; timers.fire(second);
  const third = timers.only();
  assert.equal(timers.records.get(third).delay, 1);
  assert.deepEqual(failures, []);
  now = 10.5; timers.fire(third);
  assert.deepEqual(failures, [reason]);
  timers.released();
  timers.stale(first); timers.stale(second); timers.stale(third);
  assert.equal(samples, 3);
  assert.equal(failures.length, 1);
  timers.released();
});

test('owner completion disposes a zero-valued timer token once without reading the clock', t => {
  const timers = scheduler(t);
  let samples = 0, failures = 0;
  const timer = ownedDeadlineTimer(() => { samples++; return 10; }, () => failures++);
  timer.arm(10);
  const token = timers.only();
  assert.equal(token, 0);
  timer.dispose(); timer.dispose(); timer.arm(10); timers.stale(token);
  timers.released();
  assert.equal(timers.records.size, 1);
  assert.equal(samples, 0);
  assert.equal(failures, 0);
});

for (const throws of [false, true]) test(`disposal inside the remaining callback prevents rearm and failure, throws=${throws}`, t => {
  const timers = scheduler(t);
  let samples = 0, failures = 0;
  const timer = ownedDeadlineTimer(() => {
    samples++; timer.dispose();
    if (throws) throw undefined;
    return 5;
  }, () => failures++);
  timer.arm(10);
  const token = timers.only(); timers.fire(token); timers.stale(token);
  timers.released();
  assert.equal(timers.records.size, 1);
  assert.equal(samples, 1);
  assert.equal(failures, 0);
});

test('an active owner receives the exact falsy terminal cause only once', t => {
  const timers = scheduler(t), failures = [];
  const timer = ownedDeadlineTimer(() => { throw undefined; }, error => failures.push(error));
  timer.arm(1);
  const token = timers.only(); timers.fire(token); timers.stale(token); timer.dispose();
  assert.deepEqual(failures, [undefined]);
  timers.released();
});
