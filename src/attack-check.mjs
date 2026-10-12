// The student changes this check as each stage adds an attack to the same app.
// Never return tokens, private keys, real names, or note bodies.
const appUrl = (config) => {
  let app;
  try { app = new URL(config.publicAppUrl); } catch { throw new Error('aleph.config.json의 실제 배포 주소를 먼저 넣어 주세요.'); }
  if (app.protocol !== 'https:' || app.username || app.password || app.search || app.hash
      || app.pathname !== '/' || app.hostname.endsWith('.example')) {
    throw new Error('aleph.config.json의 실제 배포 주소를 먼저 넣어 주세요.');
  }
  return app;
};

const safeJson = async (response) => {
  try { return await response.json(); } catch { return null; }
};

export async function runAttackChecks(config) {
  const app = appUrl(config);

  if (config.step === 1) {
    if (typeof config.sampleMarker !== 'string' || !config.sampleMarker) {
      throw new Error('가상 자료 확인 표시를 넣어 주세요.');
    }
    const response = await fetch(new URL('/data.json', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    const data = response.ok ? await safeJson(response) : null;
    const visible = data?.sampleMarker === config.sampleMarker
      && Array.isArray(data.notes) && data.notes.length > 0;
    return [{ attackId: 'anonymous_note_read', expected: '비로그인 화면에서 가상 자료를 확인',
      observed: visible ? '비로그인 요청에서 공개 가상 자료 확인 표시가 보임'
        : `비로그인 요청에서 확인 표시가 보이지 않음 (HTTP ${response.status})` }];
  }

  if (config.step === 2) {
    const staticResponse = await fetch(new URL('/data.json', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    const staticCache = staticResponse.headers.get('cache-control') || '';
    const staticData = staticResponse.ok ? await safeJson(staticResponse) : null;
    const staticEmpty = Array.isArray(staticData?.notes) && staticData.notes.length === 0
      && !Object.hasOwn(staticData, 'sampleMarker') && /\bno-store\b/iu.test(staticCache);

    const identityResponse = await fetch(new URL('/aleph.json', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    const identityCache = identityResponse.headers.get('cache-control') || '';
    const identityData = identityResponse.ok ? await safeJson(identityResponse) : null;
    const identityClean = identityData?.step === 2
      && !Object.hasOwn(identityData, 'sampleMarker') && /\bno-store\b/iu.test(identityCache);

    const apiResponse = await fetch(new URL('/api/notes', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    const apiCache = apiResponse.headers.get('cache-control') || '';
    const apiData = apiResponse.ok ? await safeJson(apiResponse) : null;
    const apiCount = Array.isArray(apiData?.notes) ? apiData.notes.length : null;

    return [
      { attackId: 'static_note_copy_removed', expected: '정적 /data.json은 메모·1단계 표시 없이 notes=[]이고 no-store',
        observed: staticEmpty ? '정적 /data.json은 notes=[]·표시 없음·Cache-Control=no-store'
          : `정적 /data.json 검증 실패 (HTTP ${staticResponse.status}, Cache-Control=${staticCache || '없음'})` },
      { attackId: 'step1_marker_removed', expected: '2단계 /aleph.json은 1단계 표시 없이 no-store',
        observed: identityClean ? '2단계 /aleph.json은 표시 없음·Cache-Control=no-store'
          : `/aleph.json 검증 실패 (HTTP ${identityResponse.status}, Cache-Control=${identityCache || '없음'})` },
      { attackId: 'public_notes_api_remains', expected: '비로그인 /api/notes는 4건을 반환하고 no-store이며 공개 주소 약점이 남음',
        observed: apiCount === null ? `공개 API가 자료 목록을 반환하지 않음 (HTTP ${apiResponse.status})`
          : `비로그인 /api/notes가 ${apiCount}건 반환·Cache-Control=${/\bno-store\b/iu.test(apiCache) ? 'no-store' : (apiCache || '없음')}·공개 주소 유지` },
    ];
  }

  if (config.step === 3) {
    const listResponse = await fetch(new URL('/api/notes', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const listBody = await safeJson(listResponse);
    const listDenied = listResponse.status === 401
      && !Array.isArray(listBody) && !Array.isArray(listBody?.notes);

    const itemResponse = await fetch(new URL('/api/notes/00000000-0000-4000-8000-000000000000', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const itemBody = await safeJson(itemResponse);
    const itemDenied = itemResponse.status === 401
      && !itemBody?.title && !itemBody?.body;

    return [
      { attackId: 'anonymous_note_list_denied', expected: '무로그인 목록 GET은 자료 없이 401 거부',
        observed: listDenied ? '무로그인 /api/notes가 자료 없이 HTTP 401로 거부됨'
          : `무로그인 목록 거부 검증 실패 (HTTP ${listResponse.status})` },
      { attackId: 'anonymous_note_item_denied', expected: '무로그인 한 건 GET은 자료 없이 401 거부',
        observed: itemDenied ? '무로그인 /api/notes/:id가 자료 없이 HTTP 401로 거부됨'
          : `무로그인 한 건 거부 검증 실패 (HTTP ${itemResponse.status})` },
    ];
  }

  if (config.step === 4) {
    const listResponse = await fetch(new URL('/api/notes', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const listBody = await safeJson(listResponse);
    const listDenied = listResponse.status === 401
      && !Array.isArray(listBody) && !Array.isArray(listBody?.notes);

    const itemResponse = await fetch(new URL('/api/notes/00000000-0000-4000-8000-000000000000', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const itemBody = await safeJson(itemResponse);
    const itemDenied = itemResponse.status === 401
      && !itemBody?.title && !itemBody?.body;

    return [
      { attackId: 'anonymous_note_list_denied', expected: '4단계 무로그인 목록 GET은 자료 없이 401 거부',
        observed: listDenied ? '무로그인 /api/notes가 자료 없이 HTTP 401로 거부됨'
          : `무로그인 목록 거부 검증 실패 (HTTP ${listResponse.status})` },
      { attackId: 'anonymous_note_item_denied', expected: '4단계 무로그인 한 건 GET은 자료 없이 401 거부',
        observed: itemDenied ? '무로그인 /api/notes/:id가 자료 없이 HTTP 401로 거부됨'
          : `무로그인 한 건 거부 검증 실패 (HTTP ${itemResponse.status})` },
    ];
  }

  if (config.step === 7) {
    const { decide } = await import('./decider.mjs');
    const { fixtureRequests } = await import('../scripts/fixture-7.mjs');
    const { normal, suspicious } = fixtureRequests();
    const refreshed = {
      ...suspicious, stepUp: { verified: true, authAgeSeconds: 60 },
    };
    const untrusted = {
      ...suspicious,
      signals: { ...suspicious.signals, source: 'client_header' },
      headers: { 'x-forwarded-for': '127.0.0.1', 'x-region': 'local' },
    };

    const [normalDecision, riskyDecision, replayDecision, forgedDecision] =
      await Promise.all([normal, suspicious, refreshed, untrusted].map(decide));

    const manifestResponse = await fetch(new URL('/aleph.json', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const manifest = manifestResponse.ok ? await safeJson(manifestResponse) : null;
    const configMatches = manifest?.step === 7
      && manifest?.protectedService?.serviceId === config.protectedService?.serviceId
      && manifest?.protectedService?.readRoute === config.protectedService?.readRoute;
    const homeResponse = await fetch(app, {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'text/html' },
    });
    const listResponse = await fetch(new URL('/api/notes', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const listBody = await safeJson(listResponse);
    const denied = listResponse.status === 401 && !Array.isArray(listBody)
      && !Array.isArray(listBody?.notes);

    return [
      { attackId: 'synthetic_normal_allow', expected: '가상 정상 조합은 allow',
        observed: normalDecision.decision === 'allow' ? '로컬 가상 정상 요청 allow'
          : '가상 정상 요청 판정 실패' },
      { attackId: 'synthetic_anomaly_step_up', expected: '가상 시간·네트워크·행동 복합 사건은 step_up',
        observed: riskyDecision.decision === 'step_up'
          && riskyDecision.reasonCode === 'step_up_required'
          ? '로컬 가상 복합 사건 step_up_required' : '가상 복합 사건 판정 실패' },
      { attackId: 'synthetic_verified_replay', expected: '가상 확인 완료·새 요청 재판정만 allow',
        observed: replayDecision.decision === 'allow'
          ? '로컬 가상 verified(60초) 후 재판정 allow (실제 재로그인 미검증)'
          : '가상 재판정 실패' },
      { attackId: 'untrusted_signal_provenance', expected: '클라이언트 출처 신호를 엔진 증거로 승격하지 않음',
        observed: forgedDecision.decision === 'deny'
          ? '로컬 client_header 출처 거부 (실제 엔진 헤더는 미확인)'
          : '출처 불명 신호 거부 검증 실패' },
      { attackId: 'deployed_stage7_identity', expected: '배포 manifest가 7단계 및 기존 서비스 연결 보존',
        observed: configMatches ? 'production /aleph.json step=7 및 보호 서비스 일치'
          : '배포 manifest 설정 확인 실패 (HTTP ' + manifestResponse.status + ')' },
      { attackId: 'existing_browser_ui', expected: '기존 자료실 주소에서 첫 화면 응답',
        observed: homeResponse.ok
          ? '기존 자료실 HTTP ' + homeResponse.status + ' (접속 도구는 미검증)'
          : '첫 화면 HTTP ' + homeResponse.status },
      { attackId: 'anonymous_notes_denied', expected: '비로그인 서버 메모 API는 자료 없이 401',
        observed: denied ? '무로그인 메모 목록 HTTP 401, 자료 없음'
          : '비로그인 메모 거부 실패 (HTTP ' + listResponse.status + ')' },
      { attackId: 'real_subject_reauth_unverified',
        expected: '동일 사용자 새 로그인 시각을 엔진이 검증한 환경에서만 실측',
        observed: '미실행: v1 계약에는 동일 주체의 신규 로그인 증명 및 운영 리다이렉트 확인 근거가 없음' },
    ];
  }

  if (config.step === 6) {
    const { decide, RULE_IDS } = await import('./decider.mjs');
    const { checkDecider } = await import('../scripts/decider-test.mjs');
    const trials = await checkDecider({ decide, ruleIds: RULE_IDS });
    const accepted = trials.find(item => item.name === '등록 기기의 정상 요청');
    const rejected = trials.find(item => item.name === '미등록 기기의 가상 요청');

    const manifestResponse = await fetch(new URL('/aleph.json', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const manifest = manifestResponse.ok ? await safeJson(manifestResponse) : null;
    const matches = manifest?.step === 6
      && manifest?.protectedService?.serviceId === config.protectedService?.serviceId
      && manifest?.protectedService?.readRoute === config.protectedService?.readRoute;
    const uiResponse = await fetch(app, {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'text/html' },
    });
    const listResponse = await fetch(new URL('/api/notes', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const unauthenticated = await safeJson(listResponse);
    const denied = listResponse.status === 401
      && !Array.isArray(unauthenticated) && !Array.isArray(unauthenticated?.notes);

    return [
      { attackId: 'local_registered_device', expected: '엔진 계약 모양의 등록 기기 모의 요청은 allow',
        observed: accepted?.passed ? '로컬 가상 요청 allow 통과 (실제 접속 도구는 미확인)'
          : '로컬 등록 기기 모의 요청 검증 실패' },
      { attackId: 'local_unregistered_device', expected: '엔진 계약 모양의 미등록 기기 모의 요청은 deny',
        observed: rejected?.passed ? '로컬 가상 요청 deny 통과 (실제 접속 도구는 미확인)'
          : '로컬 미등록 기기 모의 요청 검증 실패' },
      { attackId: 'deployed_protected_service', expected: '배포 식별정보의 보호 서비스 ID·읽기 경로 일치',
        observed: matches ? 'production /aleph.json의 서비스 ID·경로 일치'
          : 'production 연결 정보 검증 실패 (HTTP ' + manifestResponse.status + ')' },
      { attackId: 'existing_browser_ui', expected: '기존 HTTPS 자료실 첫 화면이 응답',
        observed: uiResponse.ok ? '기존 주소 첫 화면 HTTP ' + uiResponse.status + ' (엔진 경유는 미확인)'
          : '기존 주소 첫 화면 HTTP ' + uiResponse.status },
      { attackId: 'anonymous_note_denial', expected: '무로그인 메모 목록 직접 요청은 자료 없이 거부',
        observed: denied ? '무로그인 자료실 API HTTP 401, 메모 없음 (기기 검증은 미확인)'
          : '무로그인 자료실 요청 검증 실패 (HTTP ' + listResponse.status + ')' },
    ];
  }

  if (config.step !== 5) throw new Error('이 단계의 공격 점검을 src/attack-check.mjs에 구현해 주세요.');

  let original;
  try { original = new URL(config.originalApiUrl); } catch { throw new Error('5단계 원본 자료 API 주소를 확인해 주세요.'); }
  if (original.protocol !== 'https:' || original.username || original.password
      || original.search || original.hash || original.pathname.endsWith('/')) {
    throw new Error('5단계 originalApiUrl은 쿼리 없는 HTTPS 자료 경로여야 합니다.');
  }

  const listResponse = await fetch(new URL('/api/notes', app), {
    redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json' },
  });
  const listBody = await safeJson(listResponse);
  const listDenied = listResponse.status === 401
    && !Array.isArray(listBody) && !Array.isArray(listBody?.notes);

  const manifestResponse = await fetch(new URL('/aleph.json', app), {
    redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json' },
  });
  const manifestBody = manifestResponse.ok ? await safeJson(manifestResponse) : null;
  const manifestMatches = manifestBody?.step === 5
    && manifestBody?.originalApiUrl === config.originalApiUrl;
  const manifestRoutes = Array.isArray(manifestBody?.allowedRoutes)
    && manifestBody.allowedRoutes.length > 0;

  const screenResponse = await fetch(app, {
    redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Accept: 'text/html' },
  });
  const screenText = screenResponse.ok ? await screenResponse.text() : '';
  const contentTypeOptions = screenResponse.headers.get('x-content-type-options') || '';
  const contentSecurityPolicy = screenResponse.headers.get('content-security-policy') || '';
  const screenHardened = contentTypeOptions.toLowerCase() === 'nosniff'
    || Boolean(contentSecurityPolicy.trim());
  const publicKeyAbsent = !/sb_publishable_[A-Za-z0-9_-]+/u.test(screenText)
    && !/eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/u.test(screenText);

  const originResponse = await fetch(original, {
    redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json' },
  });
  const originBody = await safeJson(originResponse);
  const originDenied = [401, 403].includes(originResponse.status)
    && !Array.isArray(originBody);

  return [
    { attackId: 'anonymous_note_list_denied', expected: '무로그인 Vercel 자료 API는 자료 없이 401 거부',
      observed: listDenied ? '무로그인 /api/notes가 자료 없이 HTTP 401로 거부됨'
        : `무로그인 목록 거부 검증 실패 (HTTP ${listResponse.status})` },
    { attackId: 'deployment_manifest_original_api', expected: '/aleph.json의 originalApiUrl이 제출 설정과 일치',
      observed: manifestMatches ? '배포 /aleph.json의 step=5와 originalApiUrl이 제출 설정과 일치함'
        : `배포 manifest 원본 주소 검증 실패 (HTTP ${manifestResponse.status})` },
    { attackId: 'deployment_manifest_allowed_routes', expected: '/aleph.json의 allowedRoutes에 허용 경로가 하나 이상 있음',
      observed: manifestRoutes ? `배포 /aleph.json allowedRoutes에 ${manifestBody.allowedRoutes.length}개 경로가 있음`
        : '배포 /aleph.json allowedRoutes가 비어 있거나 없음' },
    { attackId: 'first_screen_security_header', expected: '첫 화면 응답에 nosniff 또는 CSP 보안 헤더가 있음',
      observed: screenHardened ? `첫 화면 보안 헤더 확인: ${contentTypeOptions || 'CSP'}`
        : `첫 화면 보안 헤더 없음 (HTTP ${screenResponse.status})` },
    { attackId: 'screen_public_key_absent', expected: '첫 화면 코드에 Supabase publishable/anon 키가 없음',
      observed: publicKeyAbsent ? '첫 화면 코드에 Supabase 공개 키 패턴이 없음'
        : '첫 화면 코드에서 Supabase 공개 키 패턴을 발견함' },
    { attackId: 'direct_origin_without_key_denied', expected: '원본 자료 HTTPS 경로는 키 없는 직접 요청을 거부',
      observed: originDenied ? `원본 자료 경로가 자료 없이 HTTP ${originResponse.status}로 거부됨`
        : `원본 자료 직접 요청 거부 검증 실패 (HTTP ${originResponse.status})` },
  ];
}
