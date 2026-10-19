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
    renderEvents() { return '학생 구현 대기: 본인 접속·XDR 기록을 연결하세요.'; },
    renderStatus() { return '학생 구현 대기: 기기·세션·알림과 연결 점검 상태를 구분하세요.'; },
    renderVulnerabilities() { return '학생 구현 대기: 정확한 설치 버전·OSV 출처·조회 시각·부분 결과·조회 실패를 구분하세요.'; },
    renderAiConnection() { return '학생 구현 대기: 모델 응답 점검과 실제 사건 설명을 구분하고 AI 오류·취소·수동 복구를 안내하세요.'; },
    renderExplanation() { return '학생 구현 대기: 선택한 사건의 근거·규칙·현재 상태와 AI 설명을 연결하세요. 제안은 자동 실행하지 않습니다.'; },
    renderAction() { return '학생 구현 대기: 현재 사건·조치·실제 대상·사람 확인·ACK와 원천 효과·unknown을 구분하세요.'; },
  };
}
