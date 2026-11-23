// Isolated XDR judge module. No imports, files, environment, network or side effects.
// The complete PATTERNS constant is a copy of xdr/persistence/patterns.json.
const PATTERNS = Object.freeze([
  {
    "name": "unsigned_new_temp_service",
    "condition": {
      "signal": "새 서비스 등록 + 서명 없음 + 임시 실행 경로",
      "technique": "T1543.003",
      "minRuleLevel": 10
    },
    "confidence": 0.97,
    "evidence": "MITRE T1543.003: 서명되지 않은 새로운 Windows 서비스가 비표준 임시 실행 파일을 실행하도록 등록되는 것은 강한 지속성 공격 신호입니다."
  },
  {
    "name": "unknown_offhours_temp_task",
    "condition": {
      "signal": "낯선 예약 작업 + 업무 시간 밖 실행 + 임시 실행 경로",
      "technique": "T1053.005",
      "minRuleLevel": 10
    },
    "confidence": 0.95,
    "evidence": "MITRE T1053.005: 알려지지 않은 예약 작업이 비표준 파일을 지정된 시간에 실행하도록 생성되면 지속성 공격 징후입니다."
  },
  {
    "name": "unlisted_startup_folder_program",
    "condition": {
      "signal": "기준 목록에 없는 시작 폴더 프로그램 추가",
      "technique": "T1547.001",
      "minRuleLevel": 10
    },
    "confidence": 0.9,
    "evidence": "MITRE T1547.001: 시작 폴더에 새 항목을 등록하면 다음 로그인에서 자동 실행되므로 기준 목록에 없는 추가를 탐지해야 합니다."
  },
  {
    "name": "repeated_unsigned_service_registration",
    "condition": {
      "signal": "서명 없는 서비스 등록이 같은 근원에서 3회 이상 반복",
      "technique": "T1543.003",
      "minOccurrences": 3
    },
    "confidence": 0.94,
    "evidence": "MITRE T1543.003: 새 서비스를 반복 등록하는 비정상 행위와 서명 부재가 결합하면 지속성 악용의 신뢰할 수 있는 탐지 단서입니다."
  },
  {
    "name": "random_named_temp_scheduled_task",
    "condition": {
      "signal": "임의 이름의 예약 작업 + 임시 실행 파일",
      "technique": "T1053.005",
      "minRuleLevel": 10
    },
    "confidence": 0.94,
    "evidence": "MITRE T1053.005: 무작위 식별자의 예약 작업이 임시 경로의 프로그램을 실행하게 만들면 은닉 실행을 의심할 수 있습니다."
  },
  {
    "name": "unsigned_modified_service_binary",
    "condition": {
      "signal": "서비스 실행 파일 변경 + 서명 없음",
      "technique": "T1543.003",
      "minRuleLevel": 10
    },
    "confidence": 0.95,
    "evidence": "MITRE T1543.003: 기존 서비스의 실행 바이너리를 무서명 파일로 변경하면 지속성 실행 경로가 변조될 수 있습니다."
  },
  {
    "name": "dual_startup_and_scheduled_task",
    "condition": {
      "signal": "같은 임시 파일에 시작 프로그램과 예약 작업이 모두 연결됨",
      "technique": "T1053.005 + T1547.001",
      "minRuleLevel": 10
    },
    "confidence": 0.97,
    "evidence": "MITRE T1053.005·T1547.001: 한 임시 파일을 예약 작업과 로그인 자동 실행에 중복 연결하면 지속성 확보를 뒷받침하는 복수 증거입니다."
  },
  {
    "name": "unlisted_reboot_persistent_service",
    "condition": {
      "signal": "기준 목록 외 서비스가 재시작 뒤에도 남도록 신규 등록됨",
      "technique": "T1543.003",
      "minRuleLevel": 10
    },
    "confidence": 0.96,
    "evidence": "MITRE T1543.003: 승인 목록 밖의 자동 시작 서비스가 재부팅 후에도 비표준 실행 파일로 남도록 등록되는 것은 강한 지속성 징후입니다."
  },
  {
    "name": "unverified_persistence_artifact",
    "condition": {
      "signal": "서비스·작업·시작 항목·실행 파일 단서가 있으나 독립적인 악성 근거 부족",
      "technique": "T1543 + T1053",
      "minRuleLevel": 5
    },
    "confidence": 0.65,
    "evidence": "MITRE T1543·T1053: 서비스나 예약 작업의 변경 사실만으로 악성 여부가 확정되지 않으므로 별도 승인·서명·기준 목록 점검이 필요합니다."
  }
]);

// Keep this parser self-contained: the isolated judge receives only decide.mjs.
// Regression tests compare this contract with the readers' built-in IP parser.
function validIPv4(value) {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u.test(value)) return false;
  return value.split('.').every((part) => Number(part) <= 255);
}

function validIp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  let address = value;
  const zone = address.indexOf('%');
  if (zone !== -1) {
    if (!/^[0-9A-Za-z.:-]+$/u.test(address.slice(zone + 1))) return false;
    address = address.slice(0, zone);
    if (!address.includes(':')) return false;
  }
  if (address.length > 45) return false;
  if (validIPv4(address)) return true;
  if (!address.includes(':') || !/^[a-fA-F0-9:.]+$/u.test(address)) return false;
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    if (!validIPv4(address.slice(lastColon + 1))) return false;
    // An embedded IPv4 suffix occupies exactly two IPv6 groups.
    address = address.slice(0, lastColon) + ':0:0';
  }
  const sides = address.split('::');
  if (sides.length > 2) return false;
  const parts = sides.flatMap((side) => side ? side.split(':') : []);
  if (parts.some((part) => !/^[a-fA-F0-9]{1,4}$/u.test(part))) return false;
  return sides.length === 2 ? parts.length < 8 : parts.length === 8;
}

// Validate whole numeric-looking tokens within independent quantity clauses.
// Ambiguous punctuation/spacing between bare numbers remains unsupported.
// Kept local so the isolated judge never needs another module.
// Evidence and metadata share the same opaque-prefix boundary. Real spacing,
// quotation and Korean word adjacency remain supported; marks never stand in
// for a word boundary. Metadata additionally admits an explicit assignment.
const NUMERIC_ENTRY = String.raw`(?:(?<=\s|['"\x60\p{Ps}\p{Pe}\p{Pi}\p{Pf}])|(?<=\p{Script=Hangul})(?<![\p{M}\p{Lm}])|(?<![\p{N}\p{L}\p{M}\p{P}\p{S}\p{C}]))`;
const INTEGER_TOKEN = String.raw`${NUMERIC_ENTRY}((?:[\p{Sm}\p{Sc}\p{Pd}]\s*)?\p{N}(?:[\p{N}A-Za-z]|[\p{P}\p{S}\p{Z}\p{C}\p{M}\p{Lm}\s]+(?=\p{N})|\s+(?=[eE](?:\s|[\p{Sm}\p{Sc}\p{Pd}]|\d)))*)`;
// Attached alphabetic components stay in their opaque numeric span. Across
// whitespace, check the complete continuation word: a first hex letter alone
// cannot make ordinary prose such as "caused" part of that span.
const NUMERIC_WORD = String.raw`(?:[\p{L}\p{M}_]*\p{N}[\p{N}\p{L}\p{M}_]*|x?[a-f]+(?:p|u(?:l{1,2})?|l{1,2}u?|n)?|[exbop]|u(?:l{1,2})?|l{1,2}u?|n|nan|inf(?:inity)?)`;
const NUMERIC_FRAGMENT = String.raw`(?:${NUMERIC_ENTRY}|(?<==))((?:[\p{Sm}\p{Sc}\p{Pd}]\s*)?\p{N}(?:[\p{N}\p{L}\p{M}]|(?:(?!\s)[\p{P}\p{S}\p{Z}\p{C}\p{M}\p{Lm}])+(?=[\p{N}\p{L}\p{M}])|[\p{P}\p{S}\p{Z}\p{C}\p{M}\p{Lm}\s]+(?=\p{N}|${NUMERIC_WORD}(?![\p{N}\p{L}\p{M}_])))*)`;
// Metadata need not be an evidence integer. Retain formatted/Unicode numbers
// and complete exponents, but never skip an opaque alphabetic prefix.
const METADATA_NUMBER = /^(?:[\p{Sm}\p{Sc}\p{Pd}]\s*)?\p{N}+(?:[\p{P}\p{S}\p{Z}\p{C}\p{M}\p{Lm}\s]+\p{N}+)*(?:\s*e\s*[\p{Sm}\p{Sc}\p{Pd}]?\s*\p{N}+)?\s*$/iu;
// Unit words use ordinary Unicode letters and their combining marks. Modifier
// letters remain numeric separators, so a grouping apostrophe is not a unit.
const UNIT_WORD = String.raw`(?:(?!\p{Lm})\p{L})(?:(?!\p{Lm})[\p{L}\p{M}])*(?:\/(?:(?!\p{Lm})\p{L})(?:(?!\p{Lm})[\p{L}\p{M}])*)*`;
// A Korean prose transition follows the entire preceding unit. It cannot
// restart inside a Korean word and call its first syllables an opaque unit.
const PROSE_UNIT_WORD = String.raw`(?:(?!\p{Script=Hangul}|\p{Lm})\p{L})(?:(?!\p{Script=Hangul}|\p{Lm})[\p{L}\p{M}])*(?:\/(?:(?!\p{Script=Hangul}|\p{Lm})\p{L})(?:(?!\p{Script=Hangul}|\p{Lm})[\p{L}\p{M}])*)*`;
// A candidate starts once per maximal numeric component, including within
// formatted metadata. Retrying every suffix of a long run adds no boundary.
const COMPLETED_QUANTITY = new RegExp(String.raw`(?<!\p{N})(\p{N}+)\s*([%٪％﹪‰‱؉؊]|per\s+cent|${UNIT_WORD}|°[CF])(?:['"\x60\p{Pe}\p{Pf}]\s*)*[\s.,:，．：、﹐﹒﹕]+`, 'giu');
// This only proposes a boundary: completeQuantity validates the whole prefix,
// so 1분 and 3ms후 can end ownership while 0x분 and 0b시간1F cannot.
const KOREAN_QUANTITY = new RegExp(String.raw`(?<!\p{N})(\p{N}+)\s*([%٪％﹪‰‱؉؊]|per\s+cent|${PROSE_UNIT_WORD}|°[CF])?(?:['"\x60\p{Pe}\p{Pf}]\s*)*(?=\p{Script=Hangul})`, 'giu');
const RADIX_COMPONENT = /(?<!\p{N})(\p{N}+)[\s_]*([xbo])/giu;
// UnicodeData 15.0 numeric-value-zero characters outside Decimal_Number.
const NON_DECIMAL_ZERO = /^[౸៰⁰₀↉⓪⓿〇ꛯ𐆊𖺀𝋀𝋠🄀🄁🄋🄌]$/u;

function zeroPrefix(value) {
  return value.length > 0 && [...value].every(character => {
    if (character === '0' || NON_DECIMAL_ZERO.test(character)) return true;
    if (!/\p{Decimal_Number}/u.test(character)) return false;
    // UAX #44: decimal digits form ascending 0..9 ranges. Adjacent ranges
    // (including mathematical styles) therefore retain the offset modulo 10.
    const point = character.codePointAt(0);
    let start = point;
    while (start > 0 && /\p{Decimal_Number}/u.test(String.fromCodePoint(start - 1))) start--;
    return (point - start) % 10 === 0;
  });
}

function radixFragment(value) {
  // Inspect every maximal numeric component in the retained span. A numeric
  // connector before 0x must not hide it behind an earlier decimal component.
  for (const match of value.matchAll(RADIX_COMPONENT)) {
    if (!zeroPrefix(match[1])) continue;
    if (match[2].toLowerCase() === 'x') return true;
    // A binary/octal body starts numerically; even an invalid base digit is
    // unsupported numeric syntax. An empty body retains the incomplete-marker
    // guard. Inspect the full remainder, so baud and B/s remain complete units
    // rather than being judged from a truncated b or a bag of suffix letters.
    const body = value.slice(match.index + match[0].length)
      .replace(/^[\p{P}\p{S}\p{Z}\p{C}\p{M}\p{Lm}\s]+/u, '');
    if (body.length === 0 || /^\p{N}/u.test(body)) return true;
  }
  return false;
}

function completeQuantity(text, match, start) {
  const unit = match[2] ?? '';
  const unitStart = match.index + match[0].indexOf(unit, match[1].length);
  const prefix = text.slice(start, unitStart).replace(/^[\s'"`\p{Ps}\p{Pi}]+/u, '');
  if (!METADATA_NUMBER.test(prefix)) return false;
  // Inspect the whole unit, including B/s, rather than an interior suffix.
  if (radixFragment(prefix + unit)) return false;
  return !/^(?:[edx]|nan|inf(?:inity)?)$/iu.test(unit) && unit !== 'n';
}

function numericFragments(text) {
  const finder = new RegExp(NUMERIC_FRAGMENT, 'giu');
  const completed = [...text.matchAll(COMPLETED_QUANTITY), ...text.matchAll(KOREAN_QUANTITY)]
    .sort((a, b) => a.index - b.index || b[0].length - a[0].length);
  const clauseEnds = [...text.matchAll(/[;!?؛；！？﹔﹖﹗。｡]+/gu)]
    .map(match => match.index + match[0].length);
  clauseEnds.push(text.length);
  const fragments = [];
  let completionIndex = 0;
  let fragment;
  while ((fragment = finder.exec(text))) {
    const start = fragment.index;
    const clauseEnd = clauseEnds.find(end => end > start);
    let end = Math.min(start + fragment[0].length, clauseEnd);
    let completedEnd = null;
    while (completionIndex < completed.length && completed[completionIndex].index < start) completionIndex++;
    for (let index = completionIndex; index < completed.length && completed[index].index < end; index++) {
      const match = completed[index];
      const next = match.index + match[0].length;
      if (next > clauseEnd || !completeQuantity(text, match, start)) continue;
      // This is an ownership boundary, not a cut in the evidence matcher.
      // "20 failed login" must still be matched as one semantic expression.
      end = next;
      completedEnd = next;
      break;
    }
    fragments.push({ index: start, end, completedEnd });
    finder.lastIndex = end;
  }
  return fragments;
}

function numericEvidenceSegments(text) {
  const boundaries = new Set([0, text.length]);
  for (const match of text.matchAll(/[;!?؛；！？﹔﹖﹗。｡]+/gu)) {
    boundaries.add(match.index + match[0].length);
  }
  for (const fragment of numericFragments(text)) {
    const end = fragment.completedEnd;
    // Only an immediately following quantity needs a separate matching slice.
    // Ordinary prose already ended ownership, without cutting semantic units.
    if (end !== null && /^(?:['"`\p{Ps}\p{Pi}]\s*)*(?:[\p{Sm}\p{Sc}\p{Pd}]\s*)?\p{N}/u.test(text.slice(end))) {
      boundaries.add(end);
    }
  }
  const offsets = [...boundaries].sort((a, b) => a - b);
  return offsets.slice(1).map((end, index) => ({
    text: text.slice(offsets[index], end), offset: offsets[index],
  }));
}

function integerEvidence(text, unit, prefix = '', maxDigits = Infinity) {
  const expression = new RegExp(prefix + INTEGER_TOKEN + String.raw`\s*` + unit, 'giu');
  const values = [];
  for (const segment of numericEvidenceSegments(text)) {
    const fragments = numericFragments(segment.text);
    for (const match of segment.text.matchAll(expression)) {
      const token = match[1];
      const start = match.index + match[0].indexOf(token);
      // The token matcher can restart after an unsupported fractional/opaque
      // component. Only the start of an independently owned span is evidence.
      if (fragments.some(part => part.index < start && start < part.end)) continue;
      if (token.length > maxDigits || !/^\d+$/u.test(token)) continue;
      const value = Number(token);
      if (Number.isSafeInteger(value)) values.push({ value, unit: match[2], index: segment.offset + match.index });
    }
  }
  return values;
}

function normalizeAlert(alert) {
  if (!alert || typeof alert !== 'object' || Array.isArray(alert)) return null;
  const data = alert.data && typeof alert.data === 'object' && !Array.isArray(alert.data) ? alert.data : {};
  const rule = alert.rule && typeof alert.rule === 'object' && !Array.isArray(alert.rule) ? alert.rule : {};
  const time = alert.timestamp ?? alert.at;
  const address = data.srcip ?? alert.sourceAddress;
  const account = data.srcuser ?? alert.account;
  const level = rule.level ?? alert.ruleLevel;
  const description = rule.description ?? alert.description;
  const path = data.path ?? alert.path;
  const rawMitre = rule.mitre ?? alert.mitre ?? [];
  const ids = Array.isArray(rawMitre) ? rawMitre
    : Array.isArray(rawMitre?.id) ? rawMitre.id
      : typeof rawMitre?.id === 'string' ? [rawMitre.id] : [];
  const value = data.count ?? alert.count;
  const count = (typeof value === 'number' || typeof value === 'string')
    && /^\d{1,5}$/u.test(String(value)) ? Number(value) : 0;
  return {
    timestamp: typeof time === 'string' && Number.isFinite(Date.parse(time)) ? time : null,
    sourceAddress: validIp(address) ? address : null,
    account: typeof account === 'string' && /^[a-z][a-z0-9._-]{0,47}$/iu.test(account)
      ? account : null,
    level: Number.isInteger(level) && level >= 0 && level <= 16 ? level : null,
    description: typeof description === 'string' ? description.slice(0, 1024) : '',
    path: typeof path === 'string' ? path.slice(0, 1024).replace(/\\/gu, '/') : '',
    tagged: ids.some(id => typeof id === 'string'
      && /^(?:T1543(?:\.\d{3})?|T1053(?:\.\d{3})?|T1547(?:\.\d{3})?)$/u.test(id)),
    count,
  };
}

function benignEvent(text) {
  return /로그인했습니다|로그아웃했습니다|목록을 읽기만|자료실 화면이 열|정의 업데이트.*끝났|운영체제 업데이트.*평소 시각에 그대로|기존.*(?:서명된 채|그대로|복사를 마쳤)|정상적인? 서비스 .*유지/iu.test(text);
}

function strongSignals(row) {
  const text = row.description;
  const path = row.path;
  const temp = /(?:^|\/)(?:temp|tmp)(?:\/|$)/iu.test(path) || /임시\s*폴더|임시\s*파일/iu.test(text);
  const service = /서비스/iu.test(text);
  const unsigned = /서명\s*없는|서명이?\s*없습니다|무서명|unsigned/iu.test(text);
  const task = /예약\s*작업|스케줄(?:러|된)\s*작업|scheduled\s*task/iu.test(text);
  return {
    unsigned_new_temp_service: service && unsigned && /새\s*서비스|새로\s*등록|신규\s*서비스/iu.test(text) && temp,
    unknown_offhours_temp_task: task && /처음\s*보는|낯선|미승인|알려지지\s*않은/iu.test(text)
      && /수업\s*시간\s*밖|업무\s*시간\s*밖|야간|비업무\s*시간/iu.test(text) && temp,
    unlisted_startup_folder_program: /시작\s*폴더|startup\s*folder/iu.test(text)
      && /평소\s*목록에\s*없는|승인\s*목록에\s*없는|알려지지\s*않은/iu.test(text)
      && /추가|등록|생성/iu.test(text),
    repeated_unsigned_service_registration: service && unsigned && /등록/iu.test(text)
      && /연속|반복/iu.test(text)
      && (row.count >= PATTERNS[3].condition.minOccurrences
        || integerEvidence(text, '(?:번|회|건)').some(({ value }) => value >= PATTERNS[3].condition.minOccurrences)),
    random_named_temp_scheduled_task: task && /이름.*임의\s*문자열|무작위\s*이름|임의\s*문자열.*이름/iu.test(text) && temp,
    unsigned_modified_service_binary: service && unsigned
      && /실행\s*파일.*(?:바뀌|변경|교체)|바뀐\s*실행\s*파일/iu.test(text),
    dual_startup_and_scheduled_task: task && /시작\s*(?:프로그램|폴더|항목)/iu.test(text)
      && /같은\s*임시\s*파일|동일\s*임시\s*파일|같은\s*파일/iu.test(text) && temp,
    unlisted_reboot_persistent_service: service
      && /평소\s*목록에\s*없는|승인\s*목록\s*밖|미승인/iu.test(text)
      && /다시\s*켜도\s*남|재시작.*남|재부팅.*남|자동\s*시작.*등록/iu.test(text),
  };
}

export function decide(alert) {
  const row = normalizeAlert(alert);
  if (!row) return { action: 'record', confidence: 0.1, reason: 'no_persistence_signal' };
  if (benignEvent(row.description)) {
    return { action: 'record', confidence: 0.1, reason: 'known_benign_system_activity' };
  }
  const corroborated = row.tagged || (row.level !== null && row.level >= 10);
  const sufficientlyScoped = row.timestamp && row.sourceAddress && row.account;
  if (corroborated && sufficientlyScoped && row.level !== null && row.level >= 10) {
    const signals = strongSignals(row);
    for (const pattern of PATTERNS) {
      if (pattern.confidence >= 0.85 && signals[pattern.name]) {
        return { action: 'block', confidence: pattern.confidence, reason: pattern.name };
      }
    }
  }
  // Unknown signatures, uncertain changes, isolated file creation and service
  // restarts alone require a review, not host quarantine.
  const relevant = /서비스|예약\s*작업|시작\s*(?:폴더|항목|프로그램)|임시\s*폴더|실행\s*파일|서명|scheduled\s*task|startup\s*folder/iu.test(row.description);
  if (relevant && (row.tagged || (row.level !== null && row.level >= 5))) {
    const review = PATTERNS[PATTERNS.length - 1];
    return { action: 'alert', confidence: review.confidence, reason: review.name };
  }
  return { action: 'record', confidence: 0.1, reason: 'no_persistence_signal' };
}
