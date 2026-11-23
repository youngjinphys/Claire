// Isolated judge entry point. No file, package, network or environment access.
// All pattern thresholds are embedded: the judge receives only this module.
const PATTERNS = Object.freeze([
  { name: 'rapid_source_login_failures', condition: { minFailures: 20, maxMinutes: 10, minRuleLevel: 10 }, confidence: 0.96 },
  { name: 'cross_account_password_spray', condition: { minRuleLevel: 10 }, confidence: 0.97 },
  { name: 'regular_multi_account_failures', condition: { minAccounts: 15, minRuleLevel: 10 }, confidence: 0.91 },
  { name: 'iterative_password_guessing', condition: { minFailures: 30, minRuleLevel: 10 }, confidence: 0.90 },
  { name: 'sustained_failed_login_streak', condition: { minFailures: 50, minRuleLevel: 11 }, confidence: 0.88 },

  { name: 'review_login_failures', condition: { minFailures: 2, minRuleLevel: 5 }, confidence: 0.65 },
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

function readRow(alert) {
  if (!alert || typeof alert !== 'object' || Array.isArray(alert)) return null;
  const data = alert.data && typeof alert.data === 'object' ? alert.data : {};
  const at = alert.timestamp ?? alert.at;
  const sourceAddress = data.srcip ?? alert.sourceAddress;
  const account = data.srcuser ?? alert.account;
  const level = alert.rule?.level ?? alert.ruleLevel;
  const description = alert.rule?.description ?? alert.description;
  return {
    at: typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null,
    sourceAddress: validAddress(sourceAddress) ? sourceAddress : null,
    account: typeof account === 'string'
      && /^[a-z][a-z0-9._-]{0,47}$/iu.test(account)
      && !/^(?:password|token|secret|apikey)/iu.test(account) ? account : null,
    ruleLevel: Number.isInteger(level) && level >= 0 && level <= 16 ? level : null,
    // The description is inspected only. It is never returned or logged.
    description: typeof description === 'string' ? description.slice(0, 1024) : '',
  };
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

function failureCount(alert, description) {
  const raw = alert?.data && typeof alert.data === 'object' ? alert.data : {};
  const candidates = [
    raw.count, raw.failures, raw.failure_count, raw.failCount,
    raw.attempts, raw.login_failures, alert?.failedAttempts,
  ].filter((value) => (typeof value === 'string' || typeof value === 'number')
    && /^\d{1,5}$/u.test(String(value))).map(Number);
  if (candidates.length) return Math.max(...candidates);
  const extracted = [
    ...integerEvidence(description, String.raw`(?:건|번|회)`, String.raw`(?:로그인|인증|비밀번호)?\s*실패(?:가|를|는|이)?\s*`, 5),
    ...integerEvidence(description, String.raw`(?:건|번|회)\s*(?:로그인|인증)?\s*실패`, '', 5),
    ...integerEvidence(description, String.raw`(?:failed|unsuccessful)\s*(?:login|sign[- ]?in|authentication|attempt)`, '', 5),
  ].map(({ value }) => value);
  return extracted.length ? Math.max(...extracted) : 0;
}

function hasT1110(alert) {
  const raw = alert?.rule?.mitre ?? alert?.mitre;
  const labels = Array.isArray(raw) ? raw
    : Array.isArray(raw?.id) ? raw.id
      : typeof raw?.id === 'string' ? [raw.id] : [];
  return labels.some((id) => typeof id === 'string'
    && (id === 'T1110' || /^T1110\.\d{3}$/u.test(id)));
}

function hasFailedAuthentication(text) {
  return /실패|같은 비밀번호.*(?:넣었|시도)|비밀번호.*(?:바꿔|추측)|failed\s*(?:login|sign[- ]?in|authentication|password|attempts?)|(?:login|authentication)\s*fail|password\s*(?:guess|spray)/iu.test(text);
}

function hasSuccessAfterFailures(text) {
  const withoutNegation = text.replace(
    /성공(?:은|이)?\s*없(?:습니다|었(?:습니다)?|다)?|성공\s*없음|no\s+success(?:ful(?:\s+logins?)?)?|zero\s+successful\s+logins?/giu,
    '',
  );
  return /(?:뒤에|후에|이후)\s*성공|성공했|성공했습니다|로그인이\s*성공|변경이\s*성공|(?:login|sign[\s-]?in)\s*success|successfully\s+logged/iu.test(withoutNegation);
}

function timeWindowMinutes(text) {
  return integerEvidence(text, String.raw`(초|분|시간|seconds?|secs?|minutes?|mins?|hours?)(?![A-Za-z0-9_])`)
    .map(({ value, unit }) => /초|sec/iu.test(unit) ? value / 60
      : /시간|hour/iu.test(unit) ? value * 60 : value);
}

function strongPattern(alert, row) {
  if (!row?.at || !row.sourceAddress || !row.account || row.ruleLevel === null
    || !hasFailedAuthentication(row.description) || hasSuccessAfterFailures(row.description)) return null;
  const text = row.description;
  const count = failureCount(alert, text);
  const tagged = hasT1110(alert);
  const shortWindow = timeWindowMinutes(text).some((value) => value > 0 && value <= 10);
  const sameSource = /(?:같은|동일(?:한)?)\s*(?:주소|IP)|한\s*주소|same\s*(?:IP|source|address)|from\s+(?:one|the\s+same)\s*(?:IP|source|address)/iu.test(text);
  const sameAccount = /(?:같은|동일(?:한)?)\s*(?:계정|사용자)|한\s*계정|same\s*(?:account|user)/iu.test(text);
  const accounts = [
    ...integerEvidence(text, '개', String.raw`계정\s*`),
    ...integerEvidence(text, String.raw`(?:accounts?|users?)(?![A-Za-z0-9_])`),
  ].sort((a, b) => a.index - b.index);
  const spray = /같은\s*비밀번호|동일한?\s*비밀번호|same\s+password|identical\s+password|password\s*spray/iu.test(text)
    && (/여러\s*계정|서로\s*다른\s*계정|(?:multiple|different)\s+(?:accounts?|users?)/iu.test(text)
      || accounts.some(({ value }) => value >= 2));
  const regular = /같은\s*간격|일정한\s*간격|regular\s+intervals?/iu.test(text)
    && accounts.length > 0;
  const accountCount = accounts[0]?.value ?? 0;
  const iterative = /비밀번호.{0,35}(?:한\s*글자씩|바꿔|변형|추측)|password.{0,35}(?:guess|variation|changed)/iu.test(text);
  const streak = /연속|이어졌|연달아|쌓였|consecutive|repeated|in\s+a\s+row/iu.test(text);
  const noSuccess = /성공(?:은|이)?\s*없|성공\s*없음|no\s+success|zero\s+successful/iu.test(text);

  for (const pattern of PATTERNS) {
    const p = pattern.condition;
    let matched = false;
    switch (pattern.name) {
      case 'rapid_source_login_failures':
        matched = count >= p.minFailures && shortWindow
          && (sameSource || sameAccount || tagged || row.ruleLevel >= p.minRuleLevel);
        break;
      case 'cross_account_password_spray':
        matched = spray && (tagged || row.ruleLevel >= p.minRuleLevel);
        break;
      case 'regular_multi_account_failures':
        matched = regular && accountCount >= p.minAccounts
          && sameSource && (tagged || row.ruleLevel >= p.minRuleLevel);
        break;
      case 'iterative_password_guessing':
        matched = count >= p.minFailures && iterative && (tagged || row.ruleLevel >= p.minRuleLevel);
        break;
      case 'sustained_failed_login_streak':
        matched = count >= p.minFailures && (streak || noSuccess)
          && (tagged || row.ruleLevel >= p.minRuleLevel);
        break;

      default:
        break;
    }
    if (matched) return pattern;
  }
  return null;
}

// The only judge-facing export. It is synchronous and side-effect-free.
export function decide(alert) {
  const row = readRow(alert);
  if (row === null) {
    return { action: 'record', confidence: 0.1, reason: 'no_matching_t1110_pattern' };
  }
  const strong = strongPattern(alert, row);
  if (strong !== null) {
    return { action: 'block', confidence: strong.confidence, reason: strong.name };
  }
  const review = PATTERNS[PATTERNS.length - 1];
  // Missing IP/account/timestamp prevents automatic blocking, but a genuine
  // failed-login signal must still be surfaced for human review.
  if ((hasT1110(alert) || (row.ruleLevel !== null && row.ruleLevel >= review.condition.minRuleLevel))
    && hasFailedAuthentication(row.description)) {
    // No external AI response is available inside the judge. Fail open to
    // human alerting, never to automated address denial.
    return { action: 'alert', confidence: review.confidence, reason: review.name };
  }
  return { action: 'record', confidence: 0.1, reason: 'no_matching_t1110_pattern' };
}
