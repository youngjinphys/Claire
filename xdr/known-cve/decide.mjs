// Isolated judge entry. No imports, file operations, network, packages or environment access.
// Copy of the detection patterns in patterns.json: names, conditions and confidence.
const PATTERNS = Object.freeze([
  {
    "name": "jndi_header_and_parameter",
    "condition": {
      "signal": "complete_remote_jndi_lookup",
      "locations": [
        "http_header",
        "query_parameter"
      ],
      "corroboration": "T1190 or Wazuh level >= 10"
    },
    "confidence": 0.99,
    "evidence": "CVE-2021-44228 (NVD), MITRE T1190: 조작된 HTTP 입력의 JNDI 원격 조회 구문은 공개 애플리케이션 악용 시도 신호입니다."
  },
  {
    "name": "repeated_remote_jndi_lookup",
    "condition": {
      "signal": "complete_remote_jndi_lookup",
      "minOccurrences": 4,
      "corroboration": "T1190 or Wazuh level >= 10"
    },
    "confidence": 0.98,
    "evidence": "CVE-2021-44228 (NVD), MITRE T1190: 동일 원격 조회 악용 입력의 반복은 공격 탐지 신뢰를 높이는 정황입니다."
  },
  {
    "name": "jndi_http_header_lookup",
    "condition": {
      "signal": "complete_remote_jndi_lookup",
      "location": "http_header",
      "corroboration": "T1190 or Wazuh level >= 10"
    },
    "confidence": 0.96,
    "evidence": "CVE-2021-44228 (NVD), MITRE T1190: 로그에 기록되는 머리글에 JNDI 원격 조회 입력을 넣을 수 있습니다."
  },
  {
    "name": "jndi_query_parameter_lookup",
    "condition": {
      "signal": "complete_remote_jndi_lookup",
      "location": "query_parameter",
      "corroboration": "T1190 or Wazuh level >= 10"
    },
    "confidence": 0.96,
    "evidence": "CVE-2021-44228 (NVD), MITRE T1190: URL 인자처럼 로깅되는 입력의 원격 조회 구문은 악용 시도 징후입니다."
  },
  {
    "name": "possible_vulnerability_scan",
    "condition": {
      "signal": "scan_tool_or_vulnerability_probe_without_complete_lookup",
      "corroboration": "T1190 tag or vulnerability-related description"
    },
    "confidence": 0.67,
    "evidence": "MITRE T1190: 취약점 탐색·점검 흔적은 추가 확인 대상이지만 실제 악용 구문 부재 시 차단 근거로 불충분합니다."
  },
  {
    "name": "cve_or_jndi_reference",
    "condition": {
      "signal": "cve_name_jndi_keyword_or_lookup_fragment_only",
      "corroboration": "T1190 tag or Wazuh level >= 5"
    },
    "confidence": 0.6,
    "evidence": "NVD CVE-2021-44228, MITRE T1190: CVE·JNDI 단어만으로는 원격 조회 악용이 성립했다고 볼 수 없습니다."
  }
]);

function validIp(value) {
  if (typeof value !== 'string' || value.length > 45) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) {
    return value.split('.').every(part => part.length > 0 && Number(part) <= 255);
  }
  if (!/^[a-f0-9:.]+$/iu.test(value) || !value.includes(':')) return false;
  const segments = value.split('::');
  if (segments.length > 2) return false;
  const groups = segments.flatMap(part => part ? part.split(':') : []);
  if (groups.some(group => !/^[a-f0-9]{1,4}$/iu.test(group))) return false;
  return segments.length === 2 ? groups.length < 8 : groups.length === 8;
}

function decodeSafely(value) {
  if (typeof value !== 'string') return '';
  let text = value.slice(0, 2048);
  // Decode URL escaping only; never evaluate JNDI or substitute variables.
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded.slice(0, 2048);
    } catch { break; }
  }
  return text;
}

function requestValues(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { header: '', parameter: '' };
  }
  const headerParts = [data.useragent, data.userAgent, data.referer, data.referrer]
    .filter(value => typeof value === 'string').slice(0, 8);
  if (data.headers && typeof data.headers === 'object' && !Array.isArray(data.headers)) {
    for (const value of Object.values(data.headers).slice(0, 16)) {
      if (typeof value === 'string') headerParts.push(value);
    }
  }
  const paramParts = [data.url, data.query, data.queryString]
    .filter(value => typeof value === 'string').slice(0, 8);
  return {
    header: decodeSafely(headerParts.join(' ')),
    parameter: decodeSafely(paramParts.join(' ')),
  };
}

function readAlert(alert) {
  if (!alert || typeof alert !== 'object' || Array.isArray(alert)) return null;
  const data = alert.data && typeof alert.data === 'object' && !Array.isArray(alert.data) ? alert.data : {};
  const rule = alert.rule && typeof alert.rule === 'object' ? alert.rule : {};
  const when = alert.timestamp ?? alert.at;
  const source = data.srcip ?? alert.sourceAddress;
  const level = rule.level ?? alert.ruleLevel;
  const description = rule.description ?? alert.description;
  const rawMitre = rule.mitre ?? alert.mitre ?? [];
  const ids = Array.isArray(rawMitre) ? rawMitre
    : Array.isArray(rawMitre?.id) ? rawMitre.id
      : typeof rawMitre?.id === 'string' ? [rawMitre.id] : [];
  const rawCount = data.count ?? alert.count;
  const repetitions = (typeof rawCount === 'number' || typeof rawCount === 'string')
    && /^\d{1,5}$/u.test(String(rawCount)) ? Number(rawCount) : 0;
  return {
    at: typeof when === 'string' && Number.isFinite(Date.parse(when)) ? when : null,
    source: validIp(source) ? source : null,
    level: Number.isInteger(level) && level >= 0 && level <= 16 ? level : null,
    tagged: ids.includes('T1190'),
    description: typeof description === 'string' ? description.slice(0, 1024) : '',
    requests: requestValues(data),
    repetitions,
  };
}

// Match only complete lookup syntax inside raw HTTP parameters or headers.
// A description that quotes the same text is NOT proof of an attack.
const JNDI_REMOTE = /\$\{\s*jndi\s*:\s*(?:ldap|ldaps|rmi|dns|iiop|nis|corba)\s*:\/\/[^\s}]{1,512}\s*\}/iu;
const NO_EXPLOIT = Object.freeze({ action: 'record', confidence: 0.1, reason: 'no_t1190_signal' });

export function decide(alert) {
  const row = readAlert(alert);
  if (!row) return { ...NO_EXPLOIT };

  const inHeader = JNDI_REMOTE.test(row.requests.header);
  const inParameter = JNDI_REMOTE.test(row.requests.parameter);
  const corroborated = row.tagged || (row.level !== null && row.level >= 10);
  const strong = Boolean(row.at && row.source && corroborated && (inHeader || inParameter));

  if (strong) {
    if (inHeader && inParameter) {
      return { action: 'block', confidence: PATTERNS[0].confidence, reason: PATTERNS[0].name };
    }
    if (row.repetitions >= PATTERNS[1].condition.minOccurrences) {
      return { action: 'block', confidence: PATTERNS[1].confidence, reason: PATTERNS[1].name };
    }
    const pattern = inHeader ? PATTERNS[2] : PATTERNS[3];
    return { action: 'block', confidence: pattern.confidence, reason: pattern.name };
  }

  // Incomplete evidence must not be promoted into a deny, even with a high rule level.
  const detail = row.description;
  const hint = /CVE[-\s]?2021[-\s]?44228|jndi|원격\s*조회|취약점|점검\s*도구|조회\s*형태|라이브러리|중괄호|lookup|log4j|log4shell/iu.test(detail);
  const rawHint = /\bjndi\b|CVE[-\s]?2021[-\s]?44228|\$\{\s*jndi\b/iu.test(row.requests.header + ' ' + row.requests.parameter);
  const scan = /점검|스캔|scan|probe|취약점.*(?:흔적|점검)/iu.test(detail);
  if ((inHeader || inParameter || rawHint || hint)
      && (row.tagged || row.level !== null && row.level >= 5)) {
    const pattern = scan ? PATTERNS[4] : PATTERNS[5];
    return { action: 'alert', confidence: pattern.confidence, reason: pattern.name };
  }
  return { ...NO_EXPLOIT };
}
