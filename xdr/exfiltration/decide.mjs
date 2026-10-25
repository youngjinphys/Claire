// Self-contained isolated judge: no imports, packages, filesystem or network.
// PATTERNS is the exact copy of xdr/exfiltration/patterns.json.
const PATTERNS = Object.freeze([
  {
    "name": "rapid_bulk_to_new_destination",
    "condition": {
      "descriptionSignals": [
        "short_window",
        "many_documents",
        "first_seen_destination"
      ],
      "minFiles": 100,
      "minBytes": 50000000
    },
    "confidence": 0.98,
    "evidence": "MITRE T1048: 짧은 시간의 대량 자료 전송과 신규 목적지의 결합은 대체 통로 유출을 검토할 강한 이상 신호입니다."
  },
  {
    "name": "offhours_archive_new_destination",
    "condition": {
      "descriptionSignals": [
        "offhours",
        "archive",
        "first_seen_destination"
      ],
      "minBytes": 50000000
    },
    "confidence": 0.96,
    "evidence": "MITRE T1048: 업무 외 시간에 압축 자료가 미관측 목적지로 대량 반출되면 유출 의심이 강해집니다."
  },
  {
    "name": "repeated_large_same_destination",
    "condition": {
      "descriptionSignals": [
        "same_destination",
        "large_transfer",
        "repeated"
      ],
      "minTransfers": 5,
      "minBytes": 50000000
    },
    "confidence": 0.95,
    "evidence": "MITRE T1041·T1048: 하나의 외부 목적지로 대량 자료를 반복 전송하면 전송 채널과 데이터를 함께 조사해야 합니다."
  },
  {
    "name": "unusual_port_sequential_documents",
    "condition": {
      "descriptionSignals": [
        "unusual_port",
        "sequential_document_metadata"
      ],
      "minBytes": 50000000
    },
    "confidence": 0.94,
    "evidence": "MITRE T1048: 비표준 포트와 연속된 자료 송신이 결합되면 대체 전송 채널을 이용한 유출이 의심됩니다."
  },
  {
    "name": "bulk_notes_to_first_seen_destination",
    "condition": {
      "descriptionSignals": [
        "first_seen_destination",
        "notes_bundle"
      ],
      "minFiles": 50,
      "minBytes": 50000000
    },
    "confidence": 0.96,
    "evidence": "MITRE T1048: 대량 메모 묶음의 신규 외부 목적지 전송은 데이터 반출 검토에 충분히 강한 정황입니다."
  },
  {
    "name": "offhours_repeated_large_transfer",
    "condition": {
      "descriptionSignals": [
        "offhours",
        "same_destination",
        "repeated"
      ],
      "minTransfers": 10,
      "minBytes": 50000000
    },
    "confidence": 0.96,
    "evidence": "MITRE T1048: 업무 외 시간의 집중적·반복적 대량 전송은 비정상 외부 반출을 시사합니다."
  },
  {
    "name": "consecutive_archives_new_destination",
    "condition": {
      "descriptionSignals": [
        "archive",
        "repeated",
        "first_seen_destination"
      ],
      "minFiles": 3,
      "minBytes": 50000000
    },
    "confidence": 0.94,
    "evidence": "MITRE T1048: 여러 압축 파일의 연속 업로드와 신규 목적지가 함께 보이면 외부 유출 정황이 강화됩니다."
  },
  {
    "name": "entire_repository_external_copy",
    "condition": {
      "descriptionSignals": [
        "short_window",
        "whole_repository",
        "external_destination"
      ],
      "minFiles": 100,
      "minBytes": 50000000
    },
    "confidence": 0.99,
    "evidence": "MITRE T1041·T1048: 자료실 전체의 단기간 외부 복사는 대량 데이터 유출을 의심할 수 있는 명시적 행위입니다."
  },
  {
    "name": "repeated_c2_channel_large_upload",
    "condition": {
      "descriptionSignals": [
        "command_channel",
        "large_transfer",
        "first_seen_destination",
        "repeated"
      ],
      "minTransfers": 3,
      "minBytes": 50000000
    },
    "confidence": 0.97,
    "evidence": "MITRE T1041: 명령·제어 채널로 반복되는 대량 데이터 전송은 C2 통로 유출과 정합적인 탐지 신호입니다."
  },
  {
    "name": "same_archive_multiple_unknown_destinations",
    "condition": {
      "descriptionSignals": [
        "same_archive",
        "multiple_destinations",
        "first_seen_destination"
      ],
      "minBytes": 50000000
    },
    "confidence": 0.95,
    "evidence": "MITRE T1048: 동일 압축 파일을 복수의 신규 외부 목적지로 전송하는 정황은 비정상 반출 의심을 강화합니다."
  },
  {
    "name": "uncertain_outbound_or_staging",
    "condition": {
      "descriptionSignals": [
        "unusual_transfer_or_staging",
        "incomplete_evidence"
      ]
    },
    "confidence": 0.65,
    "evidence": "MITRE T1041·T1048: 전송량 증가·새 목적지·압축 생성 단독 징후는 유출을 입증하지 못하므로 추가 확인이 필요합니다."
  }
]);

function validIp(value) {
  if (typeof value !== 'string' || value.length > 45) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) {
    return value.split('.').every(part => part.length > 0 && Number(part) <= 255);
  }
  if (!/^[a-f0-9:.]+$/iu.test(value) || !value.includes(':')) return false;
  const halves = value.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap(part => part ? part.split(':') : []);
  if (groups.some(part => !/^[a-f0-9]{1,4}$/iu.test(part))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

function positiveNumber(value) {
  if ((typeof value !== 'string' && typeof value !== 'number')
      || !/^\d{1,15}$/u.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalize(alert) {
  if (!alert || typeof alert !== 'object' || Array.isArray(alert)) return null;
  const data = alert.data && typeof alert.data === 'object' && !Array.isArray(alert.data) ? alert.data : {};
  const rule = alert.rule && typeof alert.rule === 'object' && !Array.isArray(alert.rule) ? alert.rule : {};
  const when = alert.timestamp ?? alert.at;
  const src = data.srcip ?? alert.sourceAddress;
  const account = data.srcuser ?? alert.account;
  const dst = data.dstip ?? alert.destinationAddress;
  const desc = rule.description ?? alert.description;
  const level = rule.level ?? alert.ruleLevel;
  const mitre = rule.mitre ?? alert.mitre ?? [];
  const ids = Array.isArray(mitre) ? mitre
    : Array.isArray(mitre?.id) ? mitre.id
      : typeof mitre?.id === 'string' ? [mitre.id] : [];
  return {
    at: typeof when === 'string' && Number.isFinite(Date.parse(when)) ? when : null,
    source: validIp(src) ? src : null,
    account: typeof account === 'string' && /^[a-z][a-z0-9._-]{0,47}$/iu.test(account)
      ? account : null,
    destination: validIp(dst) ? dst : null,
    bytes: positiveNumber(data.bytes ?? alert.bytes),
    files: positiveNumber(data.files ?? alert.files),
    transfers: positiveNumber(data.count ?? alert.count),
    text: typeof desc === 'string' ? desc.slice(0, 1024) : '',
    level: Number.isInteger(level) && level >= 0 && level <= 16 ? level : null,
    tagged: ids.some(v => v === 'T1041' || v === 'T1048' || /^T1048\.\d{3}$/u.test(v)),
  };
}

function benign(text) {
  return /(?:내\s*메모\s*한\s*건을\s*읽|반\s*공지를\s*읽|수업\s*자료\s*주소로\s*작은\s*동기화|검색\s*결과\s*한\s*페이지|화면\s*새로고침|내\s*메모를\s*저장|첨부\s*그림\s*한\s*장을\s*열|세션\s*확인|로그아웃했습니다|다음\s*수업\s*공지를\s*읽)/iu.test(text);
}

function signals(row) {
  const text = row.text;
  const unfamiliar = /(?:처음\s*보는\s*(?:목적지|주소)|평소와\s*다른\s*주소|새로운\s*목적지)/iu.test(text);
  const offHours = /(?:수업\s*시간\s*밖|업무\s*시간\s*밖|근무\s*시간\s*밖|야간|비업무\s*시간)/iu.test(text);
  const archive = /(?:압축\s*파일|압축된\s*파일|archive|\.zip\b)/iu.test(text);
  const repeated = /(?:연속|반복|\d+\s*번)/iu.test(text);
  const manyDocuments = /(?:자료\s*\d+\s*건|자료실\s*전체|메모\s*묶음)/iu.test(text);
  return {
    rapid_bulk_to_new_destination: unfamiliar && /10\s*분\s*안|짧은\s*시간/iu.test(text)
      && /자료\s*\d+\s*건/iu.test(text)
      && row.files !== null && row.files >= PATTERNS[0].condition.minFiles,
    offhours_archive_new_destination: offHours && archive && unfamiliar && /나갔|반출|전송/iu.test(text),
    repeated_large_same_destination: /같은\s*목적지/iu.test(text)
      && /대용량\s*전송/iu.test(text) && repeated
      && row.transfers !== null && row.transfers >= PATTERNS[2].condition.minTransfers,
    unusual_port_sequential_documents: /평소에\s*쓰지\s*않던\s*포트/iu.test(text)
      && /자료\s*이름.*연속\s*전송/iu.test(text),
    bulk_notes_to_first_seen_destination: unfamiliar && /메모\s*묶음/iu.test(text)
      && /한\s*번에\s*나갔|대량\s*전송/iu.test(text)
      && row.files !== null && row.files >= PATTERNS[4].condition.minFiles,
    offhours_repeated_large_transfer: offHours && /같은\s*목적지/iu.test(text)
      && /전송.*\d+\s*번/iu.test(text) && row.transfers !== null
      && row.transfers >= PATTERNS[5].condition.minTransfers,
    consecutive_archives_new_destination: archive && unfamiliar && repeated
      && row.files !== null && row.files >= PATTERNS[6].condition.minFiles,
    entire_repository_external_copy: /짧은\s*시간/iu.test(text)
      && /자료실\s*전체/iu.test(text) && /외부\s*주소/iu.test(text)
      && /복사|전송/iu.test(text) && row.files !== null
      && row.files >= PATTERNS[7].condition.minFiles,
    repeated_c2_channel_large_upload: /명령\s*통로/iu.test(text)
      && /큰\s*파일/iu.test(text) && unfamiliar && repeated
      && row.transfers !== null && row.transfers >= PATTERNS[8].condition.minTransfers,
    same_archive_multiple_unknown_destinations: /같은\s*압축\s*파일/iu.test(text)
      && unfamiliar && /목적지\s*두\s*곳|목적지\s*\d+\s*곳/iu.test(text),
  };
}

export function decide(alert) {
  const row = normalize(alert);
  if (!row) return { action: 'record', confidence: 0.1, reason: 'no_exfiltration_signal' };
  if (benign(row.text)) return { action: 'record', confidence: 0.1, reason: 'normal_document_activity' };

  // A high Wazuh rule level or MITRE label alone is not evidence of exfiltration.
  const requiredData = row.at && row.source && row.account && row.destination;
  const substantial = row.bytes !== null && row.bytes >= 50_000_000;
  const corroborated = row.level !== null && row.level >= 10;
  if (requiredData && substantial && corroborated) {
    const evidence = signals(row);
    for (const pattern of PATTERNS) {
      if (pattern.confidence >= 0.85 && evidence[pattern.name]) {
        return { action: 'block', confidence: pattern.confidence, reason: pattern.name };
      }
    }
  }

  // Unusual destination, transfer attempt, file staging, or traffic-volume anomaly
  // remains an alert when the raw destination/size evidence is absent or weak.
  const unusual = /(?:전송|나갔|반출|외부\s*전송|복사됐|올라갔|압축\s*파일|전송량|목적지|명령\s*통로)/iu.test(row.text);
  const meaningful = row.tagged || (row.level !== null && row.level >= 5);
  if (unusual && meaningful) {
    const review = PATTERNS[PATTERNS.length - 1];
    return { action: 'alert', confidence: review.confidence, reason: review.name };
  }
  return { action: 'record', confidence: 0.1, reason: 'no_exfiltration_signal' };
}
