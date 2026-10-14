// Render only the server's redacted, fixed-shape observation contract.
// All notes remain in the pre-existing authenticated workspace; never touch note bodies here.
const doc = document;
const byId = id => doc.getElementById(id);
const $ = (tag, cls, value) => {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  if (value !== undefined) el.textContent = String(value);
  return el;
};
const cases = [
  [1,'normal','공개 가상 자료 조회','GET /data.json','당시 공개 샘플을 정상 조회',null],
  [1,'forbidden','실제 학생 자료 접근','GET 실제 개인 메모','원본 민감정보를 공개하지 않음',null],
  [2,'normal','정적 자료 비노출','GET /data.json','현행 배포에서 빈 공개 자료 확인','static_redaction'],
  [2,'forbidden','이전 공개 API 재검증','GET /api/notes','과거 단계의 공개 약점 여부는 해당 배포에서 확인 필요',null],
  [3,'normal','로그인 후 메모 조회','GET /api/notes','유효한 세션과 본인 소유권 확인',null],
  [3,'forbidden','무로그인 메모 조회','GET /api/notes','401 UNAUTHORIZED','anonymous_notes'],
  [4,'normal','소유자 메모 변경','PUT /api/notes/:id','본인 소유 메모만 허용',null],
  [4,'forbidden','타인 메모 변경','PUT /api/notes/:id','타인 소유 메모 변경 거부',null],
  [5,'normal','인증된 자료 API 읽기','GET /api/notes','HTTP 200 및 memo 영역','authenticated_notes'],
  [5,'forbidden','원본 Data API 우회','GET /rest/v1/learning_notes','직접 테이블 접근 거부',null],
  [6,'normal','등록된 기기 읽기','GET /notes/:id','등록 사실을 엔진이 확인하면 allow',null],
  [6,'forbidden','미등록 기기 읽기','GET /notes/:id','device_not_registered / deny',null],
  [7,'normal','추가 인증 완료','GET /notes/:id','신뢰된 추가 인증 성공 시 allow',null],
  [7,'forbidden','위험 신호 확인 요구','GET /notes/:id','검증 안 된 추가 인증은 step_up',null],
  [8,'normal','소유 자원 접근','GET /api/notes/:id','서버에서 소유권 재검사 후 허용',null],
  [8,'forbidden','강사 공지 수정 시도','PUT /api/announcements/:id','학생의 공지 수정 차단',null],
  [9,'normal','임계값 이하 탐지','엔진 검증 GET 사건','10분 120건 이하는 observe',null],
  [9,'forbidden','과도한 조회','엔진 검증 GET 사건','10분 120건 초과 회수 제안, 실제 집행은 별도',null],
  [10,'normal','검증 백업 복구','POST /api/restore/notes/:id','실복구·읽기 재확인 필요',null],
  [10,'forbidden','무인증 복구 시도','GET /api/restore/notes/:id','인증 거부 또는 준비 전 보류','anonymous_restore'],
  [11,'normal','11단계 정상 요청','공식 계약 확인 필요','Git 저장소에서 11단계 계약을 확인하지 못함',null],
  [11,'forbidden','11단계 금지 요청','공식 계약 확인 필요','기대 판정 미확인 — 검증 불가',null],
].map(([stage,mode,title,request,expected,probeId],i)=>({
  id:'S'+String(stage).padStart(2,'0')+'-'+mode+'-'+String(i).padStart(2,'0'),
  stage,mode,title,request,expected,probeId,
}));
const fmtTime = value => {
  if (!value) return '미기록';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}) : '미기록';
};
const modeLabel = mode => mode === 'normal' ? '정상' : '금지';
const outcomeLabel = status => ({
  verified:'HTTP 일치',failed:'응답 불일치',inconclusive:'판정 보류',unrun:'미실행'
})[status] || '미실행';
function dataCell(tr, cls, value) { tr.append($('td',cls,value)); }
function chart(snapshot, onFilter) {
  const svg=byId('outcomes-chart');
  svg.replaceChildren();
  const total=['verified','failed','inconclusive','unrun'].map(x=>snapshot.summary[x]);
  const labels=['HTTP 일치','불일치','보류','미실행'];
  const colors=['#a1dbd1','#df8e8e','#e2ad72','#71848f'];
  const max=Math.max(1,...total);
  svg.setAttribute('viewBox','0 0 580 240');
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label',labels.map((v,i)=>v+' '+total[i]+'건').join(', '));
  const NS='http://www.w3.org/2000/svg';
  const element=(tag,attrs={},content)=>{const el=doc.createElementNS(NS,tag);
    for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));
    if(content!==undefined)el.textContent=content;return el;};
  for(let j=0;j<=4;j++){
    const y=181-j*39;
    svg.append(element('line',{x1:39,y1:y,x2:566,y2:y,stroke:'#34434d','stroke-width':'.75'}));
    svg.append(element('text',{x:7,y:y+4,fill:'#71848f','font-size':'11','font-family':'monospace'},String(Math.round(max*j/4))));
  }
  total.forEach((count,i)=>{
    const x=73+i*125, h=count/max*155, y=181-h;
    const g=element('g',{class:'bar-column',role:'button',tabindex:'0','aria-label':labels[i]+' '+count+'건 — 표 필터 적용'});
    g.append(element('rect',{x,y,width:72,height:h,fill:colors[i],rx:2}));
    g.append(element('text',{x:x+36,y:Math.max(13,y-12),fill:colors[i],'text-anchor':'middle','font-size':'13','font-family':'monospace'},String(count)));
    g.append(element('text',{x:x+36,y:216,fill:'#9daeb6','text-anchor':'middle','font-size':'12'},labels[i]));
    g.append(element('title',{},labels[i]+' '+count+'건 · 선택하면 증적 표를 필터링'));
    const pick=()=>onFilter(['verified','failed','inconclusive','unrun'][i]);
    g.addEventListener('click',pick);
    g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick();}});
    svg.append(g);
  });
}
export function initOperations({getToken=()=>null}={}) {
  let snapshot=null;
  const stage=byId('filter-stage'),kind=byId('filter-kind'),outcome=byId('filter-state');
  const table=byId('evidence-body');
  const count=byId('table-count');
  function rows() {
    const records=new Map(snapshot?.records.map(x=>[x.id,x])||[]);
    const filtered=cases.filter(c=>(stage.value==='all'||String(c.stage)===stage.value)
      &&(kind.value==='all'||kind.value===c.mode)
      &&(outcome.value==='all'||outcome.value===(records.get(c.probeId)?.outcome||'unrun')));
    table.replaceChildren();
    for(const c of filtered){
      const r=records.get(c.probeId);
      const state=r?.outcome||'unrun';
      const tr=$('tr');
      dataCell(tr,'',c.stage.toString().padStart(2,'0'));
      dataCell(tr,'',modeLabel(c.mode));
      dataCell(tr,'',c.title+' — '+c.request);
      dataCell(tr,'',c.expected);
      dataCell(tr,state==='unrun'?'status-unrun':'status-'+state,
        r?.httpStatus===null||r===undefined?'미실행':('HTTP '+r.httpStatus+(r.errorCode?' '+r.errorCode:'')));
      dataCell(tr,'status-'+state,outcomeLabel(state));
      dataCell(tr,'data-mono',r?.requestId||'미제공');
      dataCell(tr,'data-mono',fmtTime(r?.checkedAt));
      table.append(tr);
    }
    count.textContent=filtered.length+' / '+cases.length+' 항목 · 현재 배포만 관측';
  }
  function showRecords(records){
    const root=byId('ops-records');
    root.replaceChildren();
    for(const r of records){
      const article=$('article','record');
      const line=$('div','record-line');
      line.append($('code','',r.method+' '+r.path));
      line.append($('span','status-'+r.outcome,outcomeLabel(r.outcome)));
      if(r.httpStatus!==null)line.append($('code','',String(r.httpStatus)));
      const meta=$('p','record-meta',
        'HTTP 식별자 '+(r.requestId||'미제공')+'  ·  '+fmtTime(r.checkedAt)
        +(r.errorCode?'  ·  '+r.errorCode:''));
      article.append(line,meta);root.append(article);
    }
  }
  function render(x) {
    const counts={verified:0,failed:0,inconclusive:0,unrun:0};
    for(const r of x.records) if(Object.hasOwn(counts,r.outcome)) counts[r.outcome]++;
    const good=Object.entries(counts).every(([k,v])=>v===x.summary[k]);
    if(!good)throw Error('SERVER_RECORD_COUNT_MISMATCH');
    snapshot=x;
    byId('metric-observed').textContent=String(x.summary.httpCount);
    byId('metric-verified').textContent=String(x.summary.verified);
    byId('metric-stages').textContent=String(x.verdict.stagesVerified);
    byId('metric-attacks').textContent=String(x.verdict.attackTypesVerified);
    byId('ops-target').textContent=x.target||'미확인';
    byId('ops-commit').textContent=x.deployCommit?.slice(0,12)||'미확인';
    byId('ops-time').textContent=fmtTime(x.records.map(r=>r.checkedAt).filter(Boolean).sort().at(-1));
    byId('ops-rules').replaceChildren(...x.policy.rules.map(k=>$('span','chip',k)));
    byId('ops-detection').textContent=x.detection.condition;
    byId('ops-revocation').textContent=x.revocation.executed===true?'회수 집행 증거 필요':'실제 집행 미검증';
    byId('ops-recovery').textContent=x.recovery.restoredVersion||'운영 복구 버전 미검증';
    byId('ops-info').textContent= '서버 HTTP '+x.summary.httpCount+'건 · 불일치 '+x.summary.failed+'건 · 판정보류 '+x.summary.inconclusive+'건';
    byId('ops-state').textContent= '실측 관측 완료 · 공식 심판 판정 별도';
    byId('ops-state').classList.remove('status-failed');
    chart(x,value=>{outcome.value=value;rows();byId('evidence').scrollIntoView({block:'start',behavior:'smooth'});});
    showRecords(x.records);
    rows();
  }
  async function refresh(){
    const button=byId('ops-refresh');
    button.disabled=true;button.classList.add('loading');
    byId('ops-state').textContent='HTTP 관측 중 · 완료 전 수치 변경 없음';
    try {
      const token=getToken();
      const headers={Accept:'application/json'};
      if(typeof token==='string'&&token)headers.Authorization='Bearer '+token;
      const response=await fetch('/api/ops',{method:'GET',headers,cache:'no-store',redirect:'error'});
      if(!response.ok)throw Error('HTTP_'+response.status);
      const body=await response.json();
      if(body.schema!=='aleph.operations.snapshot.v1'||!Array.isArray(body.records)
         ||!body.summary||!body.verdict||body.verdict.attackTypesRequired!==41
         ||body.verdict.stagesRequired!==12)throw Error('INVALID_EVIDENCE_CONTRACT');
      render(body);
    }catch(error){
      byId('ops-state').textContent='증거 조회 실패 ('+String(error.message).slice(0,80)+') — 이전 관측을 새 결과로 취급하지 않음';
      byId('ops-state').classList.add('status-failed');
      if(!snapshot){byId('metric-observed').textContent='—';byId('metric-verified').textContent='—';}
    }finally{button.disabled=false;button.classList.remove('loading');}
  }
  for(const item of [stage,kind,outcome])item.addEventListener('change',rows);
  byId('ops-refresh').addEventListener('click',refresh);
  byId('ops-export').addEventListener('click',()=>{
    if(!snapshot)return;
    const data=JSON.stringify(snapshot,null,2)+'\n';
    const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
    const a=$('a');a.href=url;a.download='aleph-operations-redacted.json';a.click();
    URL.revokeObjectURL(url);
  });
  byId('ops-reset').addEventListener('click',()=>{stage.value='all';kind.value='all';outcome.value='all';rows();});
  window.addEventListener('aleph:session',refresh);
  rows();refresh();
}
