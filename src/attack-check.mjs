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

  if (config.step === 10) {
    const { previewPolicyRestore, hash } = await import('./recovery/policy.mjs');
    const { previewNoteRestore, sha256, contentSha256 } = await import('./recovery/note.mjs');

    // Pure synthetic fixtures only. These are not pre-incident operator
    // backups and never touch production data or operating policy.
    const capturedAt = '2026-09-01T00:00:00.000Z';
    const verifiedAt = '2026-09-02T00:00:00.000Z';
    const incidentAt = '2026-09-04T00:00:00.000Z';
    const currentPolicy = {
      schema: 'aleph.recovery.test-policy.v1',
      services: {
        notes: { version: 'unsafe_v2', ownerOnly: false, rules: [] },
        untouched: { version: 'untouched', ownerOnly: true, rules: ['prior_rule'] },
      },
      audit: [{ id: 'retained_fixture_audit' }],
    };
    const backupRaw = JSON.stringify({
      schema: 'aleph.recovery.policy-backup.v1',
      serviceId: 'notes', capturedAt, verifiedAt,
      policy: { version: 'safe_v1', ownerOnly: true,
        rules: ['device_registered', 'step_up_required'] },
    });
    const policyPlan = previewPolicyRestore({
      current: currentPolicy, backupRaw, trustedSha256: hash(backupRaw), incidentAt,
    });
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const row = { id, owner_id: B, title: 'Example B',
      body: 'Synthetic fixture, never actual backup' };
    const noteRaw = JSON.stringify({
      schema: 'aleph.recovery.note-backup.v1', version: 'example_v1',
      id, ownerId: B, title: row.title, body: row.body,
      capturedAt, verifiedAt, contentSha256: contentSha256(row),
    });
    const notePlan = previewNoteRestore({
      raw: noteRaw, trustedSha256: sha256(noteRaw), incidentAt,
      pinnedBOwnerId: B, identityUserId: B, id, current: null,
    });

    const identityResponse = await fetch(new URL('/aleph.json', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    const identity = identityResponse.ok ? await safeJson(identityResponse) : null;
    const manifestOk = identity?.step === 10
      && identity.restoreRoute === config.restoreRoute
      && identity.originalApiUrl === config.originalApiUrl
      && Array.isArray(identity.allowedRoutes)
      && identity.allowedRoutes.includes(config.restoreRoute);
    const pageResponse = await fetch(app, {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'text/html' },
    });
    const notesResponse = await fetch(new URL('/api/notes', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const notesBody = await safeJson(notesResponse);
    const notesDenied = notesResponse.status === 401
      && !Array.isArray(notesBody) && !Array.isArray(notesBody?.notes);
    const restoreResponse = await fetch(
      new URL('/api/restore/notes/cccccccc-cccc-4ccc-8ccc-cccccccccccc', app),
      { redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/json' } },
    );
    const restoreBody = await safeJson(restoreResponse);
    const restoreBlocked = [401, 403, 503].includes(restoreResponse.status)
      && !restoreBody?.title && !restoreBody?.body;

    return [
      { attackId: 'synthetic_safe_policy_preview',
        expected: '안전 정책 버전·변경 범위를 실행 전 표시',
        observed: policyPlan.restoreVersion === 'safe_v1'
          && policyPlan.changedPaths.every(x => x.startsWith('services.notes.'))
          ? '로컬 합성 사본 safe_v1, notes 변경 경로 '
            + policyPlan.changedPaths.length + '개 미리보기'
          : '로컬 시험 정책 변경 범위 확인 실패' },
      { attackId: 'synthetic_restore_single_note',
        expected: 'B 소유 한 건의 ID·owner·content SHA-256 검증',
        observed: notePlan.status === 'insert' && notePlan.contentSha256 === contentSha256(row)
          ? '로컬 합성 B 메모 한 건의 ID·owner·해시 비교 통과 (실제 DB 쓰기 없음)'
          : '로컬 가상 메모 해시 비교 실패' },
      { attackId: 'deployed_restore_route',
        expected: '배포 manifest와 복구 경로 일치',
        observed: manifestOk ? 'production step=10 및 restoreRoute 일치'
          : '배포 복구 설정 불일치 (HTTP ' + identityResponse.status + ')' },
      { attackId: 'existing_browser_ui',
        expected: '기존 자료실 첫 화면 응답',
        observed: pageResponse.ok
          ? '기존 자료실 HTTP ' + pageResponse.status
          : '기존 자료실 응답 실패 (HTTP ' + pageResponse.status + ')' },
      { attackId: 'anonymous_notes_denied',
        expected: '비로그인 메모 목록은 자료 없이 401',
        observed: notesDenied ? '무로그인 /api/notes HTTP 401, 자료 없음'
          : '무로그인 메모 거부 검증 실패 (HTTP ' + notesResponse.status + ')' },
      { attackId: 'recovery_default_fail_closed',
        expected: '검증된 백업과 로그인 없이는 복구 경로 거부',
        observed: restoreBlocked
          ? '복구 미인증·미설정 요청 HTTP ' + restoreResponse.status
            + ' (자료 본문 없음)'
          : '복구 경로 거부 검증 실패 (HTTP ' + restoreResponse.status + ')' },
      { attackId: 'live_policy_restore_unverified',
        expected: '검증된 침해 전 운영 정책 사본의 실복원 검증',
        observed: '미실행: 침해 전 독립 검증된 운영 정책 사본 없음' },
      { attackId: 'live_b_note_restore_unverified',
        expected: 'B 계정 비공개 사본으로 한 건 복구',
        observed: '미실행: B의 검증된 비공개 백업 및 실제 B 인증 정보 없음' },
      { attackId: 'one_to_nine_live_regressions_unverified',
        expected: '1~9단계 실제 A/B 정상·금지 요청 회귀 실행',
        observed: '미실행: 실제 A/B 계정·엔진 접속 및 복구 완료 환경 부재' },
    ];
  }

  if (config.step === 9) {
    const { detect } = await import('./detect.mjs');
    const { checkDetection } = await import('../scripts/detect-test.mjs');
    const localCases = await checkDetection(detect);
    const allPracticeCasesPass = localCases.length === 6
      && localCases.every(item => item.passed);

    const at0 = Date.UTC(2026, 9, 1);
    const fixture = Array.from({ length: 121 }, (_, i) => ({
      at: new Date(at0 + i * 2000).toISOString(),
      method: 'GET', identity: { sub: 'learner_fixture' },
    }));
    const proposal = detect(fixture);
    const normal = detect(fixture.slice(0, 120));
    const spoofed = detect(fixture.map(event => ({
      ...event, deviceId: 'unverified-browser-device',
      network: 'unusual', headers: { 'x-network': 'unusual' },
    })));
    const proposed = proposal.action === 'propose_revocation'
      && proposal.reasonCode === 'burst_read'
      && proposal.subject === 'learner_fixture'
      && Object.keys(proposal).sort().join(',') === 'action,reasonCode,subject';
    const unaffectedByClientExtras =
      JSON.stringify(spoofed) === JSON.stringify(proposal);

    const manifestResponse = await fetch(new URL('/aleph.json', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const manifest = manifestResponse.ok ? await safeJson(manifestResponse) : null;
    const deployed = manifest?.step === 9
      && manifest?.originalApiUrl === config.originalApiUrl
      && manifest?.protectedService?.serviceId === config.protectedService?.serviceId
      && manifest?.protectedService?.readRoute === config.protectedService?.readRoute
      && Array.isArray(manifest?.allowedRoutes)
      && config.allowedRoutes?.every(route => manifest.allowedRoutes.includes(route));

    const homeResponse = await fetch(app, {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'text/html' },
    });
    const anonymousResponse = await fetch(new URL('/api/notes', app), {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    const anonymousData = await safeJson(anonymousResponse);
    const unauthorized = anonymousResponse.status === 401
      && !Array.isArray(anonymousData) && !Array.isArray(anonymousData?.notes);

    return [
      { attackId: 'virtual_event_contract', expected: '제공된 여섯 가상 사건 계약 검증',
        observed: allPracticeCasesPass
          ? '로컬 가상 사건 6/6 검증 통과 (실제 엔진 사건 아님)'
          : '로컬 사건 계약 확인 실패' },
      { attackId: 'subject_burst_proposal', expected: '동일 가명 사용자 GET 121건 / 10분이면 burst_read 제안',
        observed: proposed ? '로컬 가상 사건 propose_revocation + burst_read 반환'
          : '가상 회수 제안 검증 실패' },
      { attackId: 'normal_volume_observe', expected: '동일 가명 사용자 120건은 observe',
        observed: normal.action === 'observe' ? '로컬 정상 조회 120건 observe'
          : '정상 조회 사건 판정 오류' },
      { attackId: 'client_metadata_not_trusted', expected: '클라이언트 추가 필드는 탐지 입력 신뢰 증거가 아님',
        observed: unaffectedByClientExtras
          ? '클라이언트 deviceId/network/headers 무시, 출력 불변'
          : '추가 클라이언트 필드의 영향 발견' },
      { attackId: 'deployed_stage9_manifest', expected: '배포 manifest는 단계 9 및 기존 주소를 보존',
        observed: deployed ? 'production /aleph.json 9단계·보호 서비스·경로 일치'
          : '배포 manifest 검사 실패 (HTTP ' + manifestResponse.status + ')' },
      { attackId: 'existing_browser_ui', expected: '기존 로그인 화면의 응답 유지',
        observed: homeResponse.ok ? '기존 자료실 첫 화면 HTTP ' + homeResponse.status
          : '기존 자료실 첫 화면 확인 실패 (HTTP ' + homeResponse.status + ')' },
      { attackId: 'anonymous_notes_denied', expected: '무로그인 자료 목록은 반환 없이 401',
        observed: unauthorized ? '무로그인 /api/notes HTTP 401, 자료 없음'
          : '무로그인 API 거부 확인 실패 (HTTP ' + anonymousResponse.status + ')' },
      { attackId: 'network_device_contract_unavailable',
        expected: '검증된 네트워크·기기 ID가 없는 계약은 운영 기기 탐지로 가장하지 않음',
        observed: '미실행: 제공된 사건에는 네트워크·기기 ID·사전 판정이 없음' },
      { attackId: 'real_revocation_unverified',
        expected: '기기별 회수와 지연시간은 실제 엔진 이벤트로만 검증',
        observed: '미실행: 회수 API 호출·기기 권한 변경·실제 경과시간 측정 없음' },
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
