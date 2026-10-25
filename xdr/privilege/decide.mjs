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

function validAddress(value) {
  if (typeof value !== 'string' || value.length > 45) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) {
    return value.split('.').every(part => Number(part) <= 255);
  }
  if (!/^[a-f0-9:.]+$/iu.test(value) || !value.includes(':')) return false;
  const pieces = value.split('::');
  if (pieces.length > 2) return false;
  const groups = pieces.flatMap(piece => piece ? piece.split(':') : []);
  if (groups.some(s => !/^[a-f0-9]{1,4}$/iu.test(s))) return false;
  return pieces.length === 2 ? groups.length < 8 : groups.length === 8;
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
  const accountNumber = text.match(/계정\s*(\d+)\s*개/u);
  const number = event.count || (accountNumber ? Number(accountNumber[1]) : 0);
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
      && /[12]\s*분\s*뒤|곧바로|즉시/iu.test(text),
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
