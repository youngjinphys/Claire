// Isolated judge entry. No imports, packages, file IO, environment, or network.
// This pattern constant is an exact copy of xdr/privilege/patterns.json.
const PATTERNS = Object.freeze([
  {
    "name": "remote_admin_group_enrollment",
    "condition": {
      "signal": "기존 비관리자가 원격 요청 뒤 관리자 그룹에 실제 추가됨",
      "requires": [
        "admin_group",
        "new_membership",
        "remote_origin"
      ],
      "minRuleLevel": 10
    },
    "confidence": 0.96,
    "evidence": "MITRE T1078·T1098.007: 유효 계정에 관리자 그룹 권한을 부여하는 비정상 변경은 권한 오남용 신호입니다."
  },
  {
    "name": "newly_elevated_account_admin_command",
    "condition": {
      "signal": "방금 관리자가 된 계정이 곧 관리자 명령까지 실행함",
      "requires": [
        "recent_elevation",
        "admin_command"
      ],
      "minRuleLevel": 10
    },
    "confidence": 0.98,
    "evidence": "MITRE T1078·T1548: 권한 상승 직후 관리자 명령 실행의 행위 연계는 계정 악용 징후를 강화합니다."
  },
  {
    "name": "offhours_new_origin_admin_command",
    "condition": {
      "signal": "평소 업무 외 시간과 처음 보는 주소에서 관리자 명령 실행",
      "requires": [
        "offhours",
        "unfamiliar_origin",
        "admin_command"
      ],
      "minRuleLevel": 10
    },
    "confidence": 0.94,
    "evidence": "MITRE T1078·T1548: 비정상 시각·미관측 주소의 관리자 명령은 유효 계정 악용을 조사할 복합 신호입니다."
  },
  {
    "name": "ordinary_user_admin_membership_and_execution",
    "condition": {
      "signal": "일반 계정의 관리자 그룹 편입 후 즉시 권한 명령 실행",
      "requires": [
        "ordinary_account",
        "admin_group",
        "elevation_then_execution"
      ],
      "minRuleLevel": 10
    },
    "confidence": 0.99,
    "evidence": "MITRE T1098.007·T1078: 일반 계정의 관리자 그룹 편입과 즉시 실행이 결합하면 권한 오남용 가능성이 높아집니다."
  },
  {
    "name": "multiple_accounts_added_to_admins",
    "condition": {
      "signal": "같은 주소에서 세 개 이상 계정이 관리자 그룹에 추가됨",
      "requires": [
        "admin_group",
        "multiple_accounts",
        "shared_source"
      ],
      "minAccounts": 3,
      "minRuleLevel": 10
    },
    "confidence": 0.96,
    "evidence": "MITRE T1098.007·T1078: 단일 출발지에서 여러 계정을 관리자 그룹에 추가하는 행위는 대량 권한 조작 신호입니다."
  },
  {
    "name": "session_admin_elevation_new_origin",
    "condition": {
      "signal": "세션 권한이 관리자로 변하고 출발 주소도 미관측",
      "requires": [
        "admin_session_change",
        "unfamiliar_origin"
      ],
      "minRuleLevel": 10
    },
    "confidence": 0.96,
    "evidence": "MITRE T1078·T1548: 새 출발지에서의 관리자 세션 권한 변화는 계정 악용의 복합 이상 징후입니다."
  },
  {
    "name": "offhours_admin_group_and_command",
    "condition": {
      "signal": "업무 외 시간에 관리자 그룹 추가와 권한 명령 실행이 함께 관측",
      "requires": [
        "offhours",
        "admin_group",
        "admin_command"
      ],
      "minRuleLevel": 10
    },
    "confidence": 0.98,
    "evidence": "MITRE T1098.007·T1078: 비정상 시간의 관리자 그룹 변경과 후속 실행은 권한 오남용 연쇄입니다."
  },
  {
    "name": "cross_account_admin_command",
    "condition": {
      "signal": "현재 계정이 다른 계정의 권한으로 관리자 명령을 실행",
      "requires": [
        "other_account_privilege",
        "admin_command"
      ],
      "minRuleLevel": 10
    },
    "confidence": 0.95,
    "evidence": "MITRE T1078·T1548: 계정 간 권한 사용과 관리자 명령 결합은 계정 오용 여부 확인이 필요한 강한 징후입니다."
  },
  {
    "name": "rapid_admin_group_regrant",
    "condition": {
      "signal": "관리자 그룹에서 제외된 뒤 짧은 시간 안에 재편입",
      "requires": [
        "previous_removal",
        "quick_readdition",
        "admin_group"
      ],
      "maxMinutes": 2,
      "minRuleLevel": 10
    },
    "confidence": 0.93,
    "evidence": "MITRE T1098.007·T1078: 관리자 권한 철회 직후 재부여는 승인되지 않은 계정 권한 조작 신호일 수 있습니다."
  },
  {
    "name": "unconfirmed_privilege_activity",
    "condition": {
      "signal": "관리자 명령·그룹 변경·권한 상승 단서가 있지만 충분한 악성 근거는 없음",
      "requires": [
        "related_event",
        "incomplete_evidence"
      ],
      "minRuleLevel": 5
    },
    "confidence": 0.65,
    "evidence": "MITRE T1068·T1078: 취약점 악용 또는 유효 계정 침해가 확인되지 않은 단발 권한 이벤트는 우선 조사·알림 대상으로 취급합니다."
  }
]);

// Keep this parser self-contained: the isolated judge receives only decide.mjs.
// Regression tests compare this contract with the readers' built-in IP parser.
function validIPv4(value) {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u.test(value)) return false;
  return value.split('.').every((part) => Number(part) <= 255);
}

function validAddress(value) {
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

function normalize(alert) {
  if (!alert || typeof alert !== 'object' || Array.isArray(alert)) return null;
  const rule = alert.rule && typeof alert.rule === 'object' && !Array.isArray(alert.rule) ? alert.rule : {};
  const data = alert.data && typeof alert.data === 'object' && !Array.isArray(alert.data) ? alert.data : {};
  const rawTime = alert.timestamp ?? alert.at;
  const ip = data.srcip ?? alert.sourceAddress;
  const user = data.srcuser ?? alert.account;
  const level = rule.level ?? alert.ruleLevel;
  const text = rule.description ?? alert.description;
  const mitre = rule.mitre ?? alert.mitre ?? [];
  const tags = Array.isArray(mitre) ? mitre
    : Array.isArray(mitre?.id) ? mitre.id
      : typeof mitre?.id === 'string' ? [mitre.id] : [];
  const group = data.group ?? alert.group ?? null;
  const count = data.count ?? alert.count;
  return {
    at: typeof rawTime === 'string' && Number.isFinite(Date.parse(rawTime)) ? rawTime : null,
    source: validAddress(ip) ? ip : null,
    account: typeof user === 'string' && /^[a-z][a-z0-9._-]{0,47}$/iu.test(user) ? user : null,
    level: Number.isInteger(level) && level >= 0 && level <= 16 ? level : null,
    text: typeof text === 'string' ? text.slice(0, 1024) : '',
    tagged: tags.some(t => t === 'T1068' || t === 'T1078' || t === 'T1098' || t === 'T1098.007' || t === 'T1548'),
    group: typeof group === 'string' ? group.toLowerCase() : null,
    count: (typeof count === 'string' || typeof count === 'number') && /^\d{1,5}$/u.test(String(count))
      ? Number(count) : 0,
  };
}

function approvedGroupMention(event) {
  if (event.group !== null && !/^(?:administrators|builtin\\administrators|sudo|wheel)$/u.test(event.group)) return false;
  return /관리자\s*그룹|관리자로\s*들어|administrators|admin(?:istrator)?\s*group/iu.test(event.text);
}

function explicitlyBenign(text) {
  return /(?:로그인했습니다|로그아웃했습니다|그룹\s*소속을\s*읽기만|비밀번호를\s*변경했습니다|자기\s*세션\s*정보를\s*조회|자료실을\s*열었습니다|평소\s*예약\s*작업을\s*확인|평소\s*주소에서\s*로그인했습니다)/iu.test(text);
}

function indicators(event) {
  const text = event.text;
  const group = approvedGroupMention(event);
  const adminCommand = /관리자\s*명령|권한\s*명령|명령\s*실행|admin(?:istrator)?\s*command/iu.test(text);
  const offHours = /수업\s*시간\s*밖|업무\s*시간\s*밖|업무처럼\s*보이지\s*않는\s*시각|야간|비업무\s*시간|off[-\s]?hours/iu.test(text);
  const newOrigin = /처음\s*보는\s*주소|주소는\s*처음\s*(?:봅니다|봤|보는)|낯선\s*(?:주소|출발지)|미확인\s*주소|unfamiliar\s*(?:ip|address)/iu.test(text);
  const accountNumber = integerEvidence(text, '개', String.raw`계정\s*`)[0]?.value ?? 0;
  const number = event.count || accountNumber;
  return {
    remote_admin_group_enrollment: group && /원격\s*주소|원격\s*접속|remote\s*address/iu.test(text)
      && /(?:추가됐|추가되었습니다|추가됨|추가했|등록됐)/iu.test(text),
    newly_elevated_account_admin_command: /방금\s*관리자가\s*된|관리자\s*권한을\s*막\s*얻은/iu.test(text)
      && adminCommand && /실행/iu.test(text),
    offhours_new_origin_admin_command: offHours && newOrigin && adminCommand && /실행/iu.test(text),
    ordinary_user_admin_membership_and_execution: group
      && /평범한\s*계정|일반\s*사용자|비관리자\s*계정/iu.test(text)
      && /들어가|추가|편입/iu.test(text)
      && /곧바로|즉시|바로/iu.test(text) && adminCommand && /실행/iu.test(text),
    multiple_accounts_added_to_admins: group && number >= 3
      && /같은\s*주소|동일\s*주소|같은\s*출발지/iu.test(text)
      && /계정.*관리자\s*그룹.*추가|관리자\s*그룹.*계정.*추가/iu.test(text),
    session_admin_elevation_new_origin: /세션.*관리자\s*권한.*바뀌|관리자\s*세션.*변경/iu.test(text)
      && newOrigin,
    offhours_admin_group_and_command: group && offHours && /추가|편입/iu.test(text)
      && adminCommand && /실행/iu.test(text),
    cross_account_admin_command: /다른\s*계정의\s*권한|타인\s*계정\s*권한|다른\s*사용자의\s*권한/iu.test(text)
      && adminCommand && /실행/iu.test(text),
    rapid_admin_group_regrant: group
      && /그룹에서\s*빠진|관리자\s*권한.*철회|관리자\s*그룹.*제외/iu.test(text)
      && /다시|재추가|재부여/iu.test(text)
      && (/곧바로|즉시/iu.test(text)
        || integerEvidence(text, String.raw`분\s*뒤`).some(({ value }) => value > 0 && value <= PATTERNS[8].condition.maxMinutes)),
  };
}

export function decide(alert) {
  const row = normalize(alert);
  if (!row) return { action: 'record', confidence: 0.1, reason: 'no_privilege_signal' };
  if (explicitlyBenign(row.text)) {
    return { action: 'record', confidence: 0.1, reason: 'normal_account_activity' };
  }
  const relevant = /권한|계정|그룹|관리자|세션|privileg|admin|elevat/iu.test(row.text);
  const trustedShape = row.at && row.source && row.account;
  const severe = row.level !== null && row.level >= 10; // Description must independently match a compound pattern.
  if (relevant && trustedShape && severe) {
    const matched = indicators(row);
    for (const pattern of PATTERNS) {
      if (pattern.confidence >= 0.85 && matched[pattern.name]) {
        return { action: 'block', confidence: pattern.confidence, reason: pattern.name };
      }
    }
  }
  // A high Wazuh level or ATT&CK tag is not independent proof of exploitation
  // or account compromise. Incomplete privilege evidence remains review-only.
  if (relevant && (row.tagged || (row.level !== null && row.level >= 5))) {
    const review = PATTERNS[PATTERNS.length - 1];
    return { action: 'alert', confidence: review.confidence, reason: review.name };
  }
  return { action: 'record', confidence: 0.1, reason: 'no_privilege_signal' };
}
