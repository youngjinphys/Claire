import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { failureCount, matchStrongPattern } from '../xdr/brute-force/match.mjs';

const names = ['brute-force', 'web-injection', 'known-cve', 'persistence', 'privilege', 'exfiltration'];
const modules = {};
for (const name of names) {
  const { decide } = await import(`../xdr/${name}/decide.mjs`);
  const { buildDenyCandidates } = await import(`../xdr/${name}/${name === 'brute-force' ? 'ztna-gate' : 'respond'}.mjs`);
  modules[name] = { decide, buildDenyCandidates };
}
const fixtures = name => JSON.parse(readFileSync(new URL(`../xdr/fixtures/${name}.json`, import.meta.url), 'utf8')).alerts;
const fixture = (name, id) => fixtures(name).find(alert => alert.id === id);

function synthetic(name, description) {
  return {
    id: name === 'brute-force' ? 'bf-numeric-contract' : 'wi-numeric-contract',
    timestamp: '2026-11-23T10:00:00.000Z',
    data: { srcip: '192.0.2.1', srcuser: 'fixture_user', url: '/notes' },
    rule: { level: 10, mitre: [], description },
  };
}

function expectDecision(name, alert, expectedBlock, reason) {
  const { decide, buildDenyCandidates } = modules[name];
  const decision = decide(alert);
  const detail = `${name}: ${alert.rule.description}`;
  assert.equal(decision.action, expectedBlock ? 'block' : 'alert', detail);
  if (expectedBlock && reason) assert.equal(decision.reason, reason, detail);
  const candidates = buildDenyCandidates([alert], [{ alertId: alert.id, ...decision }]);
  assert.equal(candidates.length, expectedBlock ? 1 : 0, detail);
  if (name === 'brute-force') {
    assert.deepEqual(matchStrongPattern(alert), expectedBlock
      ? { name: decision.reason, confidence: decision.confidence } : null, detail);
  }
  return decision;
}

// These spellings are intentionally unsupported. They must never be read as
// their final positive digit group, including when spaces separate the pieces.
function malformedTokens(value) {
  const separators = ["'", '’', '‘', '"', '`', 'ʼ', '٫', '٬', '．', '，', '﹐', '﹒',
    '․', '·', '·', '×', '(', ')', '[', ']', '{', '}', '\u200b', '\u2060', '\ufeff',
    '\u0307', '\u034f', '\u00ad', '\u0000', '\u2028'];
  return [`-${value}`, `−${value}`, `- ${value}`, `−\u00a0${value}`, `+${value}`, `+ ${value}`,
    `0.${value}`, `0. ${value}`, `0 . ${value}`, `1e-${value}`, `1e${value}`, `1 e -${value}`,
    `1 e - ${value}`, `1 e ${value}`, `1,${value}`, `1, ${value}`, `1 , ${value}`,
    `1 ${value}`, `1\u202f${value}`, `1\t${value}`, `1_${value}`, `1/${value}`, `1 / ${value}`,
    `1:${value}`, `0x${value}`, `１${value}`, `NaN${value}`, `Infinity${value}`,
    '9007199254740992', '9'.repeat(400), `＋${value}`, `٫${value}`, `．${value}`,
    ...separators.flatMap(separator => [`7${separator}${String(value).padStart(3, '0')}`,
      `٧${separator}${String(value).padStart(3, '0')}`])];
}

// Put metadata immediately before the quantity being read. Prefixing pv-09 as
// a whole would miss the regrant parser's numeric position.
function boundarySamples(prefix, tokenFor = value => String(value)) {
  const persistence = fixture('persistence', 'ps-04');
  delete persistence.data.count;
  persistence.rule.description = `${prefix}${tokenFor(3)}회 반복된 서명 없는 서비스 등록입니다.`;
  const privilege = fixture('privilege', 'pv-09');
  privilege.rule.description = privilege.rule.description.replace('1분 뒤', `${prefix}${tokenFor(1)}분 뒤`);
  const exfiltration = fixture('exfiltration', 'ex-01');
  exfiltration.rule.description = exfiltration.rule.description.replace('10분 안', `${prefix}${tokenFor(10)}분 안`);
  return [
    ['brute-force', synthetic('brute-force', `${prefix}${tokenFor(20)} failed login attempts from the same IP within 1 minute`), 'rapid_source_login_failures'],
    ['web-injection', synthetic('web-injection', `${prefix}${tokenFor(8)}회 반복된 같은 주소의 SQL 삽입 요청입니다.`), 'repeated_sql_injection'],
    ['persistence', persistence, 'repeated_unsigned_service_registration'],
    ['privilege', privilege, 'rapid_admin_group_regrant'],
    ['exfiltration', exfiltration, 'rapid_bulk_to_new_destination'],
  ];
}

const completedQuantityPrefixes = [
  'CPU 99%; ', 'CPU 99%. ', 'CPU 99%;\n', 'CPU 99%, ', 'CPU 99%: ',
  'CPU 99%! ', 'CPU 99%? ', 'CPU 99％； ', 'CPU 99%;', 'CPU 99%.',
  'CPU 99.5%; ', 'CPU 99% ', 'CPU 99%\n', 'CPU 99٪, ', 'CPU 99﹪, ', 'CPU 99％, ',
  'CPU 99‰; ', 'CPU 99‱; ', 'CPU 99 percent; ', 'CPU 99 per cent; ',
  'CPU (99%); ', 'CPU [99%]; ', 'CPU (99%). ', 'CPU [99%], ', 'CPU "99%": ',
  'Latency 99ms; ', 'Latency 99 ms; ', 'Latency 99ms, ', 'Latency 99ms. ',
  'Latency 99ms ', 'Latency 99ms\n', 'Latency (99ms),', 'Latency -99ms, ', 'Latency 1e3ms, ',
  'Memory 99MiB; ', 'Memory 99MiB, ', 'Memory 99MiB. ', 'Memory 99MiB ', 'Memory 99 MB, ',
  'Rate 99req/s; ', 'Rate 99req/s,', 'Temperature 32°C, ', 'Temperature 32°C. ', 'Temperature 32°C ',
  'Sample 99; ', 'Sample 99;\n', 'Sample 99! ', 'Sample 99? ',
  'Sample 99；', 'Sample 99。', 'Sample 99！', 'Sample 99？',
  'Time 12:00; ', 'Address 192.0.2.1; ', 'CPU 99% ± 0.1%; ',
];

test('completed quantities and clear clause boundaries preserve the following independent numeric evidence', () => {
  for (const prefix of completedQuantityPrefixes) {
    for (const [name, alert, reason] of boundarySamples(prefix)) {
      expectDecision(name, alert, true, reason);
      if (name === 'brute-force') assert.equal(failureCount(alert), 20, alert.rule.description);
    }
  }
});

test('completed-unit recognition cannot restart inside radix bodies, hex exponents or numeric type suffixes', () => {
  const fragments = [
    '0xFF', '0x1F', '0XdeadBEEF', '0xFFn', '0xFFULL', '0x1_0F', '0x0.FF',
    '0xFFp2F', '0xA.BCp-2', '0x1p4F', '0XCAFEuL', '0B10U', '0o77UL',
    '0b101F', '0o17F', '0x 1F', '0 xFF', '0 x 1F', '0X 1_F',
    '0 b 101F', '0 o 17F', '0x\u200b1F', '0xFF 1F',
  ];
  for (const fragment of fragments) {
    for (const separator of ['.', ',', ' ']) {
      for (const [name, alert] of boundarySamples('', value => fragment + separator + value)) {
        expectDecision(name, alert, false);
        if (name === 'brute-force') assert.equal(failureCount(alert), 0, alert.rule.description);
      }
    }
  }
});

test('formatted metadata keeps a genuine unit boundary without requiring an ASCII evidence integer', () => {
  for (const prefix of [
    "Latency 7'099ms, ", 'Memory 1\u00a0024MiB, ', 'CPU ９９％, ', 'CPU ٩٩٪, ',
    'CPU 1,234%, ', 'CPU 1٬234%, ', 'Offset −1.25e-3ms, ',
    'CPU ９９．５％, ', 'CPU ٩٩٫٥٪, ', 'CPU (1,234%), ',
    '0xFF; ', '0b101F; CPU 99%; ', '0xA.BCp-2。Offset -1.25e-3ms, ',
  ]) {
    for (const tokenFor of [value => String(value), value => String(value).padStart(4, '0')]) {
      for (const [name, alert, reason] of boundarySamples(prefix, tokenFor)) {
        expectDecision(name, alert, true, reason);
        if (name === 'brute-force') assert.equal(failureCount(alert), 20, alert.rule.description);
      }
    }
  }
});

test('all Unicode numeric zero forms retain the boundary of unsupported mixed-radix fragments', () => {
  // Independent UnicodeData 15.0 numeric-value-zero oracle: 68 Nd + 17 No/Nl.
  const zeros = [...'0٠۰߀०০੦૦୦௦౦౸೦൦෦๐໐༠၀႐០៰᠐᥆᧐᪀᪐᭐᮰᱀᱐⁰₀↉⓪⓿〇꘠ꛯ꣐꤀꧐꧰꩐꯰０𐆊𐒠𐴰𑁦𑃰𑄶𑇐𑋰𑑐𑓐𑙐𑛀𑜰𑣠𑥐𑱐𑵐𑶠𑽐𖩠𖫀𖭐𖺀𝋀𝋠𝟎𝟘𝟢𝟬𝟶𞅀𞋰𞓰𞥐🄀🄁🄋🄌🯰'];
  assert.equal(zeros.length, 85);
  for (const zero of zeros) {
    for (const fragment of [`${zero}xFF`, `${zero}x1F`, `${zero}B10U`, `${zero}o77UL`, `0${zero}x1F`]) {
      for (const [name, alert] of boundarySamples('', value => `${fragment}.${value}`)) {
        expectDecision(name, alert, false);
        if (name === 'brute-force') assert.equal(failureCount(alert), 0, alert.rule.description);
      }
    }
    for (const prefix of [`CPU ${zero}%, `, `Memory ${zero}MiB, `, `${zero}xFF; `]) {
      for (const [name, alert, reason] of boundarySamples(prefix)) expectDecision(name, alert, true, reason);
    }
  }
});

test('Unicode radix classification preserves nonzero units and never converts Unicode evidence to ASCII integers', () => {
  for (const quantity of ['99B', '９９B', '٩٩B', '𝟡𝟡B', '۹۹B', '१२B', '²B', 'ⅨB', '99bytes', '99objects', '0bytes', '0objects']) {
    for (const [name, alert, reason] of boundarySamples(`Metadata ${quantity}, `)) expectDecision(name, alert, true, reason);
  }
  for (const zeroCodePoint of [0xff10, 0x660, 0x6f0, 0x1d7d8]) {
    const unicodeToken = value => [...String(value)].map(digit => String.fromCodePoint(zeroCodePoint + Number(digit))).join('');
    for (const [name, alert] of boundarySamples('CPU 99%; ', unicodeToken)) {
      expectDecision(name, alert, false);
      if (name === 'brute-force') assert.equal(failureCount(alert), 0, alert.rule.description);
    }
  }
});

test('every numeric component in a compound span retains its unsupported radix body', () => {
  const fragments = [
    '0.0xFF', '1.0xFF', '0_0xFF', '0\u200b0xFF', '0\u20600xFF', '0\u03070xFF',
    '0,0xFF', '0 0xFF', '7/0x1F', '9:0xFF', "7'0xFF", '7\u202f0xFF',
    '0.٠xFF', '1.⓪xFF', '0.0B10U', '0_0o77UL', '1/0b2F', '1/0o8F',
    '0.0xFFp2F', '0_0xA.BCp-2', '1.0 b 101F', '0.0 o 17F',
  ];
  for (const fragment of fragments) {
    for (const [name, alert] of boundarySamples('', value => `${fragment}.${value}`)) {
      expectDecision(name, alert, false);
      if (name === 'brute-force') assert.equal(failureCount(alert), 0, alert.rule.description);
    }
  }
});

test('complete word and rate units preserve independent evidence with compact and spaced delimiters', () => {
  const quantities = [
    '0baud', '1baud', '000baud', '٠baud', '⓪baud', '0Baud', '0.0baud', '0,000baud',
    '0B/s', '0b/s', '1B/s', '000B/s', '٠B/s', '⓪B/s', '0 B/s',
    '0bytes', '0objects', '0bytes/s', '0objects/s', '0ms', '0MiB', '0Hz',
  ];
  for (const quantity of quantities) {
    for (const delimiter of [',', ', ', ' ', ';', '.', ':', '\n']) {
      for (const [name, alert, reason] of boundarySamples(`Metric ${quantity}${delimiter}`)) {
        expectDecision(name, alert, true, reason);
        if (name === 'brute-force') assert.equal(failureCount(alert), 20, alert.rule.description);
      }
    }
  }
});

test('full-span classification preserves clause independence, malformed evidence and original Unicode offsets', () => {
  for (const prefix of ['Metric 0baud,', 'Metric 0B/s,', '0.0xFF;Metric ٠B/s,']) {
    for (const tokenFor of [value => `-${value}`, value => `0.${value}`, value => `1e-${value}`,
      value => `0.0xFF.${value}`, value => `0.0b2F.${value}`, value => `0.0o8F.${value}`]) {
      for (const [name, alert] of boundarySamples(prefix, tokenFor)) expectDecision(name, alert, false);
    }
    for (const validFirst of [false, true]) {
      const valid = boundarySamples(prefix);
      const invalid = boundarySamples('', value => `1.0xFF.${value}`);
      for (let index = 0; index < valid.length; index++) {
        const [name, alert, reason] = valid[index];
        const descriptions = [alert.rule.description, invalid[index][1].rule.description];
        if (!validFirst) descriptions.reverse();
        alert.rule.description = descriptions.join(';');
        expectDecision(name, alert, true, reason);
      }
    }
  }
  const offHours = fixture('exfiltration', 'ex-06');
  for (const [description, expected] of [
    ['업무 시간 밖에 같은 목적지로 전송이 📊 Metric ٠B/s,10번입니다.', true],
    ['업무 시간 밖에 같은 목적지로 📊 Metric ٠B/s,10번입니다. 전송', false],
  ]) {
    offHours.rule.description = description;
    expectDecision('exfiltration', offHours, expected, 'offhours_repeated_large_transfer');
  }
});

test('a completed unit consumes its entire numeric prefix instead of restarting inside an opaque quantity', () => {
  const fragments = [
    '0bA1F', '0b A1F', '0b\u200bA1F', '0BDEAD1ULL', '0oA1F', '0o A1F',
    '0o\u200bA1F', '0OAA1UL', '1.0bA1F', '0_0oA1F', '0.٠bA1F', '⓪oA1F',
    '0bG1F', '0oG1F', '0b G1F', '0o G1F', '1bA1F', '1abc1F', '1baud1F',
    '1quux1ms', '1eX1F',
  ];
  for (const fragment of fragments) {
    for (const delimiter of ['.', ',', ' ']) {
      for (const [name, alert] of boundarySamples('', value => fragment + delimiter + value)) {
        expectDecision(name, alert, false);
        if (name === 'brute-force') assert.equal(failureCount(alert), 0, alert.rule.description);
      }
    }
  }
});

test('numeric suffixes retain opaque-prefix ownership while complete ordinary words establish independence', () => {
  for (const prefix of [
    '0bA1.FF ', '0oA1.FF ', '1abc1.FF ', '1baud1.FF ', '0b A1.FF ',
    '0o A1.FF ', '0b G1.FF ', '0o G1.FF ', '0xFF 1F.', '0xFF FF ',
    '0bA1.GG ', '1abc1.GG ',
  ]) {
    for (const [name, alert] of boundarySamples(prefix)) {
      expectDecision(name, alert, false);
      if (name === 'brute-force') assert.equal(failureCount(alert), 0, alert.rule.description);
    }
  }
  for (const prefix of [
    'Metric 0baud caused ', 'Metric 0baud before ', 'Metric 99 apples caused ',
    'Status 0xFF caused ', 'Status 0xFF before ', 'Status 0xFF after ', 'Status 0xFF. caused ',
    '0bA1.FF; ', '1abc1.FF; ', '0oA1.FF; Metric 0B/s,',
  ]) {
    for (const [name, alert, reason] of boundarySamples(prefix)) {
      expectDecision(name, alert, true, reason);
      if (name === 'brute-force') assert.equal(failureCount(alert), 20, alert.rule.description);
    }
  }
});

test('whole metadata prefixes preserve scientific and formatted quantities, unknown units and actual separators', () => {
  for (const prefix of [
    'Metric 1abc,', 'Metric 1quux,', 'Metric 1baud,', 'Metric 0baud,',
    '1abc 1F.', '1quux 1ms,', '1e3F.', 'Latency 1E+3ms,', 'Offset −1.25e-3ms,',
    "Latency 7'099ms,", 'Memory 1\u00a0024MiB,', 'CPU ９９．５％,', 'CPU ٩٩٫٥٪,',
    'Memory ⓪MiB,', 'Metric 0B/s before ', 'Metric 1quux1F; ',
  ]) {
    for (const [name, alert, reason] of boundarySamples(prefix)) {
      expectDecision(name, alert, true, reason);
      if (name === 'brute-force') assert.equal(failureCount(alert), 20, alert.rule.description);
    }
    for (const [name, alert] of boundarySamples(prefix, value => `0bA1.FF ${value}`)) {
      expectDecision(name, alert, false);
    }
  }
});

test('attached Unicode letters and marks retain unresolved numeric ownership across direct and interior suffixes', () => {
  const letters = ['Ａ', 'Α', 'А', 'Á', 'A\u0301', 'Å', 'A\u030a', 'א', 'ا', 'क',
    'ก', '字', 'あ', '한', '분', '시간', '𐐀', '𝔄', 'ᵃ'];
  for (const letter of letters) {
    assert.match(letter, /[\p{L}\p{M}]/u);
    const tokens = [
      value => '0x' + letter + value,
      value => '0x ' + letter + value,
      value => '0b' + letter + '1F.' + value,
      value => '0o' + letter + '1F.' + value,
      value => '0b ' + letter + '1F.' + value,
      value => '0.⓪o' + letter + '1F.' + value,
    ];
    for (const tokenFor of tokens) {
      for (const [name, alert] of boundarySamples('', tokenFor)) {
        expectDecision(name, alert, false);
        if (name === 'brute-force') assert.equal(failureCount(alert), 0, alert.rule.description);
      }
    }
    for (const prefix of ['0b' + letter + '1F;', 'Status 0x' + letter + 'FF caused ',
      'Status 0x' + letter + 'FF before ']) {
      for (const [name, alert, reason] of boundarySamples(prefix)) {
        expectDecision(name, alert, true, reason);
      }
    }
  }
  for (const fragment of ['1abcÁ1F.', '1abcA\u03011F.', '1abcＡ1F.', '1abcΑ1F.']) {
    for (const [name, alert] of boundarySamples(fragment)) expectDecision(name, alert, false);
  }
});

test('valid complete quantities preserve compact Korean units and prose without releasing malformed prefixes', () => {
  for (const description of [
    '같은 주소에서1분안에로그인 실패20건',
    '같은 주소에서1분 안에로그인 실패20건',
    '3ms후20 failed login attempts from the same IP within 1 minute',
    '3ms지연후20 failed login attempts from the same IP within 1 minute',
    '20 failed login attempts from the same IP within 1분',
    '단계1에서20 failed login attempts from the same IP within 1 minute',
  ]) {
    const alert = synthetic('brute-force', description);
    expectDecision('brute-force', alert, true, 'rapid_source_login_failures');
    assert.equal(failureCount(alert), 20, description);
  }
  const prefixes = ['3ms후', '3ms지연후', 'CPU 99%일때', 'Memory 99MiB확인후',
    'Metric 1quux이후', ...['초', '분', '시간', '건', '번', '회', '개', '곳'].map(unit => '1' + unit + '이후')];
  for (const prefix of prefixes) {
    for (const [name, alert, reason] of boundarySamples(prefix)) {
      expectDecision(name, alert, true, reason);
    }
    for (const [name, alert] of boundarySamples(prefix, value => '0x분' + value)) {
      expectDecision(name, alert, false);
    }
  }
  const offHours = fixture('exfiltration', 'ex-06');
  for (const [description, expected] of [
    ['업무 시간 밖에 같은 목적지로 전송이 📊𐐀 확인: 3ms지연후10번입니다.', true],
    ['업무 시간 밖에 같은 목적지로 📊𐐀 확인: 3ms지연후10번입니다. 전송', false],
  ]) {
    offHours.rule.description = description;
    expectDecision('exfiltration', offHours, expected, 'offhours_repeated_large_transfer');
  }
});

test('complete Unicode metadata units preserve subsequent evidence while their opaque-prefix counterparts remain unsupported', () => {
  for (const unit of ['μs', 'µs', 'Ω', 'Á', 'A\u0301', '𐐀', '분']) {
    for (const delimiter of [', ', ' after ', '후', ',']) {
      for (const [name, alert, reason] of boundarySamples('Metric 3' + unit + delimiter)) {
        expectDecision(name, alert, true, reason);
        if (name === 'brute-force') assert.equal(failureCount(alert), 20, alert.rule.description);
      }
    }
    for (const tokenFor of [value => '0x' + unit + value,
      value => '0b' + unit + '1F.' + value, value => '0o' + unit + '1F.' + value]) {
      for (const [name, alert] of boundarySamples('', tokenFor)) expectDecision(name, alert, false);
    }
  }
  for (const separator of ['ʼ', 'ˈ', 'ʹ']) {
    assert.match(separator, /\p{Lm}/u);
    for (const [name, alert] of boundarySamples('7' + separator + ' ', value => String(value).padStart(3, '0'))) {
      expectDecision(name, alert, false);
    }
  }
});

test('numeric entry rejects attached Unicode letters and marks while retaining separated and Korean evidence', () => {
  const opaquePrefixes = ['A', 'A\u0301', 'Á', 'Ａ', 'NaN', 'NaＮ', 'NaŃ', 'Α', 'А', '𐐀', '\u0301', '\u034f'];
  for (const prefix of opaquePrefixes) {
    for (const metadata of ['', 'Metric 3µs, ']) {
      for (const [name, alert] of boundarySamples(metadata, value => prefix + value)) {
        expectDecision(name, alert, false);
        if (name === 'brute-force') assert.equal(failureCount(alert), 0);
      }
    }
    for (const separator of [' ', ';']) {
      for (const [name, alert, reason] of boundarySamples(prefix + separator)) {
        expectDecision(name, alert, true, reason);
      }
    }
  }
  for (const prefix of ['후', '실패', '3ms지연후', 'Metric 3µs,']) {
    for (const [name, alert, reason] of boundarySamples(prefix)) expectDecision(name, alert, true, reason);
  }
});

test('metadata numeric entry rejects opaque prefixes and preserves completed assignments and actual separators', () => {
  for (const prefix of ['A3ms,', 'A\u03013ms,', 'Á3ms,', 'Ａ3ms,', 'NaＮ3ms,', 'NaŃ3ms,',
    'A+3ms,', 'A＋3ms,', 'A.3ms,', 'A．3ms,', 'A\u200b3ms,', 'A\u20603ms,', 'A$3ms,']) {
    for (const [name, alert] of boundarySamples(prefix)) {
      expectDecision(name, alert, false);
      if (name === 'brute-force') assert.equal(failureCount(alert), 0);
    }
  }
  for (const prefix of ['Á3ms, ', 'Á3ms;', 'A\u200b3ms, ', 'A 3ms,', 'A\u202f3ms,',
    'CPU=99%,', 'Latency=3ms,', 'Metric=3µs,', 'Latency: 3ms,', '$3ms,', '3ms,', 'CPU≈99%, ']) {
    for (const [name, alert, reason] of boundarySamples(prefix)) expectDecision(name, alert, true, reason);
  }
  for (const [name, alert] of boundarySamples('Label=')) expectDecision(name, alert, false);
});

test('bounded numeric-run batches preserve public decisions without repeated interior completion scans', () => {
  const program = `
    import assert from 'node:assert/strict';
    import { decide } from ${JSON.stringify(new URL('../xdr/brute-force/decide.mjs', import.meta.url).href)};
    import { buildDenyCandidates } from ${JSON.stringify(new URL('../xdr/brute-force/ztna-gate.mjs', import.meta.url).href)};
    const alerts = [];
    for (const digit of ['9', '９', '٩']) {
      for (let index = 0; index < 4; index++) {
        const description = ('같은 주소 로그인 실패 ' + digit.repeat(1024)).slice(0, 1024);
        assert.equal(description.length, 1024);
        alerts.push({ id: 'bf-bounded-run-' + alerts.length, timestamp: '2026-11-23T10:00:00.000Z',
          data: { srcip: '192.0.2.1', srcuser: 'resource_fixture' },
          rule: { level: 12, description } });
      }
    }
    const decisions = alerts.map(alert => ({ alertId: alert.id, ...decide(alert) }));
    assert.ok(decisions.every(decision => decision.action === 'alert'));
    assert.deepEqual(buildDenyCandidates(alerts, decisions), []);
    const positive = { ...alerts[0], rule: { level: 12,
      description: '20 failed login attempts from the same IP within 1 minute' } };
    const decision = decide(positive);
    assert.equal(decision.action, 'block');
    assert.equal(decision.reason, 'rapid_source_login_failures');
    assert.equal(buildDenyCandidates([positive], [{ alertId: positive.id, ...decision }]).length, 1);
    console.log(JSON.stringify({ alerts: alerts.length, codeUnits: 1024, candidates: 0, positiveCandidates: 1 }));
  `;
  // The deadline bounds a real public-API batch, with ample headroom for slow
  // machines. It is not a millisecond-level throughput assertion.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { alerts: 12, codeUnits: 1024, candidates: 0, positiveCandidates: 1 });
});

test('a completed metadata quantity never turns the following malformed numeric token into a valid suffix', () => {
  const badTokens = value => [
    `-${value}`, `− ${value}`, `+${value}`, `0.${value}`, `0. ${value}`, `1e-${value}`,
    `1 e ${value}`, `7'${String(value).padStart(3, '0')}`, `7’${String(value).padStart(3, '0')}`,
    `1\u200b${value}`, `1\u2028${value}`, `1 / ${value}`, `1, ${value}`, `1 ${value}`,
    `0x ${value}`, `0b ${value}`, `1n ${value}`, `1d ${value}`, '9007199254740992',
  ];
  for (const prefix of ['CPU 99%; ', 'Latency 99ms, ', 'Sample 99！']) {
    for (let tokenIndex = 0; tokenIndex < badTokens(1).length; tokenIndex++) {
      for (const [name, alert] of boundarySamples(prefix, value => badTokens(value)[tokenIndex])) {
        expectDecision(name, alert, false);
        if (name === 'brute-force') assert.equal(failureCount(alert), 0, alert.rule.description);
      }
    }
  }
});

test('ambiguous bare-number connectors remain unsupported while units and strong clauses establish independence', () => {
  for (const connector of [', ', '. ', ': ', ' ', '\t', '\n', '\u2028', "' ", '’ ', '/', ' / ', '\u200b']) {
    for (const [name, alert] of boundarySamples('', value => `7${connector}${value}`)) {
      expectDecision(name, alert, false);
    }
  }
  for (const prefix of ['CPU 99% ', 'Latency 99ms, ', 'Sample 99;']) {
    for (const [name, alert, reason] of boundarySamples(prefix)) expectDecision(name, alert, true, reason);
  }
});

test('numeric readers with a literal prefix and other quantity positions preserve their original evidence', () => {
  for (const prefix of ['CPU 99%; ', 'Latency 99ms, ', 'Sample 99！']) {
    const compact = synthetic('brute-force', `${prefix}20failed login attempts from the same IP within 1minute`);
    expectDecision('brute-force', compact, true, 'rapid_source_login_failures');
    assert.equal(failureCount(compact), 20, compact.rule.description);
    const bruteDuration = synthetic('brute-force', `20 failed login attempts from the same IP within ${prefix}1 minute`);
    expectDecision('brute-force', bruteDuration, true, 'rapid_source_login_failures');
    const bruteAccounts = synthetic('brute-force', `Failed login attempts against ${prefix}15 accounts at regular intervals from the same IP`);
    bruteAccounts.data.failures = 1;
    expectDecision('brute-force', bruteAccounts, true, 'regular_multi_account_failures');
    const bruteKorean = synthetic('brute-force', `같은 주소에서 1분 안에 ${prefix}로그인 실패 20건입니다.`);
    expectDecision('brute-force', bruteKorean, true, 'rapid_source_login_failures');
    const spray = synthetic('brute-force', `${prefix}계정 2개에 같은 비밀번호를 시도했지만 로그인 실패`);
    expectDecision('brute-force', spray, true, 'cross_account_password_spray');
    const privilege = fixtures('privilege')[0];
    delete privilege.data.count;
    privilege.rule.description = `같은 주소에서 ${prefix}계정 3개가 관리자 그룹에 추가됐습니다.`;
    expectDecision('privilege', privilege, true, 'multiple_accounts_added_to_admins');
    const documents = fixture('exfiltration', 'ex-01');
    documents.rule.description = documents.rule.description.replace('자료 200건', `${prefix}자료 200건`);
    expectDecision('exfiltration', documents, true, 'rapid_bulk_to_new_destination');
    const repeated = fixture('exfiltration', 'ex-03');
    repeated.rule.description = `같은 목적지로 대용량 전송이 ${prefix}2번입니다.`;
    expectDecision('exfiltration', repeated, true, 'repeated_large_same_destination');
    const destinations = fixture('exfiltration', 'ex-10');
    destinations.rule.description = `처음 보는 주소로 같은 압축 파일이 나갔습니다. ${prefix}목적지 2곳입니다.`;
    expectDecision('exfiltration', destinations, true, 'same_archive_multiple_unknown_destinations');
  }
});

test('invalid evidence in one clause cannot suppress independent valid evidence in another clause', () => {
  for (const metadata of ['CPU 99%; ', 'Latency 99ms, ', 'Sample 99！']) {
    for (const validFirst of [false, true]) {
      const valid = boundarySamples(metadata);
      const invalid = boundarySamples(metadata, value => `7'${String(value).padStart(3, '0')}`);
      for (let i = 0; i < valid.length; i++) {
        const [name, alert, reason] = valid[i];
        const descriptions = [alert.rule.description, invalid[i][1].rule.description];
        if (!validFirst) descriptions.reverse();
        alert.rule.description = descriptions.join('; ');
        expectDecision(name, alert, true, reason);
      }
    }
  }
});

test('numeric evidence retains original ordering offsets and the original semantic limit after clause splitting', () => {
  const offHours = fixture('exfiltration', 'ex-06');
  for (const [description, expected] of [
    ['업무 시간 밖에 같은 목적지로 전송이 CPU 99%; 10번입니다.', true],
    ['업무 시간 밖에 같은 목적지로 CPU 99%; 10번입니다. 전송', false],
  ]) {
    offHours.rule.description = description;
    expectDecision('exfiltration', offHours, expected, 'offhours_repeated_large_transfer');
  }
  for (const [earlier, later, expected] of [['14', '15', false], ['15', '14', true]]) {
    const alert = synthetic('brute-force', `Failed login attempts from the same IP at regular intervals: ${earlier} accounts; CPU 99%; ${later} accounts`);
    alert.data.failures = 1;
    expectDecision('brute-force', alert, expected, 'regular_multi_account_failures');
  }
  for (const [name, base, reason] of boundarySamples('CPU 99%; ')) {
    const description = base.rule.description;
    const marker = 'CPU 99%; ';
    const start = description.indexOf(marker);
    const tail = description.slice(start);
    for (const offset of [1024 - tail.length, 1024]) {
      const alert = structuredClone(base);
      alert.rule.description = description.slice(0, start).padEnd(offset, ' ') + tail;
      if (offset === 1024) {
        // Preserve review relevance without supplying the missing quantity.
        alert.rule.description = '로그인 실패 SQL 삽입 서비스 등록 관리자 그룹 전송 '.padEnd(offset, ' ') + tail;
      }
      expectDecision(name, alert, offset < 1024, reason);
    }
  }
});

test('ordinary sentence delimiters and quotes or brackets around positive evidence do not become numeric separators', () => {
  const samples = [
    ['brute-force', synthetic('brute-force', '20 failed login attempts from the same IP within 1 minute')],
    ['web-injection', synthetic('web-injection', '같은 주소에서 SQL 삽입이 8회 반복됐습니다.')],
    ['persistence', fixture('persistence', 'ps-04')],
    ['privilege', fixture('privilege', 'pv-09')],
    ['exfiltration', fixture('exfiltration', 'ex-01')],
  ];
  for (const [name, base] of samples) {
    delete base.data.count;
    for (const [open, close] of [["'", "'"], ['"', '"'], ['‘', '’'], ['“', '”'],
      ['(', ')'], ['[', ']'], ['{', '}'], ['「', '」'], ['`', '`']]) {
      const alert = { ...base, rule: { ...base.rule, description: open + base.rule.description + close } };
      expectDecision(name, alert, true);
    }
    for (const delimiter of [': ', '; ', ', ', '. ', '\n', '\t']) {
      const alert = { ...base, rule: { ...base.rule, description: 'Summary' + delimiter + base.rule.description } };
      expectDecision(name, alert, true);
    }
  }
});

test('brute-force durations use the whole integer and original units at the ten-minute boundary', () => {
  const cases = [
    ['1 minute', true], ['10 minutes', true], ['11 minutes', false],
    ['600 seconds', true], ['601 seconds', false], ['1001 minutes', false], ['6001 seconds', false],
    ['10분', true], ['11분', false], ['600초', true], ['601초', false], ['1시간', false],
    ['1 MIN', true], ['0001 mins', true], ['0 minutes', false],
    ...malformedTokens('1').map(token => [`${token} minutes`, false]),
  ];
  for (const [duration, expected] of cases) {
    const alert = synthetic('brute-force', `20 failed login attempts from the same IP within ${duration}`);
    alert.data.failures = '20';
    expectDecision('brute-force', alert, expected, 'rapid_source_login_failures');
  }
});

test('brute-force failure counts reject malformed and overlong complete tokens instead of extracting suffixes', () => {
  for (const token of ['20', '00020', '50', '99999', '0', '19', '100000', '100020', ...malformedTokens('20')]) {
    const expected = ['20', '00020', '50', '99999'].includes(token);
    for (const description of [
      `${token} failed login attempts from the same IP within 1 minute`,
      `같은 주소에서 1분 안에 로그인 실패 ${token}건입니다.`,
      `같은 주소에서 1분 안에 ${token}회 로그인 실패했습니다.`,
    ]) {
      const alert = synthetic('brute-force', description);
      expectDecision('brute-force', alert, expected, 'rapid_source_login_failures');
      if (!/^\d{1,5}$/u.test(token)) assert.equal(failureCount(alert), 0, token);
    }
  }
});

test('brute-force regular account evidence is a complete safe integer with a minimum of fifteen', () => {
  for (const token of ['0', '14', '15', '100003', ...malformedTokens('15')]) {
    const expected = token === '15' || token === '100003';
    for (const description of [
      `Failed login attempts against ${token} accounts at regular intervals from the same IP`,
      `같은 주소가 계정 ${token}개에 같은 간격으로 로그인 실패를 넣었습니다.`,
    ]) {
      const alert = synthetic('brute-force', description);
      alert.data.failures = '1';
      expectDecision('brute-force', alert, expected, 'regular_multi_account_failures');
    }
  }
});

test('brute-force numeric spray evidence requires at least two accounts while natural multiple-account evidence remains valid', () => {
  for (const token of ['0', '1', '2', '15', ...malformedTokens('2')]) {
    const alert = synthetic('brute-force', `계정 ${token}개에 같은 비밀번호를 시도했지만 로그인 실패`);
    expectDecision('brute-force', alert, token === '2' || token === '15', 'cross_account_password_spray');
  }
  for (const description of [
    '여러 계정에 같은 비밀번호를 넣었지만 로그인 실패',
    '서로 다른 계정에 같은 비밀번호를 넣었지만 로그인 실패',
    'Failed login attempts using the same password against multiple accounts',
  ]) expectDecision('brute-force', synthetic('brute-force', description), true, 'cross_account_password_spray');
});

test('web textual repetition counts require complete bounded unsigned integers', () => {
  for (const token of ['0', '7', '8', '12', '99999', '100000', '100008', ...malformedTokens('8')]) {
    const alert = synthetic('web-injection', `같은 주소에서 SQL 삽입이 ${token}회 반복됐습니다.`);
    expectDecision('web-injection', alert, ['8', '12', '99999'].includes(token), 'repeated_sql_injection');
  }
});

test('persistence applies minOccurrences to the full count including ten, eleven and twelve', () => {
  for (const token of ['0', '2', '3', '9', '10', '11', '12', '13', '100003', ...malformedTokens('3')]) {
    const alert = fixture('persistence', 'ps-04');
    delete alert.data.count;
    alert.rule.description = `서명 없는 서비스 등록이 ${token}회 반복됐습니다.`;
    expectDecision('persistence', alert, ['3', '9', '10', '11', '12', '13', '100003'].includes(token), 'repeated_unsigned_service_registration');
  }
});

test('privilege regrant requires an actual one- or two-minute quantity rather than a matching suffix', () => {
  for (const token of ['0', '1', '2', '3', '11', '12', '101', ...malformedTokens('1')]) {
    const alert = fixture('privilege', 'pv-09');
    alert.rule.description = alert.rule.description.replace('1분 뒤', `${token}분 뒤`);
    expectDecision('privilege', alert, token === '1' || token === '2', 'rapid_admin_group_regrant');
  }
  for (const immediate of ['곧바로', '즉시']) {
    const alert = fixture('privilege', 'pv-09');
    alert.rule.description = alert.rule.description.replace('1분 뒤', immediate);
    expectDecision('privilege', alert, true, 'rapid_admin_group_regrant');
  }
});

test('privilege account evidence retains complete large integer controls and rejects unsafe or malformed values', () => {
  for (const token of ['0', '2', '3', '100003', ...malformedTokens('3')]) {
    const alert = fixtures('privilege')[0];
    delete alert.data.count;
    alert.rule.description = `같은 주소에서 계정 ${token}개가 관리자 그룹에 추가됐습니다.`;
    expectDecision('privilege', alert, token === '3' || token === '100003', 'multiple_accounts_added_to_admins');
  }
});

test('exfiltration keeps the supported ten-minute phrase without treating longer or malformed durations as ten', () => {
  for (const token of ['0', '10', '11', '110', '1010', ...malformedTokens('10')]) {
    const alert = fixture('exfiltration', 'ex-01');
    alert.rule.description = alert.rule.description.replace('10분 안', `${token}분 안`);
    expectDecision('exfiltration', alert, token === '10', 'rapid_bulk_to_new_destination');
  }
});

test('exfiltration numeric document counts must substantiate many documents instead of merely containing digits', () => {
  for (const token of ['0', '1', '99', '100', '200', ...malformedTokens('100')]) {
    const alert = fixture('exfiltration', 'ex-01');
    alert.rule.description = alert.rule.description.replace('자료 200건', `자료 ${token}건`);
    expectDecision('exfiltration', alert, token === '100' || token === '200', 'rapid_bulk_to_new_destination');
  }
});

test('exfiltration numeric repetition evidence requires multiplicity and the off-hours quantity respects its minimum', () => {
  for (const token of ['0', '1', '2', '8', ...malformedTokens('2')]) {
    const alert = fixture('exfiltration', 'ex-03');
    alert.rule.description = `같은 목적지로 대용량 전송이 ${token}번입니다.`;
    expectDecision('exfiltration', alert, token === '2' || token === '8', 'repeated_large_same_destination');
  }
  for (const token of ['0', '1', '9', '10', '15', ...malformedTokens('10')]) {
    const alert = fixture('exfiltration', 'ex-06');
    alert.rule.description = `업무 시간 밖에 같은 목적지로 전송이 ${token}번입니다.`;
    expectDecision('exfiltration', alert, token === '10' || token === '15', 'offhours_repeated_large_transfer');
  }
});

test('exfiltration multiple destinations requires at least two and retains the original Korean two-place phrase', () => {
  for (const token of ['두', '0', '1', '2', '15', ...malformedTokens('2')]) {
    const alert = fixture('exfiltration', 'ex-10');
    alert.rule.description = alert.rule.description.replace('목적지 두 곳', `목적지 ${token}곳`);
    expectDecision('exfiltration', alert, ['두', '2', '15'].includes(token), 'same_archive_multiple_unknown_destinations');
  }
});

test('known-CVE invalid scalar counts cannot invent repetition but preserve independently complete lookup evidence', () => {
  const base = fixtures('known-cve').find(alert => modules['known-cve'].decide(alert).reason === 'repeated_remote_jndi_lookup');
  assert.ok(base);
  for (const count of ['3', '4', ...malformedTokens('4'), null, undefined, NaN, Infinity, [], {}, Symbol('count')]) {
    const alert = { ...base, data: { ...base.data, count } };
    const decision = modules['known-cve'].decide(alert);
    assert.equal(decision.action, 'block', 'independent complete lookup evidence remains applicable');
    assert.equal(decision.reason === 'repeated_remote_jndi_lookup', count === '4');
  }
});

test('valid structured counts remain independent evidence when the description alone has an unsupported quantity', () => {
  const brute = synthetic('brute-force', '-20 failed login attempts from the same IP within 1 minute');
  brute.data.failures = 20;
  expectDecision('brute-force', brute, true, 'rapid_source_login_failures');
  const web = synthetic('web-injection', '같은 주소에서 SQL 삽입이 -8회 반복됐습니다.');
  web.data.count = 8;
  expectDecision('web-injection', web, true, 'repeated_sql_injection');
  const persistence = fixture('persistence', 'ps-04');
  persistence.rule.description = '서명 없는 서비스 등록이 -3회 반복됐습니다.';
  persistence.data.count = 3;
  expectDecision('persistence', persistence, true, 'repeated_unsigned_service_registration');
  const privilege = fixtures('privilege')[0];
  privilege.rule.description = '같은 주소에서 계정 -3개가 관리자 그룹에 추가됐습니다.';
  privilege.data.count = 3;
  expectDecision('privilege', privilege, true, 'multiple_accounts_added_to_admins');
});

test('new numeric extraction stays inside the original 1,024-character semantic description boundary', () => {
  const rows = [
    ['brute-force', synthetic('brute-force', ''), 'Failed login attempts from the same IP within 1 minute. ', '20 failed login attempts'],
    ['web-injection', synthetic('web-injection', ''), '같은 주소에서 SQL 삽입이 반복됐습니다. ', '8회.'],
    ['persistence', fixture('persistence', 'ps-04'), '서명 없는 서비스 등록이 반복됐습니다. ', '3회'],
    ['privilege', fixture('privilege', 'pv-09'), '관리자 그룹에서 빠진 계정이 다시 관리자로 들어왔습니다. ', '1분 뒤'],
    ['exfiltration', fixture('exfiltration', 'ex-01'), '자료 200건이 처음 보는 목적지로 나갔습니다. ', '10분 안'],
  ];
  for (const [name, base, prefix, suffix] of rows) {
    delete base.data.count;
    for (const offset of [1024 - suffix.length, 1024]) {
      const alert = { ...base, rule: { ...base.rule, description: prefix.padEnd(offset, ' ') + suffix } };
      expectDecision(name, alert, offset + suffix.length <= 1024);
    }
  }
});
