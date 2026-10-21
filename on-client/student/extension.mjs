// 이 파일은 학생이 같은 프로젝트에서 이어서 구현합니다.
// 제공 UI를 받은 것만으로 단계 완료를 인정하지 않습니다.
export function createStudentView() {
  return {
    renderIdentity({ me, devices, sessions } = {}) {
      const root = document.createElement('div');
      const deviceStates = {
        compliant: '보안 기준 충족',
        noncompliant: '보안 기준 미충족',
        unknown: '확인 불가',
      };
      const sessionStates = {
        active: '활성',
        expired: '만료',
        revoked: '철회됨',
        unknown: '확인 불가',
      };
      const modeLabels = { demo: '예제 자료', disconnected: '연결 없음', unknown: '확인 불가' };
      const readable = (value) => typeof value === 'string' && value.trim() ? value : '확인 불가';
      const stateWithCode = (states, value) => {
        const code = typeof value === 'string' && value.trim() ? value : 'unknown';
        const description = Object.hasOwn(states, code) ? states[code] : states.unknown;
        return `${description} (${code})`;
      };
      const deviceState = (value) => stateWithCode(deviceStates, value);
      const sessionState = (value) => stateWithCode(sessionStates, value);
      const message = (parent, text) => {
        const p = document.createElement('p');
        p.textContent = text;
        parent.append(p);
      };
      const field = (list, title, value) => {
        const dt = document.createElement('dt');
        dt.textContent = title;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.append(dt, dd);
      };
      const section = (title, resource, showData) => {
        const group = document.createElement('section');
        const heading = document.createElement('h3');
        heading.textContent = title;
        group.append(heading);

        // 연결 모드는 요청 상태와 독립적으로 표시한다.
        if (Object.hasOwn(modeLabels, resource?.mode)) {
          message(group, modeLabels[resource.mode]);
        }
        if (resource?.status === 'loading') {
          message(group, '불러오는 중');
        } else if (resource?.status === 'error') {
          const unverified = ['CONTRACT_MISMATCH', 'ENGINE_RESULT_UNVERIFIED'].includes(resource.error?.code);
          const detail = typeof resource.error?.message === 'string' && resource.error.message.trim()
            ? resource.error.message : '서버 응답을 확인할 수 없습니다.';
          message(group, `${unverified ? '확인 불가' : '연결 실패'}: ${detail}`);
        } else if (resource?.status === 'ok' && resource.data != null) {
          showData(group, resource.data);
        } else {
          message(group, '확인 불가');
        }
        root.append(group);
      };

      section('현재 계정·기기·로그인 세션', me, (group, data) => {
        if (!data.user || !data.device || !data.session) {
          message(group, '확인 불가: 로그인 정보를 확인할 수 없습니다.');
          return;
        }
        const list = document.createElement('dl');
        field(list, '사용자', `${readable(data.user.label)} · ID: ${readable(data.user.id)}`);
        field(list, '현재 기기', `${readable(data.device.label)} · ID: ${readable(data.device.id)}`);
        field(list, '기기 보안 상태', deviceState(data.device.status));
        field(list, '로그인 세션', `ID: ${readable(data.session.id)}`);
        field(list, '세션 상태', sessionState(data.session.status));
        group.append(list);
      });
      section('본인 등록 기기', devices, (group, data) => {
        if (!Array.isArray(data)) return message(group, '확인 불가');
        if (data.length === 0) return message(group, '등록된 기기 없음');
        const list = document.createElement('ul');
        for (const device of data) {
          const item = document.createElement('li');
          item.textContent = `${readable(device.label)} · ID: ${readable(device.id)} · ${deviceState(device.status)}`;
          list.append(item);
        }
        group.append(list);
      });
      section('확인된 로그인 세션', sessions, (group, data) => {
        if (!Array.isArray(data)) return message(group, '확인 불가');
        if (data.length === 0) return message(group, '확인된 세션 없음');
        const list = document.createElement('ul');
        for (const session of data) {
          const item = document.createElement('li');
          item.textContent = `ID: ${readable(session.id)} · ${sessionState(session.status)}`;
          list.append(item);
        }
        group.append(list);
      });
      return root;
    },
    renderDecision({ status = 'idle', mode, data, error, appId } = {}) {
      const root = document.createElement('div');
      const message = (value) => {
        const p = document.createElement('p');
        p.textContent = value;
        root.append(p);
      };
      const field = (list, title, value) => {
        const dt = document.createElement('dt');
        dt.textContent = title;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.append(dt, dd);
      };
      const modeLabels = {
        connected: '연결됨(connected)',
        demo: '예제 데이터(demo) · 실제 업무 앱 접속 결과가 아닙니다.',
        disconnected: '연결 없음(disconnected)',
        unknown: '연결 상태 확인 불가(unknown)',
      };
      if (mode != null) {
        message(Object.hasOwn(modeLabels, mode) ? modeLabels[mode] : modeLabels.unknown);
      }
      if (status === 'idle') {
        message('업무 앱 하나를 선택한 뒤 접속 요청을 누르세요.');
        return root;
      }
      const selectedApp = typeof appId === 'string' && appId.trim()
        ? appId : typeof data?.appId === 'string' && data.appId.trim() ? data.appId : null;
      if (selectedApp) message('업무 앱 ID: ' + selectedApp);
      if (status === 'loading') {
        message('접속 판정 확인 중입니다.');
        return root;
      }
      if (status === 'error') {
        const detail = typeof error?.message === 'string' && error.message.trim()
          ? error.message : '서버 오류 메시지를 확인할 수 없습니다.';
        message('접속 판정 요청 실패: ' + detail);
        message('요청 실패는 접근 거부(deny) 판정이 아니며, 접근 허용도 확인되지 않았습니다.');
        return root;
      }
      if (status !== 'ok' || typeof data?.appId !== 'string' || !data.appId.trim()
          || (selectedApp && data.appId !== selectedApp)) {
        message('접속 판정: 확인 불가(unknown)');
        message('요청 상태나 판정 대상 앱을 확인할 수 없어 접근 허용으로 간주하지 않습니다.');
        return root;
      }

      const decisionLabels = {
        allow: '접근 허용(allow)',
        deny: '접근 거부(deny)',
        challenge: '추가 확인 필요(challenge)',
        unknown: '확인 불가(unknown)',
      };
      const decision = Object.hasOwn(decisionLabels, data.decision) ? data.decision : 'unknown';
      message('접속 판정: ' + decisionLabels[decision]);
      if (decision === 'allow') {
        message('정책상 접근 허용이며 실제 업무 앱 접속 성공을 보장하지 않습니다.');
      } else if (decision === 'deny') {
        message('정책상 해당 업무 앱 접근이 거부되었습니다.');
      } else if (decision === 'challenge') {
        message('추가 인증 또는 확인이 필요합니다. 이 앱은 확인 절차를 대신 수행하지 않습니다.');
      } else {
        message('판정을 확인할 수 없으므로 접근 허용으로 간주하지 않습니다.');
      }
      const details = document.createElement('dl');
      field(details, '판정 이유', typeof data.reason === 'string' && data.reason.trim()
        ? data.reason : '사유 정보 없음');
      field(details, '판정 시각', typeof data.checkedAt === 'string' && data.checkedAt.trim()
        ? data.checkedAt : '시각 정보 없음');
      root.append(details);
      return root;
    },
    renderEvents({ status = 'idle', mode, data, error } = {}) {
      const root = document.createElement('section');
      const message = (parent, text) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        parent.append(paragraph);
      };
      if (status === 'loading') {
        message(root, '보안 기록을 불러오는 중입니다.');
        return root;
      }
      if (status === 'error') {
        const detail = typeof error?.message === 'string' && error.message.trim()
          ? error.message : '서버 응답을 확인할 수 없습니다.';
        const prefix = error?.code === 'CONTRACT_MISMATCH' ? '확인 불가(CONTRACT_MISMATCH): ' : '';
        message(root, prefix + '기록을 불러오지 못했습니다: ' + detail);
        return root;
      }
      if (status !== 'ok' || !Array.isArray(data)) {
        message(root, '보안 기록 상태를 확인할 수 없습니다.');
        return root;
      }
      if (data.length === 0) {
        message(root, '표시할 기록이 없습니다');
        return root;
      }

      // 제공된 본인 기록만 복사해서 정렬한다. 서버나 입력 배열은 변경하지 않는다.
      const events = [...data].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const kindLabels = { access: '접속 기록', xdr: 'XDR 경보' };
      const accessLabels = { allowed: '접속 허용', denied: '접속 거부', unknown: '확인 불가' };
      const sessionLabels = { active: '활성', expired: '만료', revoked: '철회됨', unknown: '확인 불가' };
      const deviceLabels = { compliant: '보안 기준 충족', noncompliant: '보안 기준 미충족', unknown: '확인 불가' };
      const labeledValue = (labels, value) => (Object.hasOwn(labels, value) ? labels[value] : '확인 불가')
        + '(' + value + ')';
      const appLabel = (id) => id == null || id === '' ? '앱 ID 확인 불가' : id;
      const kindLabel = (kind) => labeledValue(kindLabels, kind);
      const accessLabel = (access) => labeledValue(accessLabels, access);

      const filters = document.createElement('div');
      const count = document.createElement('p');
      count.setAttribute('role', 'status');
      const list = document.createElement('ul');
      const createFilter = (title, values, describe) => {
        const label = document.createElement('label');
        label.textContent = title + ': ';
        const select = document.createElement('select');
        select.setAttribute('aria-label', title);
        const all = document.createElement('option');
        all.value = 'all';
        all.textContent = '전체';
        select.append(all);
        for (const value of new Set(values)) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = describe(value);
          select.append(option);
        }
        label.append(select);
        filters.append(label);
        return select;
      };
      const kindFilter = createFilter('기록 종류', data.map((event) => event.kind), kindLabel);
      const appFilter = createFilter('업무 앱', data.map((event) => event.appId ?? ''), appLabel);
      const accessFilter = createFilter('접속 상태', data.map((event) => event.state.access), accessLabel);
      root.append(filters, count, list);

      const field = (definition, name, value) => {
        const term = document.createElement('dt');
        term.textContent = name;
        const description = document.createElement('dd');
        description.textContent = value;
        definition.append(term, description);
      };
      const itemGroup = (parent, title, items) => {
        const heading = document.createElement('h4');
        heading.textContent = title;
        parent.append(heading);
        if (items.length === 0) {
          message(parent, title + ' 없음');
          return;
        }
        const entries = document.createElement('ul');
        for (const entry of items) {
          const row = document.createElement('li');
          row.textContent = 'ID: ' + entry.id + ' · ' + entry.text;
          entries.append(row);
        }
        parent.append(entries);
      };
      const makeDetail = (event) => {
        const detail = document.createElement('section');
        detail.setAttribute('data-student-event-detail', event.id);
        const heading = document.createElement('h4');
        heading.textContent = '기록 상세';
        const identity = document.createElement('dl');
        field(identity, '사건 ID', event.id);
        field(identity, '앱 ID', appLabel(event.appId));
        detail.append(heading, identity);
        itemGroup(detail, '근거', event.evidence);
        itemGroup(detail, '규칙', event.rules);
        const states = document.createElement('dl');
        field(states, '접속 상태', accessLabel(event.state.access));
        field(states, '세션 상태', labeledValue(sessionLabels, event.state.session));
        field(states, '기기 상태', labeledValue(deviceLabels, event.state.device));
        detail.append(states);
        if (Array.isArray(event.supportedActions) && event.supportedActions.length > 0) {
          const actions = document.createElement('div');
          const title = document.createElement('h4');
          title.textContent = '미지원 조치';
          actions.append(title);
          for (const action of event.supportedActions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = action + ' 미지원';
            button.disabled = true;
            button.setAttribute('aria-disabled', 'true');
            actions.append(button);
          }
          message(actions, '조치 실행 연결은 준비 중입니다. 이 화면에서 조치 요청을 보내지 않습니다.');
          detail.append(actions);
        }
        return detail;
      };

      let openButton = null;
      let openDetail = null;
      const renderList = () => {
        list.replaceChildren();
        openButton = null;
        openDetail = null;
        const filtered = events.filter((event) =>
          (kindFilter.value === 'all' || event.kind === kindFilter.value)
          && (appFilter.value === 'all' || (event.appId ?? '') === appFilter.value)
          && (accessFilter.value === 'all' || event.state.access === accessFilter.value));
        count.textContent = '표시 중 ' + filtered.length + '건 / 받은 기록 ' + events.length + '건';
        if (filtered.length === 0) {
          message(list, '필터 조건에 맞는 기록이 없습니다.');
          return;
        }
        for (const event of filtered) {
          const row = document.createElement('li');
          row.setAttribute('data-student-event-id', event.id);
          const fields = document.createElement('dl');
          field(fields, '사건 ID', event.id);
          field(fields, '시각', event.at);
          field(fields, '기록 종류', kindLabel(event.kind));
          field(fields, '업무 앱', appLabel(event.appId));
          field(fields, '요약', event.summary);
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = event.id + ' 상세';
          button.setAttribute('aria-expanded', 'false');
          button.addEventListener('click', () => {
            if (openDetail) {
              openDetail.remove();
              openButton.setAttribute('aria-expanded', 'false');
            }
            if (openButton === button) {
              openButton = null;
              openDetail = null;
              return;
            }
            openDetail = makeDetail(event);
            row.append(openDetail);
            button.setAttribute('aria-expanded', 'true');
            openButton = button;
          });
          row.append(fields, button);
          list.append(row);
        }
      };
      for (const select of [kindFilter, appFilter, accessFilter]) {
        select.addEventListener('change', renderList);
      }
      renderList();
      return root;
    },
    renderStatus({ devices, sessions, notifications, diagnostics, mode } = {}) {
      const root = document.createElement('section');
      const message = (parent, text) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        parent.append(paragraph);
      };
      const heading = (parent, text) => {
        const title = document.createElement('h3');
        title.textContent = text;
        parent.append(title);
      };
      const field = (definition, name, value) => {
        const term = document.createElement('dt');
        term.textContent = name;
        const description = document.createElement('dd');
        description.textContent = value;
        definition.append(term, description);
      };
      const readable = (value) => typeof value === 'string' && value.trim() ? value : '확인 불가';
      const sessionLabels = { active: '활성', expired: '만료', revoked: '철회됨', unknown: '확인 불가' };
      const deviceLabels = { compliant: '보안 기준 충족', noncompliant: '보안 기준 미충족', unknown: '확인 불가' };
      const stateText = (labels, value) => {
        const code = typeof value === 'string' && value.trim() ? value : 'unknown';
        return (Object.hasOwn(labels, code) ? labels[code] : '확인 불가') + '(' + code + ')';
      };
      const failure = (section, label, resource, retryControl) => {
        const code = resource?.error?.code;
        const detail = typeof resource?.error?.message === 'string' && resource.error.message.trim()
          ? resource.error.message : '서버 응답을 확인할 수 없습니다.';
        const unverified = code === 'CONTRACT_MISMATCH' || code === 'ENGINE_RESULT_UNVERIFIED';
        const subject = label === '등록 기기' ? '등록 기기를'
          : label === '현재 로그인 세션' ? '현재 로그인 세션을' : '진단 정보를';
        message(section, unverified ? label + ' 확인 불가: ' + detail
          : subject + ' 불러오지 못했습니다: ' + detail);
        if ((typeof code === 'string' && /TIMEOUT/i.test(code)) || /시간\s*초과/u.test(detail)) {
          message(section, '요청 시간이 초과됐습니다.');
        }
        message(section, '다시 시도하려면 위쪽 「' + retryControl + '」 버튼을 직접 누르세요. 자동 재요청은 하지 않습니다.');
      };
      const renderListResource = (title, resource, emptyText, rowText) => {
        const section = document.createElement('section');
        heading(section, title);
        if (resource?.status === 'loading') {
          message(section, (title === '등록 기기' ? '등록 기기를' : '현재 로그인 세션을') + ' 불러오는 중입니다.');
        } else if (resource?.status === 'error') {
          failure(section, title, resource, '다시 불러오기');
        } else if (resource?.status === 'ok' && Array.isArray(resource.data)) {
          if (resource.data.length === 0) {
            message(section, emptyText);
          } else {
            const list = document.createElement('ul');
            for (const row of resource.data) {
              const item = document.createElement('li');
              item.textContent = rowText(row);
              list.append(item);
            }
            section.append(list);
          }
        } else if (resource?.status === 'ok') {
          message(section, title + ' 형식을 확인할 수 없습니다.');
        } else {
          message(section, title + ' 조회 전입니다.');
        }
        root.append(section);
      };

      const modes = { connected: '연결됨(connected)', demo: '예제 자료(demo)', disconnected: '연결 없음(disconnected)', unknown: '확인 불가(unknown)' };
      if (mode != null) message(root, '연결 모드: ' + (Object.hasOwn(modes, mode) ? modes[mode] : modes.unknown));

      renderListResource('등록 기기', devices, '등록된 기기가 없습니다.', (device) =>
        '기기: ' + readable(device.label) + ' · 상태: ' + stateText(deviceLabels, device.status));
      renderListResource('현재 로그인 세션', sessions, '현재 연결이 없습니다.', (session) =>
        '세션 ID: ' + readable(session.id) + ' · 상태: ' + stateText(sessionLabels, session.status));
      message(root, '세션 조회는 현재 검증된 연결 한 건만 대상으로 하며, 과거 세션 전체 목록이 아닙니다.');

      const notices = document.createElement('section');
      heading(notices, '주의 알림');
      if (!Array.isArray(notifications) || notifications.length === 0) {
        message(notices, '주의할 알림이 없습니다.');
      } else {
        const list = document.createElement('ul');
        for (const notice of notifications) {
          const item = document.createElement('li');
          item.textContent = '자료: ' + readable(notice.resource)
            + ' · 코드: ' + readable(notice.code)
            + ' · 내용: ' + readable(notice.message);
          list.append(item);
        }
        notices.append(list);
      }
      root.append(notices);

      const diagnosticSection = document.createElement('section');
      heading(diagnosticSection, '진단 정보');
      const copyHelp = document.createElement('p');
      copyHelp.textContent = '도움 요청에 사용할 수 있는 진단 정보만 복사합니다. 비밀번호·토큰·API 키는 포함하지 않습니다.';
      diagnosticSection.append(copyHelp);
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.textContent = '도움정보 복사';
      copyButton.disabled = true;
      const copyResult = document.createElement('p');
      copyResult.setAttribute('role', 'status');

      if (diagnostics?.status === 'loading') {
        message(diagnosticSection, '진단 정보를 불러오는 중입니다.');
      } else if (diagnostics?.status === 'error') {
        failure(diagnosticSection, '진단 정보', diagnostics, '도움정보 불러오기');
      } else if (diagnostics?.status === 'ok' && diagnostics.data && typeof diagnostics.data === 'object') {
        // 사용자가 실제 복사를 누를 때만, 제공된 진단 결과의 6개 안전한 필드만 복사한다.
        const safe = (value) => typeof value === 'string'
          && /^[A-Za-z0-9._:+-]{1,128}$/u.test(value)
          && !/^(?:eyJ|sk-|sb_)/iu.test(value) ? value : '확인 불가';
        const data = diagnostics.data;
        const exported = {
          requestId: safe(data.requestId),
          component: safe(data.component),
          version: safe(data.version),
          checkedAt: safe(data.checkedAt),
          engine: {
            mode: safe(data.engine?.mode),
            code: safe(data.engine?.code),
          },
        };
        const details = document.createElement('dl');
        field(details, 'requestId', exported.requestId);
        field(details, 'component', exported.component);
        field(details, 'version', exported.version);
        field(details, 'checkedAt', exported.checkedAt);
        field(details, 'engine.mode', exported.engine.mode);
        field(details, 'engine.code', exported.engine.code);
        diagnosticSection.append(details);
        copyButton.disabled = false;
        copyButton.addEventListener('click', async () => {
          try {
            if (typeof navigator?.clipboard?.writeText !== 'function') {
              throw new Error('CLIPBOARD_UNAVAILABLE');
            }
            await navigator.clipboard.writeText(JSON.stringify(exported, null, 2));
            copyResult.textContent = '도움정보를 클립보드에 복사했습니다. 필요한 경우 직접 도움 요청에 사용하세요.';
          } catch {
            copyResult.textContent = '도움정보 복사에 실패했습니다. 브라우저의 클립보드 권한을 확인하세요.';
          }
        });
      } else if (diagnostics?.status === 'ok') {
        message(diagnosticSection, '진단 정보 형식을 확인할 수 없습니다.');
      } else {
        message(diagnosticSection, '진단 정보를 아직 조회하지 않았습니다. 위쪽 「도움정보 불러오기」를 직접 누르세요.');
      }
      diagnosticSection.append(copyButton, copyResult);
      root.append(diagnosticSection);
      return root;
    },
    renderVulnerabilities() { return '학생 구현 대기: 정확한 설치 버전·OSV 출처·조회 시각·부분 결과·조회 실패를 구분하세요.'; },
    renderAiConnection({ status = 'idle', mode, data, error, checkedAt, explanationAccepted = false } = {}) {
      const root = document.createElement('section');
      const show = (text) => {
        const p = document.createElement('p');
        p.textContent = text;
        root.append(p);
      };
      const modes = {
        connected: '연결됨(connected)',
        demo: '예제 데이터(demo) · 실제 AI 게이트 연결 증거가 아닙니다.',
        disconnected: '연결 없음(disconnected)',
        unknown: '연결 상태 확인 불가(unknown)',
      };
      if (Object.hasOwn(modes, mode)) show('연결 모드: ' + modes[mode]);

      if (status === 'idle') {
        show('AI 연결 점검 전');
        show('이전 점검 결과는 현재 상태가 아닙니다. 연결 확인 후 「현재 API 연결 점검」을 직접 누르세요.');
        return root;
      }
      if (status === 'loading') {
        show('AI 연결 점검 중');
        show('현재 계정과 앱 이용 권한, 모델 응답을 확인하고 있습니다. 아직 사건 설명을 실행하지 않았습니다.');
        return root;
      }
      if (status === 'ok') {
        if (data?.transportChecked !== true || !['test', 'verified'].includes(data?.audienceAuthorization)
            || !Number.isInteger(data?.modelCount) || data.modelCount < 0
            || typeof checkedAt !== 'string' || !checkedAt.trim()) {
          show('AI 연결 점검 결과를 확인할 수 없습니다. 연결 성공으로 간주하지 않습니다.');
          return root;
        }
        show('AI 연결 점검 결과: ' + (data.audienceAuthorization === 'test'
          ? '시험 연결 점검(test) · 실제 앱 이용 권한 확인 아님'
          : '앱 권한 확인 후 점검(verified) · 점검 시각 기준'));
        show('응답 모델 수: ' + data.modelCount + '개');
        show('점검 시각: ' + checkedAt);
        show('현재 API 연결과 모델 목록만 점검했습니다. 사건 설명은 아직 실행하지 않았습니다.');
        show('사건 설명은 보안 기록에서 별도로 직접 요청하고 응답을 확인해야 합니다.');
        return root;
      }
      if (status === 'error') {
        const guidance = {
          ON_AI_PROVISIONING_PENDING: '학생 계정 연결 또는 앱 권한 발급이 준비 중입니다. 담당자에게 준비 상태를 확인하세요.',
          SUBJECT_SCOPE_UNVERIFIED: '현재 로그인·프로젝트 연결을 확인할 수 없습니다. 계정 연결을 다시 확인하고 담당자에게 문의하세요.',
          ON_AI_AUTHORIZATION_CHANGED: '점검 도중 앱 이용 권한이 변경됐습니다. 현재 계정과 권한을 담당자에게 확인하세요.',
          WB_CLCO_AUTH_REQUIRED: '앱 인증에 실패했습니다. 계정 연결을 확인하고 담당자에게 인증 상태를 문의하세요.',
          WB_CLCO_ACCESS_BLOCKED: '앱 접근 권한이 제한됐습니다. 담당자에게 앱 이용 권한을 확인하세요.',
          WB_CLCO_COHORT_BUDGET_EXHAUSTED: '반의 AI 사용량이 소진됐습니다. 담당자에게 이용 가능 여부를 확인하세요.',
          WB_CLCO_LIMIT_REACHED: 'AI 이용 한도에 도달했습니다. 담당자에게 한도를 확인하세요.',
          WB_CLCO_SESSION_CLOSED: '현재 AI 이용 시간이 아닙니다. 수업 이용 시간을 확인하세요.',
          WB_CLCO_RATE_LIMITED: 'AI 요청이 일시적으로 제한됐습니다. 잠시 뒤 직접 다시 점검하세요.',
          WB_CLCO_TIMEOUT: 'AI 응답 시간이 초과됐습니다. 잠시 뒤 직접 다시 점검하세요.',
          REQUEST_TIMEOUT: '서버 AI 응답 시간이 초과됐습니다. 잠시 뒤 직접 다시 점검하세요.',
          ENGINE_TIMEOUT: '서버 점검 시간이 초과됐습니다. 잠시 뒤 직접 다시 점검하세요.',
          TIMEOUT: 'AI 점검 시간이 초과됐습니다. 잠시 뒤 직접 다시 점검하세요.',
          WB_CLCO_CANCELLED: 'AI 점검이 취소됐습니다. 이전 응답은 현재 결과가 아닙니다.',
          CANCELLED: 'AI 점검이 취소됐습니다. 이전 응답은 현재 결과가 아닙니다.',
          REQUEST_CANCELLED: 'AI 점검이 취소됐습니다. 이전 응답은 현재 결과가 아닙니다.',
          ON_AI_MODEL_LIST_EMPTY: '현재 앱 권한으로 사용할 수 있는 모델이 없습니다. 담당자에게 모델 허용 설정을 확인하세요.',
          MODEL_NOT_CONFIGURED: 'AI 모델 설정이 없습니다. 담당자에게 모델 설정을 확인하세요.',
          ON_AI_INVALID_INPUT: 'AI 점검 요청의 입력을 확인할 수 없습니다. 담당자에게 계약 확인을 요청하세요.',
          ON_AI_INVALID_OUTPUT: 'AI 점검 결과의 형식을 확인할 수 없습니다. 성공으로 간주하지 않습니다.',
          AI_REQUEST_UNVERIFIED: 'AI 연결·네트워크 또는 응답을 확인할 수 없습니다. 연결 상태를 확인한 후 직접 재점검하세요.',
        };
        const code = Object.hasOwn(guidance, error?.code) ? error.code : 'AI_REQUEST_UNVERIFIED';
        const rawMessage = error?.message;
        const sensitive = /(?:Bearer\s+\S+|\b(?:sk-|sb_)[A-Za-z0-9_-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|authorization|password|비밀번호|토큰)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,})/iu;
        const detail = typeof rawMessage === 'string' && rawMessage.trim() && rawMessage.length <= 400
          && !sensitive.test(rawMessage) && !/[\u0000-\u001f]/u.test(rawMessage)
          ? rawMessage : '안전한 오류 메시지를 확인할 수 없습니다.';
        show('AI 연결 점검 실패 · 코드: ' + code + ' · 메시지: ' + detail);
        show(guidance[code]);
        show('사건 설명이 성공한 것이 아닙니다. 「현재 API 연결 점검」을 직접 눌러 다시 점검하세요. 자동 재요청은 하지 않습니다.');
        return root;
      }
      show('AI 연결 점검 상태를 확인할 수 없습니다. 이전 결과를 현재 성공으로 간주하지 않습니다.');
      return root;
    },
    renderExplanation({ event, explanation, checkedAt } = {}) {
      const root = document.createElement('section');
      const show = (text) => {
        const p = document.createElement('p');
        p.textContent = text;
        root.append(p);
      };
      const status = explanation?.status ?? 'idle';
      if (status === 'error') {
        const codes = [
          'ON_AI_PROVISIONING_PENDING', 'WB_CLCO_AUTH_REQUIRED', 'WB_CLCO_ACCESS_BLOCKED',
          'WB_CLCO_COHORT_BUDGET_EXHAUSTED', 'WB_CLCO_RATE_LIMITED', 'WB_CLCO_LIMIT_REACHED',
          'WB_CLCO_SESSION_CLOSED', 'WB_CLCO_TIMEOUT', 'REQUEST_TIMEOUT', 'ENGINE_TIMEOUT',
          'TIMEOUT', 'WB_CLCO_CANCELLED', 'CANCELLED', 'REQUEST_CANCELLED',
          'MODEL_NOT_CONFIGURED', 'ON_AI_AUTHORIZATION_CHANGED', 'ON_AI_MODEL_LIST_EMPTY',
          'SUBJECT_SCOPE_UNVERIFIED', 'ON_AI_INVALID_INPUT', 'ON_AI_INVALID_OUTPUT',
          'AI_REQUEST_UNVERIFIED',
        ];
        const code = codes.includes(explanation?.error?.code)
          ? explanation.error.code : 'AI_REQUEST_UNVERIFIED';
        const rawMessage = explanation?.error?.message;
        const sensitive = /(?:Bearer\s+\S+|\b(?:sk-|sb_)[A-Za-z0-9_-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|authorization|password|비밀번호|토큰)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,})/iu;
        const detail = typeof rawMessage === 'string' && rawMessage.trim() && rawMessage.length <= 400
          && !sensitive.test(rawMessage) && !/[\u0000-\u001f]/u.test(rawMessage)
          ? rawMessage : '안전한 오류 메시지를 확인할 수 없습니다.';
        show('AI 사건 설명 실패 · 코드: ' + code + ' · 메시지: ' + detail);
        show('기존 보안 기록은 그대로 유지됩니다. 설명 실패를 사건 탐지 또는 접근 판정 결과로 간주하지 않습니다.');
        return root;
      }
      if (typeof event?.id !== 'string' || !event.id.trim()) {
        show('보안 기록을 먼저 선택하세요. AI 사건 설명은 아직 실행하지 않았습니다.');
        return root;
      }
      if (status === 'loading') {
        show('사건 ID: ' + event.id);
        show('AI 사건 설명 요청 중입니다. 응답은 아직 확인되지 않았습니다.');
        return root;
      }
      if (status === 'ok') {
        const summary = explanation?.data?.summary;
        if (typeof summary !== 'string' || !summary.trim()) {
          show('AI 사건 설명 결과를 확인할 수 없습니다. 기록은 그대로 유지됩니다.');
          return root;
        }
        root.setAttribute('data-student-explanation-event', event.id);
        show('사건 ID: ' + event.id);
        show('AI 사건 설명 요약: ' + summary);
        return root;
      }
      if (status === 'idle') {
        show('사건 ID: ' + event.id);
        show('AI 사건 설명은 아직 실행하지 않았습니다. 보안 기록의 「AI 설명 요청」을 직접 눌러야 합니다.');
        return root;
      }
      show('AI 사건 설명 상태를 확인할 수 없습니다. 기록은 그대로 유지됩니다.');
      return root;
    },
    renderAction() { return '학생 구현 대기: 현재 사건·조치·실제 대상·사람 확인·ACK와 원천 효과·unknown을 구분하세요.'; },
  };
}
