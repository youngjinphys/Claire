// Isolated judge entry: all detection patterns are embedded here.
// This file exports only decide(alert), performs synchronous calculation,
// and does not touch files, packages, external services or global state.
const PATTERNS = Object.freeze([
  { name: 'repeated_sql_injection', condition: { minCount: 8, source: 'same_ip', signal: 'sql_syntax_or_explicit_injection_summary' }, confidence: 0.95 },
  { name: 'repeated_script_injection', condition: { minCount: 8, source: 'same_ip', signal: 'script_tag_or_explicit_insertion_summary' }, confidence: 0.94 },
  { name: 'repeated_path_traversal', condition: { minCount: 8, source: 'same_ip', signal: 'dotdot_path_or_explicit_traversal_summary' }, confidence: 0.93 },
  { name: 'repeated_command_delimiter', condition: { minCount: 8, source: 'same_ip', signal: 'command_delimiter_or_explicit_command_injection_summary' }, confidence: 0.90 },
  { name: 'review_suspicious_web_input', condition: { minCount: 1, signal: 'T1190_or_suspicious_single_request' }, confidence: 0.65 },
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

function readRow(alert) {
  if (!alert || typeof alert !== 'object' || Array.isArray(alert)) return null;
  const data = alert.data && typeof alert.data === 'object' && !Array.isArray(alert.data) ? alert.data : {};
  const rule = alert.rule && typeof alert.rule === 'object' ? alert.rule : {};
  const when = alert.timestamp ?? alert.at;
  const address = data.srcip ?? alert.sourceAddress;
  const level = rule.level ?? alert.ruleLevel;
  const rawSummary = rule.description ?? alert.description;
  const summary = typeof rawSummary === 'string' ? rawSummary.slice(0, 1024) : '';
  const url = data.url ?? alert.url;
  const count = data.count ?? alert.count ?? alert.requestCount;
  const ids = rule.mitre ?? alert.mitre ?? [];
  const mitreIds = Array.isArray(ids) ? ids
    : Array.isArray(ids.id) ? ids.id
      : typeof ids.id === 'string' ? [ids.id] : [];
  const tagged = mitreIds.includes('T1190');
  let repetitions = 0;
  if ((typeof count === 'string' || typeof count === 'number')
    && /^\d{1,5}$/u.test(String(count))) {
    repetitions = Number(count);
  } else {
    const counts = integerEvidence(summary, String.raw`(?:번|회|건)(?:\s|[이가을를은에.])`, '', 5);
    repetitions = counts.length ? Math.max(...counts.map(({ value }) => value)) : 0;
  }
  let request = typeof url === 'string' ? url.slice(0, 2048) : '';
  let requestComplete = typeof url === 'string' && url.length <= 2048;
  // For encoded malicious input, decode twice at most; never evaluate it.
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(request);
      if (next === request) break;
      request = next.slice(0, 2048);
    } catch {
      requestComplete = false;
      break;
    }
  }
  return {
    at: typeof when === 'string' && Number.isFinite(Date.parse(when)) ? when : null,
    source: validAddress(address) ? address : null,
    level: Number.isInteger(level) && level >= 0 && level <= 16 ? level : null,
    description: summary,
    descriptionComplete: typeof rawSummary === 'string' && rawSummary.length <= 1024,
    request,
    requestComplete: requestComplete && !/%[a-f0-9]{2}/iu.test(request),
    tagged,
    repetitions,
  };
}

function signalMatches(row) {
  const summary = row.description;
  const request = row.request;
  return {
    repeated_sql_injection:
      /SQL\s*(?:구문|표식|삽입|주입)|데이터베이스\s*조회.{0,40}(?:이어\s*붙|결합)|sql\s*injection/iu.test(summary)
      || /\bunion\s+(?:all\s+)?select\b|\bselect\b.{0,30}\bfrom\b|(?:'|")\s*(?:or|and)\s+\d+\s*=\s*\d+|\b(?:drop|alter)\s+table\b|;\s*(?:select|insert|delete|update)\b/iu.test(request),
    repeated_script_injection:
      /스크립트\s*(?:삽입|표식|태그|주입)|script\s*(?:tag|injection)|xss\s*(?:payload|attempt)/iu.test(summary)
      || /<\s*script\b|onerror\s*=|onload\s*=|javascript\s*:|<\s*svg\b.{0,60}\bonload\s*=/iu.test(request),
    repeated_path_traversal:
      /경로.{0,24}(?:거슬러|이탈|벗어|상위\s*디렉터리)|디렉터리.{0,24}(?:거슬러|이탈|탈출)|(?:path|directory)\s*traversal/iu.test(summary)
      || /(?:\.\.[\\/]){1,}/u.test(request),
    repeated_command_delimiter:
      /명령\s*구분자|명령\s*(?:삽입|주입)|command\s*(?:injection|separator)/iu.test(summary)
      || /;\s*(?:id|whoami|uname|curl|wget|sh|select|drop)\b|\$\([^)]{1,80}\)/iu.test(request),
  };
}

function clearlyNotExploit(summary) {
  return /(?:수업명|수업\s*단어|수업\s*공지|수업\s*제목|공격\s*표기(?:는|가)\s*없|삽입\s*표식은\s*아닙니다|반복(?:은|이)?\s*없|정상\s*조회|정상적인?\s*요청|ordinary\s*search|not\s+(?:an?\s+)?(?:attack|injection))/iu.test(summary);
}

function normalWebActivity(row) {
  // Completed classroom reads/navigation are affirmative normal evidence.
  // A generic absence of a match, a quoted assertion, or an unread suffix is
  // not. Reuse the actual decoded request signals instead of parsing twice.
  return row.descriptionComplete && row.requestComplete
    && /^(?:자료\s*목록을\s*조회했습니다|검색어\s+[a-z0-9._-]{1,64}\s+(?:로|으로)\s*조회했습니다|정적\s*화면이\s*열렸습니다|내\s*메모\s*한\s*건을\s*조회했습니다|반\s*공지를\s*조회했습니다|화면을\s*새로고침했습니다|파일\s*이름\s+[a-z0-9._-]{1,128}\s+(?:을|를)\s*조회했습니다|로그아웃\s*화면이\s*열렸습니다)\.?$/iu.test(row.description.trim())
    && !Object.values(signalMatches(row)).some(Boolean);
}

// The single judge-facing export. No asynchronous response or side effects.
export function decide(alert) {
  const row = readRow(alert);
  if (row === null) {
    return { action: 'record', confidence: 0.1, reason: 'no_t1190_pattern' };
  }
  const corroborated = row.tagged || (row.level !== null && row.level >= 9);
  const repeated = /(?:반복|연속|같은\s*주소|한\s*주소|repeated|consecutive|same\s+(?:ip|source|address))/iu.test(row.description)
    || integerEvidence(row.description, '번').some(({ value }) => value >= 2);
  if (row.at && row.source && corroborated && row.repetitions >= 8
    && repeated && !clearlyNotExploit(row.description)) {
    const signals = signalMatches(row);
    for (const pattern of PATTERNS) {
      if (pattern.condition.source === 'same_ip'
        && row.repetitions >= pattern.condition.minCount && signals[pattern.name]) {
        return { action: 'block', confidence: pattern.confidence, reason: pattern.name };
      }
    }
  }
  const review = PATTERNS[PATTERNS.length - 1];
  if (row.at && row.source && (
    row.tagged || (row.level !== null && row.level >= 5 && (
      /(?:sql|스크립트|script|주입|삽입|이상한|경로|구분\s*문자|따옴표|select|traversal|injection)/iu.test(row.description)
      || Object.values(signalMatches(row)).some(Boolean)
    ))
  )) {
    return { action: 'alert', confidence: review.confidence, reason: review.name };
  }
  if (row.at && row.source && row.level !== null && normalWebActivity(row)) {
    return { action: 'record', confidence: 0.1, reason: 'normal_web_activity' };
  }
  return { action: 'record', confidence: 0.1, reason: 'no_t1190_pattern' };
}
