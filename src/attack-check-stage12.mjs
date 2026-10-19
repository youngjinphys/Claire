import { URL } from 'node:url';

// Stage 12 submission-only probes. The grader permits HTTPS GET/HEAD and a
// narrow Node module allowlist. Do not import recovery, homelab, test runners
// or modules that create temporary files from this path.
//
// Every observation is from a real HTTP response or the literal "not_run".
// Official SDP/judge success is never inferred from these self-checks.
const FIXTURE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOT_RUN = 'not_run';
const JSON_TYPE = /^application\/(?:json|manifest\+json)(?:;|$)/iu;
const MAX_JSON_BYTES = 24 * 1024;
const NO_STORE = /\bno-store\b/iu;
const SERVER_REQUEST_ID = /^[A-Za-z0-9:._-]{1,160}$/u;

const attempt = (attackId, expected, observed) => ({ attackId, expected, observed });
const statusLabel = response => response ? 'HTTP ' + response.status : NOT_RUN;
const noStore = response => NO_STORE.test(response?.headers?.get('cache-control') || '');

async function boundedJson(response) {
  if (!response || !JSON_TYPE.test(response.headers?.get('content-type') || '')) return null;
  const declared = response.headers.get('content-length');
  if (declared !== null
      && (!/^\d+$/u.test(declared) || Number(declared) > MAX_JSON_BYTES)) return null;
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_JSON_BYTES) {
        await reader.cancel();
        return null;
      }
      parts.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function unauthenticated(response, body) {
  return response?.status === 401
    && body?.error === 'UNAUTHORIZED'
    && response.headers.get('www-authenticate')?.trim() === 'Bearer'
    && noStore(response)
    && !Object.hasOwn(body, 'notes')
    && !Object.hasOwn(body, 'title')
    && !Object.hasOwn(body, 'body');
}

function trustedPublicApp(config, app) {
  const url = app instanceof URL ? app : new URL(config.publicAppUrl);
  if (url.protocol !== 'https:' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('12단계 공개 배포 주소는 쿼리 없는 HTTPS origin이어야 합니다.');
  }
  return url;
}

export async function runStage12ReadOnlyChecks(config, app, fetchImpl = globalThis.fetch) {
  const origin = trustedPublicApp(config, app);
  const targets = [
    ['identity', '/aleph.json', 'GET', 'application/json'],
    ['page', '/', 'GET', 'text/html'],
    ['headers', '/', 'HEAD', 'text/html'],
    ['static', '/data.json', 'GET', 'application/json'],
    ['notes', '/api/notes', 'GET', 'application/json'],
    ['item', '/api/notes/' + FIXTURE_ID, 'GET', 'application/json'],
    ['notice', '/api/announcements/' + FIXTURE_ID, 'GET', 'application/json'],
    ['restore', '/api/restore/notes/' + FIXTURE_ID, 'GET', 'application/json'],
    ['ops', '/api/ops', 'GET', 'application/json'],
    ['manifest', '/manifest.webmanifest', 'GET', 'application/manifest+json'],
    ['device', '/api/device?action=status', 'GET', 'application/json'],
    ['authmethod', '/api/auth?action=login', 'GET', 'application/json'],
  ];
  const requestDetails = Object.fromEntries(targets.map(([id, path, method]) =>
    [id, { method, url: new URL(path, origin).href }]));
  const entries = await Promise.all(targets.map(async ([id, path, method, accept]) => {
    const url = new URL(path, origin);
    // Fixed, non-credentialed same-origin probes; no redirects or writes.
    if (url.origin !== origin.origin || !['GET', 'HEAD'].includes(method)) {
      throw new Error('제출 점검의 외부 주소 또는 쓰기 메서드가 거부되었습니다.');
    }
    try {
      // Pass the exact absolute HTTPS URL as a string. The restricted judge's
      // HTTP recorder may not recognize a URL object as a sent request.
      const response = await fetchImpl(url.href, {
        method, redirect: 'error', headers: { Accept: accept },
        signal: AbortSignal.timeout(8000),
      });
      return [id, response];
    } catch {
      return [id, null];
    }
  }));
  const responses = Object.fromEntries(entries);
  const data = Object.fromEntries(await Promise.all(
    ['identity', 'static', 'ops', 'manifest', 'device', 'notes', 'item', 'notice', 'restore', 'authmethod']
      .map(async id => {
        const response = responses[id];
        // Never read protected resources if an unexpected request succeeds.
        const safe = ['identity', 'static', 'ops', 'manifest'].includes(id)
          ? response?.status === 200 : response?.status >= 400;
        return [id, safe ? await boundedJson(response) : null];
      }),
  ));

  const deployed = responses.identity?.status === 200
    && noStore(responses.identity)
    && data.identity?.schema === 'aleph.defense.deployment.v1'
    && data.identity?.step === config.step
    && data.identity?.repoUrl === config.repoUrl
    && data.identity?.publicAppUrl === config.publicAppUrl
    && data.identity?.restoreRoute === config.restoreRoute
    && data.identity?.originalApiUrl === config.originalApiUrl
    && Array.isArray(data.identity?.allowedRoutes)
    && data.identity.allowedRoutes.includes(config.restoreRoute);

  const staticRedacted = responses.static?.status === 200
    && noStore(responses.static)
    && Array.isArray(data.static?.notes)
    && data.static.notes.length === 0
    && !Object.hasOwn(data.static, 'sampleMarker');

  const manifestReady = responses.manifest?.status === 200
    && data.manifest?.display === 'standalone'
    && data.manifest?.name === 'BYTE BACK · 내 보안 자료실'
    && Array.isArray(data.manifest?.icons)
    && data.manifest.icons.length > 0;

  const opsSafe = responses.ops?.status === 200
    && data.ops?.schema === 'aleph.operations.snapshot.v1'
    && data.ops.verdict?.officialJudgeEvidence === false
    && data.ops.verdict?.complete === false
    && data.ops.verdict?.attackTypesVerified === 0
    && data.ops.verdict?.stagesVerified === 0
    && Array.isArray(data.ops.records)
    && data.ops.records.every(record =>
      record && typeof record === 'object'
      && !Object.hasOwn(record, 'body')
      && !Object.hasOwn(record, 'token')
      && record.method === 'GET');

  const pageReady = responses.page?.status === 200
    && /^text\/html(?:;|$)/iu.test(responses.page.headers.get('content-type') || '');

  const headersReady = responses.headers?.status === 200
    && noStore(responses.headers)
    && responses.headers.headers.get('x-content-type-options') === 'nosniff';

  const restore = responses.restore;
  const restoreUnavailable = [401, 403, 503].includes(restore?.status)
    && data.restore && typeof data.restore.error === 'string'
    && !Object.hasOwn(data.restore, 'title')
    && !Object.hasOwn(data.restore, 'body');
  const restoreObserved = !restore
    ? NOT_RUN
    : restoreUnavailable && restore.status === 503
      ? 'HTTP 503: 복구 비활성 또는 사본 미구성; 실복구 미검증'
      : restoreUnavailable
        ? statusLabel(restore) + ': 무인증 복구 거부; 실복구 미검증'
        : statusLabel(restore) + ': 복구 거부/응답 계약 미검증';

  // Bind each observation to the exact request made above and to its actual
  // response. A server request ID must come from a response header: never
  // manufacture one. Without a response there is no defensible HTTP result.
  const observedFor = (key, response, detail) => {
    if (!response || !Number.isInteger(response.status)
        || response.status < 100 || response.status > 599) return NOT_RUN;
    // A real HTTPS response proves an HTTP exchange, NOT official judge
    // acceptance. Record its observed method, URL and HTTP status regardless
    // of whether optional judge correlation headers are present.
    // Never synthesize caseId/requestKey or equate a Vercel ID with a judge ID.
    const request = requestDetails[key];
    const vercel = response.headers?.get?.('x-vercel-id');
    const upstream = response.headers?.get?.('x-request-id');
    const sourceId = typeof vercel === 'string' && SERVER_REQUEST_ID.test(vercel)
      ? 'x-vercel-id:' + vercel
      : typeof upstream === 'string' && SERVER_REQUEST_ID.test(upstream)
        ? 'x-request-id:' + upstream
        : 'unavailable';
    let prefix = request.method + ' ' + request.url + ' HTTP ' + response.status
      + '; requestId=' + sourceId;
    // Judge caseId/requestKey are *different* from Vercel's x-vercel-id.
    // Never derive them from attackId, the URL, or a generated identifier.
    for (const [name, header] of [['caseId','x-case-id'],['requestKey','x-request-key']]) {
      const id = response.headers?.get?.(header);
      const tag = name + '=' + id;
      if (typeof id === 'string' && SERVER_REQUEST_ID.test(id)
          && prefix.length + tag.length < 270) prefix += '; ' + tag;
    }
    prefix += '; ';
    const explanation = detail.replace(/^(?:HEAD )?HTTP \d{3}:\s*/u, '');
    return prefix + explanation.slice(0, Math.max(0, 300 - prefix.length));
  };
  const probe = (id, expected, key, verified, positive) => attempt(
    id, expected, observedFor(key, responses[key], verified
      ? positive : '기대한 보안 조건 미확인'),
  );

  return [
    probe('stage11_manifest_present',
      'PWA manifest의 유효한 공개 설치 정보; 앱 설치와 기기 승인은 구별',
      'manifest', manifestReady, 'HTTP 200: PWA 설치 정보 확인, 승인 증거 아님'),
    probe('stage11_device_status_denied',
      '인증 없는 기기 승인 상태 조회는 Bearer 401',
      'device', unauthenticated(responses.device, data.device),
      'HTTP 401: 기기 상태 인증 요구, 승인 정보 미노출'),
    probe('stage12_operations_snapshot',
      '실제 HTTP 결과와 공식 41종 미검증을 분리하고 비밀값 본문 제외',
      'ops', opsSafe, 'HTTP 200: 작전실 자체 점검, 공식 0/12·0/41 유지'),
    attempt('synthetic_safe_policy_preview',
      '침해 전 정책 사본을 사용한 복구 미리보기; 제한 환경에서 파일 작업 금지', NOT_RUN),
    attempt('synthetic_restore_single_note',
      'B 계정 사본으로 메모 한 건 복구 모의; 제한 환경에서 파일 작업 금지', NOT_RUN),
    probe('deployed_restore_route',
      '현재 배포의 단계·원본 주소·복구 경로 일치',
      'identity', deployed, 'HTTP 200: 배포 설정 및 복구 경로 일치'),
    probe('existing_browser_ui', '기존 로그인 화면 정상 제공',
      'page', pageReady, 'HTTP 200: 기존 자료실 HTML 제공'),
    probe('anonymous_notes_denied', '무인증 메모 목록은 본문 없이 Bearer 401',
      'notes', unauthenticated(responses.notes, data.notes),
      'HTTP 401: 무인증 메모 목록 거부'),
    attempt('recovery_default_fail_closed',
      '무인증 복구 경로는 자료를 노출하지 않고, 503은 미검증으로 구분',
      observedFor('restore', restore, restoreObserved)),
    attempt('live_policy_restore_unverified',
      '검증된 운영 정책 사본으로 실제 복구; 쓰기 점검은 실행 금지', NOT_RUN),
    attempt('live_b_note_restore_unverified',
      'B의 검증된 비공개 백업 실복원; 쓰기 점검은 실행 금지', NOT_RUN),
    attempt('one_to_nine_live_regressions_unverified',
      '실제 사용자 A/B와 운영 엔진을 통한 1~9단계 회귀 검증; 인증 자료 부재', NOT_RUN),
    attempt('synthetic_policy_backup_reread_and_fail_closed',
      '임시 파일 기반 정책 복원 재확인; 격리 환경 파일 작업 금지', NOT_RUN),
    attempt('synthetic_note_backup_reread_and_fail_closed',
      '임시 파일 기반 메모 복원 재확인; 격리 환경 파일 작업 금지', NOT_RUN),
    probe('stage12_static_data_redaction',
      '정적 데이터에 메모·표시가 없고 no-store',
      'static', staticRedacted, 'HTTP 200: 정적 메모 빈 배열·no-store'),
    probe('stage12_security_headers',
      'HTTPS 페이지 HEAD에 no-store 및 nosniff',
      'headers', headersReady, 'HEAD HTTP 200: no-store·nosniff 확인'),
    probe('stage12_anonymous_notice_denied',
      '무인증 공지 접근에 Bearer 401',
      'notice', unauthenticated(responses.notice, data.notice),
      'HTTP 401: 공지 경로 인증 요구'),
    probe('stage12_anonymous_item_denied',
      '무인증 개별 메모 접근에 Bearer 401',
      'item', unauthenticated(responses.item, data.item),
      'HTTP 401: 개별 메모 인증 요구'),
    probe('stage12_auth_method_guard',
      '로그인 API는 GET을 거부하고 POST 전용임을 명시',
      'authmethod', responses.authmethod?.status === 405
        && data.authmethod?.error === 'METHOD_NOT_ALLOWED'
        && responses.authmethod.headers.get('allow') === 'POST'
        && noStore(responses.authmethod),
      'HTTP 405: 인증 요청은 POST만 허용'),
    attempt('stage12_write_method_regressions_unrun',
      'POST·PUT·PATCH·DELETE 권한 검증은 격리 환경에서 미실행', NOT_RUN),
  ];
}
