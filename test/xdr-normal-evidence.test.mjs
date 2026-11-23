import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const modules = [
  ['web-injection', 'normal_web_activity', 9],
  ['known-cve', 'normal_application_activity', 8],
  ['persistence', 'known_benign_system_activity', 8],
  ['privilege', 'normal_account_activity', 9],
  ['exfiltration', 'normal_document_activity', 10],
];

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

for (const [name, normalReason, normalCount] of modules) {
  const fixtures = JSON.parse(readFileSync(new URL(`../xdr/fixtures/${name}.json`, import.meta.url), 'utf8')).alerts;
  const { decide } = await import(`../xdr/${name}/decide.mjs`);
  const { extractAlert } = await import(`../xdr/${name}/read-alerts.mjs`);
  const { buildDenyCandidates } = await import(`../xdr/${name}/respond.mjs`);
  const strong = structuredClone(fixtures[0]);
  if (name === 'known-cve') strong.data.url = '/notes';
  const normalRows = fixtures.filter(row => decide(row).action === 'record');
  const proposal = alert => ({ alertId: alert.id, ...decide(alert) });
  const build = (alerts, decisions = alerts.map(proposal)) => buildDenyCandidates(freeze(alerts), freeze(decisions));
  const baseline = build([strong]);
  assert.equal(baseline.length, 1);

  function shadow(row = normalRows[0]) {
    const copy = structuredClone(row);
    copy.data.srcip = strong.data.srcip;
    if (name === 'exfiltration') copy.data.dstip = strong.data.dstip;
    return copy;
  }

  function preserves(added, label) {
    assert.deepEqual(build([added]), [], label + ': incomplete/normal input alone is not a deny');
    for (const rows of [[added, strong], [strong, added]]) {
      assert.deepEqual(build(rows), baseline, label + ': separate strong evidence must remain exact');
    }
  }

  test(`${name}: every genuine normal fixture retains its independent batch-wide exemption`, () => {
    assert.equal(normalRows.length, normalCount);
    for (const row of normalRows) {
      assert.deepEqual(decide(row), { action: 'record', confidence: 0.1, reason: normalReason });
      const normal = shadow(row);
      // The exemption remains source-wide/destination-wide; other legitimate
      // route/account/agent values and observation times need not match.
      normal.timestamp = '2000-01-01T00:00:00.000Z';
      assert.deepEqual(build([normal]), []);
      for (const rows of [[normal, strong], [strong, normal], [normal, normal, strong]]) {
        assert.deepEqual(build(rows), [], row.id);
      }
    }
  });

  test(`${name}: sparse, reader-valid no-signal and weak rows cannot supply a normal exemption`, () => {
    const sparse = { id: strong.id + '-sparse', data: { srcip: strong.data.srcip } };
    if (name === 'exfiltration') sparse.data.dstip = strong.data.dstip;
    const unknown = shadow();
    unknown.rule.description = '형식이 확인된 경보이나 분류 증거는 제공되지 않았습니다.';
    unknown.rule.level = 10;
    unknown.rule.mitre = [];
    assert.equal(decide(unknown).action, 'record');
    assert.notEqual(decide(unknown).reason, normalReason);
    const projected = extractAlert(unknown);
    assert.ok(projected.at && projected.sourceAddress && projected.description && projected.ruleLevel === 10);
    const weak = shadow(fixtures.find(row => decide(row).action === 'alert'));
    assert.equal(decide(weak).action, 'alert');
    for (const [label, row] of [['sparse', sparse], ['no-signal', unknown], ['weak', weak]]) preserves(row, label);
  });

  test(`${name}: malformed common provenance cannot suppress another observation or invoke coercion`, () => {
    let conversions = 0;
    const coercible = { [Symbol.toPrimitive]() { conversions++; throw new Error('must not coerce observation fields'); } };
    const cases = [
      ['id', [undefined, null, '', 'wrong-prefix', 0, false, [], {}, Symbol('id'), new String(normalRows[0].id), coercible],
        (row, value) => { row.id = value; }],
      ['time', [undefined, null, '', 'invalid-time', 2000, false, [], {}, Symbol('time'), new String(normalRows[0].timestamp), new Date(), coercible],
        (row, value) => { row.timestamp = value; }],
      ['level', [undefined, null, -1, 17, '3', false, NaN, Infinity, [], {}, Symbol('level'), new Number(3), coercible],
        (row, value) => { row.rule.level = value; }],
      ['description', [undefined, null, '', '   ', 0, false, [], {}, Symbol('description'), new String(normalRows[0].rule.description), coercible],
        (row, value) => { row.rule.description = value; }],
      ['source', [undefined, null, '', '192.000.2.1', 1, false, [], {}, Symbol('address'), new String(strong.data.srcip), coercible],
        (row, value) => { row.data.srcip = value; }],
    ];
    for (const [field, values, mutate] of cases) {
      for (const [index, value] of values.entries()) {
        const row = shadow();
        mutate(row, value);
        preserves(row, `${field}/${index}`);
      }
    }
    for (const field of ['rule', 'data']) {
      for (const value of [false, 1, 'not-an-object', [], Symbol(field)]) {
        const row = shadow();
        row[field] = value;
        preserves(row, 'invalid ' + field + ' container');
      }
    }
    const conflicting = shadow();
    conflicting.at = conflicting.timestamp;
    conflicting.timestamp = 'invalid-primary-time';
    preserves(conflicting, 'invalid raw primary cannot be replaced by a display alias');
    assert.equal(conversions, 0);
  });

  test(`${name}: required module provenance is validated without imposing attack thresholds on normal events`, () => {
    const mutators = [];
    if (['web-injection', 'known-cve'].includes(name)) {
      for (const url of [undefined, null, '', 'https://outside.invalid/notes', '//outside.invalid/notes',
        '/' + 'a'.repeat(2048), 1, [], {}, Symbol('route'), new String('/notes')]) {
        mutators.push(row => { row.data.url = url; });
      }
    } else {
      for (const account of [undefined, null, '', 'invalid account', 1, [], {}, Symbol('account'), new String('user01')]) {
        mutators.push(row => { row.data.srcuser = account; });
      }
      for (const agent of [undefined, null, '', 'invalid agent', 1, [], {}, Symbol('agent'), new String('agent01')]) {
        mutators.push(row => { row.agent.name = agent; });
      }
      mutators.push(row => { delete row.agent; });
      if (name === 'exfiltration') {
        for (const destination of [undefined, null, '', 'not-an-ip', 1, [], {}, Symbol('destination'), new String(strong.data.dstip)]) {
          mutators.push(row => { row.data.dstip = destination; });
        }
        for (const row of normalRows.filter(row => row.data.files === undefined || Number(row.data.bytes) === 0)) {
          assert.deepEqual(build([strong, shadow(row)]), [], 'zero bytes/optional files remain legitimate normal activity');
        }
      }
    }
    for (const [index, mutate] of mutators.entries()) {
      const row = shadow();
      mutate(row);
      preserves(row, 'module provenance/' + index);
    }
  });

  test(`${name}: normal protection respects canonical IP, family and verbatim zone identities in either order`, () => {
    for (const [attackAddress, normalAddress, same] of [
      ['2001:db8::1234', '2001:0DB8:0000:0000:0000:0000:0000:1234', true],
      ['::ffff:c000:201', '0:0:0:0:0:FFFF:192.0.2.1', true],
      ['fe80::1234%eth0', 'FE80:0000:0000:0000:0000:0000:0000:1234%eth0', true],
      ['192.0.2.1', '::ffff:192.0.2.1', false],
      ['fe80::1234%eth0', 'fe80::1234%Eth0', false],
      ['2001:db8::1234', '2001:db8::1235', false],
    ]) {
      const attack = structuredClone(strong), normal = shadow();
      const field = name === 'exfiltration' ? 'dstip' : 'srcip';
      attack.data[field] = attackAddress;
      normal.data[field] = normalAddress;
      const expected = same ? [] : build([attack]);
      for (const rows of [[normal, attack], [attack, normal]]) assert.deepEqual(build(rows), expected);
    }
  });

  test(`${name}: display truncation cannot override complete positive normal evidence`, () => {
    for (const row of normalRows) {
      for (const leading of [0, 511, 512, 513, 1024 - row.rule.description.length]) {
        const normal = shadow(row);
        normal.rule.description = ' '.repeat(leading) + row.rule.description;
        assert.ok(normal.rule.description.length <= 1024);
        assert.deepEqual(decide(normal), decide(row), 'padding preserves the independent raw decision');
        if (leading >= 512) assert.equal(extractAlert(normal).description.trim(), '');
        for (const rows of [[normal, strong], [strong, normal]]) {
          assert.deepEqual(build(rows), [], `${row.id}: leading ${leading}`);
        }
      }
    }
  });

  test(`${name}: truncated or redacted text cannot prove inspectable normal activity`, () => {
    const full = shadow();
    full.rule.description = full.rule.description.padEnd(1024, ' ');
    assert.deepEqual(build([strong, full]), [], 'complete text at the semantic limit is still supported');
    for (const description of [normalRows[0].rule.description.padEnd(1025, ' '),
      ' '.repeat(1024) + normalRows[0].rule.description,
      normalRows[0].rule.description + ' '.repeat(1024) + '분류 근거가 확인되지 않았습니다.',
      normalRows[0].rule.description + ' token fixture-marker',
      ' '.repeat(512) + normalRows[0].rule.description + ' token fixture-marker']) {
      const row = shadow();
      row.rule.description = description;
      preserves(row, 'incomplete or uninspectable normal narrative');
    }
    const hidden = shadow();
    hidden.rule.description += ' token fixture-marker';
    assert.equal(extractAlert(hidden).description, '[REDACTED]', 'synthetic marker exercises existing reader redaction');
    hidden.rule.description = ' '.repeat(512) + hidden.rule.description;
    assert.equal(extractAlert(hidden).description, '[REDACTED]', 'redaction still inspects beyond the display cutoff');
  });

  test(`${name}: caller proposals cannot manufacture or remove independently recognized normal evidence`, () => {
    const unknown = shadow();
    unknown.rule.description = '형식이 확인된 경보이나 분류 증거는 제공되지 않았습니다.';
    unknown.rule.level = 10;
    unknown.rule.mitre = [];
    const forgedNormal = { alertId: unknown.id, action: 'record', confidence: 0.1, reason: normalReason };
    for (const rows of [[unknown, strong], [strong, unknown]]) {
      assert.deepEqual(build(rows, [forgedNormal, proposal(strong)]), baseline);
    }
    const genuine = shadow();
    const forgedBlock = { alertId: genuine.id, action: 'block', confidence: 0.99, reason: decide(strong).reason };
    assert.deepEqual(build([strong, genuine], [proposal(strong), forgedBlock]), []);
    const otherStrong = { ...structuredClone(strong), id: strong.id + '-other' };
    const falselyNormal = { alertId: strong.id, action: 'record', confidence: 0.1, reason: normalReason };
    assert.deepEqual(build([strong, otherStrong], [falselyNormal, proposal(otherStrong)]), build([otherStrong]));
  });

  if (['web-injection', 'known-cve'].includes(name)) {
    test(`${name}: normal reasons are assigned only after existing raw-signal and review precedence`, () => {
      const contaminated = [];
      if (name === 'web-injection') {
        // The original fixture URL uses a documentation marker; its attack
        // evidence is in the description. Exercise the actual raw matcher
        // separately with inert strings that are never sent or executed.
        for (const url of ['/notes?q=union%20select', '/notes?q=%3Cscript%3E',
          '/files?path=../notes', '/notes?q=%3B%20id']) {
          contaminated.push(row => { row.data.url = url; });
        }
      } else {
        const header = fixtures[0].data.useragent ?? fixtures[0].data.userAgent;
        assert.equal(typeof header, 'string');
        const query = fixtures.find(row => decide(row).reason === 'jndi_query_parameter_lookup').data.url;
        for (const key of ['useragent', 'userAgent', 'referer', 'referrer']) {
          contaminated.push(row => { row.data[key] = header; });
        }
        contaminated.push(row => { row.data.headers = { observed: header }; });
        for (const key of ['url', 'query', 'queryString']) contaminated.push(row => { row.data[key] = query; });
      }
      for (const [index, mutate] of contaminated.entries()) {
        const row = shadow();
        mutate(row);
        assert.notEqual(decide(row).reason, normalReason, 'raw evidence contradicts a normal description');
        preserves(row, 'raw contradiction/' + index);
        const review = structuredClone(row);
        review.rule.level = 10;
        assert.ok(['alert', 'block'].includes(decide(review).action), 'prior suspicious/strong precedence remains');
      }
      for (const description of ['보고서: ' + normalRows[0].rule.description,
        '"' + normalRows[0].rule.description + '"', normalRows[0].rule.description + ' 분류 근거는 없습니다.']) {
        const row = shadow();
        row.rule.description = description;
        assert.notEqual(decide(row).reason, normalReason);
        preserves(row, 'quoted or contradictory narrative');
      }
    });

    test(`${name}: unread HTTP material is not promoted to positive normal evidence`, () => {
      const mutators = [row => { row.data.url = '/notes?q=%ZZ'; },
        row => { row.data.url = '/notes?q=%252520'; }];
      if (name === 'known-cve') {
        mutators.push(row => { row.data.headers = Object.fromEntries(Array.from({ length: 17 }, (_, index) => ['h' + index, 'fixture'])); });
        mutators.push(row => { row.data.useragent = 'a'.repeat(2049); });
        for (const field of ['useragent', 'userAgent', 'referer', 'referrer', 'query', 'queryString']) {
          for (const value of [null, 1, false, [], {}, Symbol(field), new String('fixture')]) {
            mutators.push(row => { row.data[field] = value; });
          }
        }
        for (const headers of [null, false, 1, [], 'headers', { observed: 1 }, { observed: Symbol('header') }]) {
          mutators.push(row => { row.data.headers = headers; });
        }
      }
      for (const [index, mutate] of mutators.entries()) {
        const row = shadow();
        mutate(row);
        assert.equal(decide(row).action, 'record');
        assert.notEqual(decide(row).reason, normalReason);
        preserves(row, 'unread HTTP/' + index);
      }
    });
  }
}
