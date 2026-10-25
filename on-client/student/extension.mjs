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
    renderVulnerabilities({ status = 'idle', mode, data, error } = {}) {
      const root = document.createElement('section');
      const message = (parent, text) => {
        const p = document.createElement('p');
        p.textContent = text;
        parent.append(p);
      };
      const field = (parent, name, value) => {
        if (value === null || value === undefined || value === '') return;
        const dt = document.createElement('dt');
        dt.textContent = name;
        const dd = document.createElement('dd');
        dd.textContent = String(value);
        parent.append(dt, dd);
      };
      const modes = {
        connected: '연결됨(connected)',
        demo: '예제 자료(demo) · 실제 프로젝트 조회가 아닙니다.',
        disconnected: '연결 없음(disconnected)',
        unknown: '확인 불가(unknown)',
      };
      if (Object.hasOwn(modes, mode)) message(root, '조회 모드: ' + modes[mode]);

      // 호출마다 빈 DOM을 새로 만든다. 진행 중·실패에는 이전 성공 표나 결과를 재사용하지 않는다.
      if (status === 'idle') {
        message(root, '설치 패키지 취약점 조회 전(idle)입니다.');
        return root;
      }
      if (status === 'loading') {
        message(root, '설치 패키지 취약점 조회 중(loading)입니다. 아직 조회 결과가 아닙니다.');
        return root;
      }
      if (status === 'error') {
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
          ? error.code : null;
        const raw = error?.message;
        const sensitive = /(?:Bearer\s+\S+|\b(?:sk-|sb_)[A-Za-z0-9_-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|authorization|password|비밀번호|토큰)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,})/iu;
        const detail = typeof raw === 'string' && raw.trim() && raw.length <= 400
          && !sensitive.test(raw) && !/[\u0000-\u001f]/u.test(raw)
          ? raw : '안전한 오류 메시지를 확인할 수 없습니다.';
        message(root, '설치 패키지 취약점 조회 실패(error): ' + detail);
        if (code) message(root, '오류 코드: ' + code);
        message(root, '조회 실패는 취약점이 없다는 뜻이 아닙니다. 이전 결과는 현재 조회 결과가 아닙니다.');
        message(root, '다시 조회하려면 제공 화면의 「설치 패키지 조회」 버튼을 직접 누르세요. 자동 재요청은 하지 않습니다.');
        return root;
      }

      const scanLabels = {
        complete: '모두 조회(complete) · 승인된 공개 조회 대상의 조회가 완료됐습니다.',
        partial: '일부 조회 실패(partial) · 확인된 결과만 표시하며 전체 조회 완료로 보지 않습니다.',
        not_checked: '아직 조회 안 함(not_checked) · 승인된 공개 조회 대상 패키지가 없습니다.',
        not_configured: '조회 준비 미완료(not_configured) · 조회 대상 프로젝트 설정이 필요합니다.',
        unverifiable: '잠금 파일 확인 불가(unverifiable) · 설치 목록과 버전을 검증할 수 없습니다.',
      };
      if (status !== 'ok' || data == null || !Object.hasOwn(scanLabels, data.status)
          || !Array.isArray(data.packages)) {
        message(root, '패키지 조회 상태 또는 응답 형식을 확인할 수 없습니다. 현재 결과로 표시하지 않습니다.');
        return root;
      }
      message(root, '전체 조회 상태: ' + scanLabels[data.status]);
      const meta = document.createElement('dl');
      field(meta, 'lockfileVersion', data.lockfileVersion);
      field(meta, 'lockfileHash', data.lockfileHash);
      field(meta, 'checkedAt', data.checkedAt);
      if (meta.childNodes.length) root.append(meta);

      if (data.packages.length === 0) {
        message(root, '현재 표시할 패키지 조회 결과가 없습니다. 미조회 또는 결과 없음은 취약점이 없다는 증거가 아닙니다.');
        return root;
      }

      // 제공 화면에서 검증된 설치 버전을 다시 가공하거나 버전 범위를 설치값으로 치환하지 않는다.
      const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
      const packageLabels = {
        known_vulnerabilities: '알려진 항목 있음(known_vulnerabilities)',
        none_found: '조회 범위에서 알려진 항목 없음(none_found)',
        unverifiable: '조회 확인 불가(unverifiable)',
      };
      const valid = data.packages.every((pkg) => typeof pkg?.name === 'string' && pkg.name.trim()
        && typeof pkg.version === 'string' && exactVersion.test(pkg.version)
        && Object.hasOwn(packageLabels, pkg.status) && Array.isArray(pkg.vulnerabilities)
        && typeof pkg.source === 'string' && typeof pkg.checkedAt === 'string'
        && pkg.vulnerabilities.every((v) => typeof v?.id === 'string'
          && typeof v.modified === 'string'));
      if (!valid) {
        message(root, '설치 패키지 버전이나 OSV 조회 결과를 확인할 수 없습니다. ^1.2.0 같은 범위를 실제 설치 버전으로 표시하지 않습니다.');
        return root;
      }

      const table = document.createElement('table');
      const caption = document.createElement('caption');
      caption.textContent = '승인된 공개 패키지의 설치 버전과 OSV 조회 결과';
      table.append(caption);
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['패키지', '설치 버전', '조회 상태', '출처', '패키지 확인 시각', '취약점 ID·수정 시각']) {
        const th = document.createElement('th');
        th.textContent = label;
        th.setAttribute('scope', 'col');
        headRow.append(th);
      }
      head.append(headRow);
      table.append(head);
      const body = document.createElement('tbody');
      const cell = (row, text) => {
        const td = document.createElement('td');
        td.textContent = text;
        row.append(td);
        return td;
      };
      for (const pkg of data.packages) {
        const row = document.createElement('tr');
        row.setAttribute('data-student-package-name', pkg.name);
        row.setAttribute('data-student-package-version', pkg.version);
        cell(row, pkg.name);
        cell(row, pkg.version);
        const partialFindings = pkg.status === 'unverifiable' && pkg.vulnerabilities.length > 0;
        cell(row, packageLabels[pkg.status]
          + (partialFindings ? ' · 일부 확인·전체 조회 확인 불가' : ''));
        cell(row, pkg.source);
        cell(row, pkg.checkedAt);
        const vulns = document.createElement('td');
        if (pkg.vulnerabilities.length > 0) {
          const entries = document.createElement('ul');
          for (const item of pkg.vulnerabilities) {
            const li = document.createElement('li');
            li.textContent = 'ID: ' + item.id + ' · modified(수정 시각): ' + item.modified;
            entries.append(li);
          }
          vulns.append(entries);
        } else if (pkg.status === 'none_found') {
          message(vulns, '해당 버전의 OSV 조회 범위에서 알려진 취약점 항목이 없습니다. 안전하다는 보장은 아닙니다.');
        } else if (pkg.status === 'unverifiable') {
          message(vulns, '전체 조회 확인 불가 · 알려진 취약점이 없다고 판단할 수 없습니다.');
        } else {
          message(vulns, '취약점 상세 결과를 확인할 수 없습니다.');
        }
        row.append(vulns);
        body.append(row);
      }
      table.append(body);
      root.append(table);
      message(root, 'OSV는 알려진 취약점 데이터베이스입니다. 조회 결과만으로 패키지나 앱 전체의 안전을 보장할 수 없습니다.');
      return root;
    },
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
      const show = (parent, text) => {
        const p = document.createElement('p');
        p.textContent = text;
        parent.append(p);
      };
      const heading = (title) => {
        const h = document.createElement('h3');
        h.textContent = title;
        root.append(h);
      };
      const failure = (why, code = 'ON_AI_INVALID_OUTPUT') => {
        show(root, 'AI 설명 확인 불가 · 코드: ' + code + ' · ' + why);
        show(root, '기록은 그대로입니다. 근거가 부족하거나 일치하지 않는 설명을 성공으로 표시하지 않습니다.');
        return root;
      };
      const status = explanation?.status ?? 'idle';
      // 실제 사건이 선택되지 않았더라도 서버 오류부터 구분해 표시한다.
      if (status === 'error') {
        const knownCodes = new Set([
          'ON_AI_PROVISIONING_PENDING', 'WB_CLCO_AUTH_REQUIRED', 'WB_CLCO_ACCESS_BLOCKED',
          'WB_CLCO_COHORT_BUDGET_EXHAUSTED', 'WB_CLCO_RATE_LIMITED', 'WB_CLCO_LIMIT_REACHED',
          'WB_CLCO_SESSION_CLOSED', 'WB_CLCO_TIMEOUT', 'REQUEST_TIMEOUT', 'ENGINE_TIMEOUT',
          'TIMEOUT', 'WB_CLCO_CANCELLED', 'CANCELLED', 'REQUEST_CANCELLED',
          'MODEL_NOT_CONFIGURED', 'ON_AI_AUTHORIZATION_CHANGED', 'ON_AI_MODEL_LIST_EMPTY',
          'SUBJECT_SCOPE_UNVERIFIED', 'ON_AI_INVALID_INPUT', 'ON_AI_INVALID_OUTPUT',
          'AI_REQUEST_UNVERIFIED',
        ]);
        const code = knownCodes.has(explanation?.error?.code)
          ? explanation.error.code : 'AI_REQUEST_UNVERIFIED';
        const raw = explanation?.error?.message;
        const secret = /(?:Bearer\s+\S+|\b(?:sk-|sb_)[A-Za-z0-9_-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|authorization|password|비밀번호|토큰)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,})/iu;
        const message = typeof raw === 'string' && raw.trim() && raw.length <= 400
          && !secret.test(raw) && !/[\u0000-\u001f]/u.test(raw)
          ? raw : '안전한 오류 메시지를 확인할 수 없습니다.';
        show(root, 'AI 설명 실패: ' + code + ' · ' + message);
        if (['ON_AI_INVALID_INPUT', 'ON_AI_INVALID_OUTPUT'].includes(code)) {
          show(root, '사건 근거 부족, 인용 근거 ID 불일치 또는 설명 결과 형식을 확인할 수 없습니다.');
        }
        show(root, '기록은 그대로입니다. AI 설명 실패는 업무 앱 판정이나 과제 실패가 아닙니다.');
        return root;
      }
      if (typeof event?.id !== 'string' || !event.id.trim()) {
        show(root, '보안 기록에서 기록을 먼저 고르세요. AI 설명은 아직 실행하지 않았습니다.');
        return root;
      }
      if (status === 'loading') {
        show(root, '사건 ID: ' + event.id);
        show(root, 'AI 설명 요청 중입니다. 결과는 아직 확인되지 않았습니다.');
        return root;
      }
      if (status !== 'ok') {
        show(root, '사건 ID: ' + event.id);
        show(root, status === 'idle'
          ? 'AI 설명은 아직 실행하지 않았습니다. 보안 기록에서 「AI 설명 요청」을 직접 누르세요.'
          : 'AI 설명 상태를 확인할 수 없습니다. 이전 결과는 현재 설명이 아닙니다.');
        return root;
      }

      const result = explanation?.data;
      if (result?.executed !== false) {
        return failure(result?.executed === true
          ? 'AI가 이미 실행했다고 표시한 설명은 사용할 수 없습니다. 보안 조치 완료로 인정하지 않습니다.'
          : '설명의 미실행 여부를 확인할 수 없습니다.');
      }
      if (result.requiresHumanConfirmation !== true) {
        return failure('사람 확인 필요 여부가 명확하지 않아 설명을 사용할 수 없습니다.');
      }
      if (typeof result.summary !== 'string' || !result.summary.trim()) {
        return failure('요약이 없어 AI 설명을 사용할 수 없습니다.');
      }
      if (!Array.isArray(event.evidence) || !event.evidence.length) {
        return failure('선택한 기록에 근거가 부족합니다.', 'ON_AI_INVALID_INPUT');
      }
      if (!Array.isArray(event.rules) || !event.rules.length
          || event.rules.some((rule) => typeof rule?.id !== 'string' || !rule.id
            || typeof rule.text !== 'string')) {
        return failure('선택한 기록의 규칙 ID와 규칙 글을 확인할 수 없습니다.', 'ON_AI_INVALID_INPUT');
      }

      const evidence = new Map();
      for (const item of event.evidence) {
        if (typeof item?.id !== 'string' || !item.id || typeof item.text !== 'string'
            || evidence.has(item.id)) {
          return failure('근거 ID·근거 글이 누락되었거나 근거 ID가 중복되었습니다.', 'ON_AI_INVALID_INPUT');
        }
        evidence.set(item.id, item.text);
      }
      const references = result.evidenceIds;
      if (!Array.isArray(references) || references.length !== evidence.size
          || new Set(references).size !== references.length
          || references.some((id) => typeof id !== 'string' || !evidence.has(id))) {
        return failure('AI가 인용한 근거 ID가 선택한 사건의 근거와 일치하지 않습니다. 근거를 만들어 내지 않습니다.');
      }
      if (!event.state || !['access', 'session', 'device'].every(
        (key) => typeof event.state[key] === 'string')) {
        return failure('접속·세션·기기 상태를 확인할 수 없습니다.', 'ON_AI_INVALID_INPUT');
      }
      if (!Array.isArray(event.supportedActions) || !Array.isArray(result.proposals)) {
        return failure('연동 시스템의 지원 조치 또는 AI 제안 형식을 확인할 수 없습니다.');
      }
      const proposalsValid = result.proposals.every((proposal) =>
        typeof proposal?.action === 'string' && event.supportedActions.includes(proposal.action)
        && typeof proposal.reason === 'string' && proposal.reason.trim()
        && Array.isArray(proposal.evidenceIds) && proposal.evidenceIds.length > 0
        && new Set(proposal.evidenceIds).size === proposal.evidenceIds.length
        && proposal.evidenceIds.every((id) => evidence.has(id) && references.includes(id)));
      if (!proposalsValid) {
        return failure('제안된 조치가 지원 목록에 없거나 제안의 근거 ID가 현재 사건과 맞지 않습니다.');
      }

      // 모든 검증을 통과한 현재 선택 사건에만 성공 속성을 부여한다.
      root.setAttribute('data-student-explanation-event', event.id);
      heading('AI 설명(참고용)');
      show(root, '사건 ID: ' + event.id);
      show(root, 'AI 요약: ' + result.summary);
      show(root, 'AI 요약은 해석입니다. 사실 판단은 사건 근거·규칙과 연동 시스템 상태를 따릅니다.');

      heading('인용한 근거');
      const evidenceList = document.createElement('ul');
      for (const id of references) {
        const li = document.createElement('li');
        li.textContent = id + ' — ' + evidence.get(id);
        evidenceList.append(li);
      }
      root.append(evidenceList);

      heading('적용 규칙');
      const ruleList = document.createElement('ul');
      for (const rule of event.rules) {
        const li = document.createElement('li');
        li.textContent = rule.id + ' — ' + rule.text;
        ruleList.append(li);
      }
      root.append(ruleList);

      heading('확인 불가 상태');
      const unknown = document.createElement('ul');
      const stateNames = { access: '접속', session: '세션', device: '기기' };
      for (const key of ['access', 'session', 'device']) {
        if (event.state[key] === 'unknown') {
          const li = document.createElement('li');
          li.textContent = stateNames[key] + ': 확인 불가(unknown)';
          unknown.append(li);
        }
      }
      if (unknown.childNodes.length) root.append(unknown);
      else show(root, '없음');

      heading('AI 조치 제안');
      if (!result.proposals.length) {
        show(root, event.supportedActions.length === 0
          ? '연동 시스템이 지원하는 조치가 없어 제안이 없습니다(정상).'
          : 'AI가 이 기록에 제안한 조치가 없습니다.');
      } else {
        const proposals = document.createElement('ul');
        for (const proposal of result.proposals) {
          const li = document.createElement('li');
          li.textContent = '조치: ' + proposal.action + ' · 이유: ' + proposal.reason
            + ' · 근거 ID: ' + proposal.evidenceIds.join(', ')
            + ' · 사람 확인이 필요하며 아직 실행되지 않았습니다.';
          proposals.append(li);
        }
        root.append(proposals);
      }
      show(root, 'AI 설명과 제안만으로 보안 조치는 실행되지 않습니다.');
      return root;
    },
    renderAction({ status = 'idle', event, actionId, target, receipt, observation, message,
      confirmationExpiresAt, error } = {}) {
      const root = document.createElement('section');
      const show = (value) => {
        const p = document.createElement('p');
        p.textContent = value;
        root.append(p);
      };
      const field = (name, value) => {
        if ((typeof value !== 'string' || !value.trim()) && !Number.isFinite(value)) return;
        show(name + ': ' + value);
      };
      const sensitive = /(?:Bearer\s+\S+|\b(?:sk-|sb_)[A-Za-z0-9_-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|authorization|password|비밀번호|토큰)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,})/iu;
      const safeMessage = (value) => typeof value === 'string' && value.trim()
        && value.length <= 500 && !sensitive.test(value) && !/[\u0000-\u001f]/u.test(value)
        ? value : null;
      const messages = {
        idle: '아직 미실행(idle): 조치 준비 또는 집행을 요청하지 않았습니다.',
        loading: '조치 준비 또는 원천 결과 조회 중(loading) · 처리 완료나 효과 확인이 아닙니다.',
        prepared: '조치 준비됨·미실행(prepared): 실제 대상과 확인 기한을 검토해야 합니다.',
        executing: '사람 확인 후 서버에 전달 중(executing) · 접수 및 실제 효과는 아직 확인되지 않았습니다.',
        pending: '서버 접수·처리 중(pending) · ACK는 요청 접수 사실이며 조치 효과 확인이 아닙니다.',
        denied: '원천 정책에 따라 거절됨(denied) · 조치 효과를 확인한 상태가 아닙니다.',
        failed: '원천 처리 실패(failed) · 조치 효과를 확인하지 못했습니다.',
        unknown: '결과 불명(unknown) · 성공이나 효과 없음으로 판단하지 마세요.',
        expired: '확인 기한 만료(expired) · 해당 준비로는 집행할 수 없습니다. 현재 기록에서 다시 준비하세요.',
        error: '요청이 처리되지 않았습니다(error) · 서버 오류를 확인하세요.',
      };
      const code = typeof error?.code === 'string' && [
        'ACTION_UNSUPPORTED', 'ACTION_DENIED', 'ACTION_CONFIRMATION_EXPIRED',
        'ACTION_CONFIRMATION_INVALID', 'ACTION_SCOPE_CHANGED', 'ACTION_SCOPE_UNVERIFIED',
        'SUBJECT_SCOPE_UNVERIFIED', 'ACTION_SNAPSHOT_CHANGED', 'ACTION_EVENT_UNAVAILABLE',
        'ACTION_TIMEOUT', 'ACTION_STORE_FAILED', 'ACTION_RESULT_UNVERIFIED',
      ].includes(error.code) ? error.code : 'ACTION_RESULT_UNVERIFIED';

      // 새 호출마다 새 DOM만 만들며, idle에는 옛 사건·대상·영수증을 남기지 않는다.
      if (status === 'idle') {
        show(messages.idle);
        if (safeMessage(message)) show('현재 안내: ' + safeMessage(message));
        show('「조치 화면 취소」는 이미 서버에 전달된 조치의 실제 효과를 되돌리지 않습니다.');
        return root;
      }
      const eventId = typeof event?.id === 'string' && event.id.trim() ? event.id : null;
      const currentActionId = typeof actionId === 'string' && actionId.trim() ? actionId : null;
      const requestId = typeof receipt?.requestId === 'string' && receipt.requestId.trim()
        ? receipt.requestId : null;
      const inconsistent = (receipt?.eventId != null && eventId !== receipt.eventId)
        || (receipt?.actionId != null && currentActionId !== receipt.actionId)
        || (receipt?.target?.id != null && target?.id !== receipt.target.id)
        || (receipt?.target?.generation != null && target?.generation !== receipt.target.generation);
      if (inconsistent) {
        show('결과 불명(unknown): 응답의 사건·조치·대상 정보가 현재 선택한 요청과 일치하지 않습니다.');
        show('기존 응답을 현재 사건의 성공으로 표시하지 않습니다. 「원천 결과만 재조회」로 확인하세요.');
        return root;
      }

      const effectConfirmed = status === 'succeeded'
        && observation?.effectApplied === true
        && typeof observation.observedAt === 'string' && observation.observedAt.trim()
        && Number.isFinite(Date.parse(observation.observedAt))
        && typeof receipt?.receiptId === 'string' && receipt.receiptId.trim()
        && receipt.superseded !== true
        && (receipt.status == null || receipt.status === 'succeeded');

      if (status === 'succeeded') {
        show(effectConfirmed
          ? '연동 시스템 효과 확인(succeeded) · 실제 원천 관측에 따른 결과입니다.'
          : '결과 불명(unknown): succeeded 상태를 받았지만 실제 효과·관측 시각·영수증을 확인할 수 없습니다.');
      } else {
        show(Object.hasOwn(messages, status)
          ? messages[status]
          : '조치 상태 확인 불가(unknown) · 성공이나 효과 없음으로 판단하지 마세요.');
      }

      if (eventId) root.setAttribute('data-student-action-event', eventId);
      if (requestId) root.setAttribute('data-student-action-request', requestId);
      field('사건 ID', eventId);
      if (Array.isArray(event?.evidence) && event.evidence.length) {
        const ids = event.evidence.filter((row) => typeof row?.id === 'string'
          && row.id.trim()).map((row) => row.id);
        if (ids.length) field('근거 ID', ids.join(', '));
      }
      field('조치 ID', currentActionId);
      field('실제 대상 ID', target?.id);
      field('대상 세대(generation)', target?.generation);
      field('요청 ID(requestId)', requestId);
      field('영수증 ID(receiptId)', receipt?.receiptId);
      field('영수증 버전(version)', receipt?.version);

      if (status === 'prepared') {
        field('사람 확인 기한', confirmationExpiresAt);
        show('아직 실행되지 않았습니다. 제공 화면에서 대상과 조치를 확인한 뒤에만 집행을 요청할 수 있습니다.');
      }
      if (receipt?.replayed === true) {
        show('중복 응답(replayed: true): 기존 requestId에 대한 응답입니다. 새로운 조치 집행의 증거가 아닙니다.');
      }
      if (receipt?.superseded === true) {
        show('이전 응답(superseded): 최신 원천 결과를 대신하지 않습니다.');
      }
      if (effectConfirmed) {
        field('실제 효과 관측 시각(observedAt)', observation.observedAt);
        show('effectApplied: true');
      } else if (status === 'succeeded' || status === 'unknown') {
        show('조치 효과가 없다고 단정할 수 없습니다. 제공 화면의 「원천 결과만 재조회」로 직접 확인하세요.');
      }
      if (status === 'pending' || status === 'executing' || status === 'loading') {
        show('현재 응답은 집행 완료 또는 효과 확인 결과가 아닙니다.');
      }
      if (status === 'denied' || status === 'failed') {
        if (safeMessage(message)) field('연동 시스템 안내', safeMessage(message));
      }
      if (status === 'error' || (error && ['denied', 'failed', 'unknown', 'expired'].includes(status))) {
        field('오류 코드', code);
        field('오류 메시지', safeMessage(error?.message) || '안전한 오류 메시지를 확인할 수 없습니다.');
      }
      if (status === 'unknown') {
        show('이미 전달된 조치에 대해 효과 없음이나 성공을 추정하지 않고, 결과만 다시 조회하세요.');
      }
      if (status === 'expired') {
        show('만료된 확인 정보는 다시 사용하지 말고 새로운 조치 준비부터 확인하세요.');
      }
      if (Array.isArray(event?.supportedActions) && event.supportedActions.length === 0) {
        show('이 기록은 연동 시스템에서 지원하는 조치가 없어 조치 준비 버튼이 나오지 않는 것이 정상입니다.');
      }
      show('이 학생 화면은 조치 요청을 보내지 않습니다. 조치 확인·전달·재조회는 제공 화면에서만 진행됩니다.');
      return root;
    },
  };
}
