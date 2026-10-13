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

function validIp(value) {
  if (typeof value !== 'string' || value.length > 45) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) {
    return value.split('.').every(part => part.length > 0 && Number(part) <= 255);
  }
  if (!/^[0-9a-f:.]+$/iu.test(value) || !value.includes(':')) return false;
  const pieces = value.split('::');
  if (pieces.length > 2) return false;
  const groups = pieces.flatMap(s => s ? s.split(':') : []);
  if (groups.some(s => !/^[0-9a-f]{1,4}$/iu.test(s))) return false;
  return pieces.length === 2 ? groups.length < 8 : groups.length === 8;
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
      && (row.count >= 3 || /[3-9]\s*(?:번|회|건)/u.test(text)),
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
