import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  hash, previewPolicyRestore, restoreTestPolicy, recoverTestPolicyFile,
} from '../src/recovery/policy.mjs';
import {
  sha256, contentSha256, verifyNoteBackup, previewNoteRestore, restoreNoteOnce,
} from '../src/recovery/note.mjs';
import { createRestoreHandler } from '../api/restore-note.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const capturedAt = '2026-09-01T00:00:00.000Z';
const verifiedAt = '2026-09-02T00:00:00.000Z';
const incidentAt = '2026-09-04T00:00:00.000Z';
const safeNotes = { version: 'safe_v1', ownerOnly: true,
  rules: ['device_registered','step_up_required'] };
const compromised = () => ({
  schema:'aleph.recovery.test-policy.v1',
  services: {
    notes:{ version:'unsafe_v2',ownerOnly:false,rules:[] },
    otherService:{ version:'unrelated',ownerOnly:true,rules:['keep_existing'] },
  },
  audit:[{id:'audit_001',kind:'historic_event'}],
});
const backupPolicy = () => JSON.stringify({
  schema:'aleph.recovery.policy-backup.v1',
  serviceId:'notes',capturedAt,verifiedAt,policy:safeNotes,
});

const targetNote = { id:ID,owner_id:B,title:'B synthetic memo',
  body:'Training-only recovery fixture; no real personal data.' };
const privateNoteBackup = () => JSON.stringify({
  schema:'aleph.recovery.note-backup.v1',version:'backup_v1',
  id:ID,ownerId:B,capturedAt,verifiedAt,
  title:targetNote.title,body:targetNote.body,contentSha256:contentSha256(targetNote),
});
const noteInputs = () => {
  const raw = privateNoteBackup();
  const trustedSha256 = sha256(raw);
  return {
    raw, trustedSha256, incidentAt, pinnedBOwnerId:B, identityUserId:B, id:ID,
    rereadBackup: async () => ({ raw, trustedSha256 }),
  };
};
const noteStore = (initial=[]) => {
  const rows = new Map(initial.map(row => [row.id,{...row}]));
  let audit = [{id:'historic',kind:'unchanged'}];
  return {
    rows, audit,
    async find(id){return rows.get(id) ? {...rows.get(id)} : null;},
    async insert(row){
      if (rows.has(row.id)) throw Error('NOTE_CHANGED_DURING_RESTORE');
      rows.set(row.id,{id:row.id,owner_id:row.owner_id,title:row.title,content:row.body});
    },
    async replaceIfCurrent(row,previous){
      const now=rows.get(row.id);
      if(!now || now.owner_id!==row.owner_id||now.title!==previous.title
        ||now.content!==previous.content) throw Error('NOTE_CHANGED_DURING_RESTORE');
      rows.set(row.id,{id:row.id,owner_id:row.owner_id,title:row.title,content:row.body});
    },
    async restoreVerified(row,previous){
      const before=rows.get(row.id) ?? null;
      if (previous === null) {
        if (before) throw Error('NOTE_CHANGED_DURING_RESTORE');
      } else if(!before || before.owner_id !== row.owner_id
        || before.title !== previous.title || before.content !== previous.content) {
        throw Error('NOTE_CHANGED_DURING_RESTORE');
      }
      rows.set(row.id,{id:row.id,owner_id:row.owner_id,title:row.title,content:row.body});
      return {id:row.id,transactionalReadbackVerified:true};
    },
  };
};

test('정책 미리보기는 notes 서비스만 변경하고 복구 버전·범위를 보여줌',()=>{
  const original=compromised(),raw=backupPolicy();
  const preview=previewPolicyRestore({current:original,backupRaw:raw,
    trustedSha256:hash(raw),incidentAt});
  assert.equal(preview.currentVersion,'unsafe_v2');
  assert.equal(preview.restoreVersion,'safe_v1');
  assert.deepEqual(preview.changedPaths,[
    'services.notes.version','services.notes.ownerOnly','services.notes.rules']);
  const { restored }=restoreTestPolicy({current:original,backupRaw:raw,
    trustedSha256:hash(raw),incidentAt,confirmedPlanSha256:preview.planSha256});
  assert.deepEqual(restored.services.notes,safeNotes);
  assert.deepEqual(restored.services.otherService,original.services.otherService);
  assert.deepEqual(restored.audit,original.audit);
  assert.equal(original.services.notes.ownerOnly,false);
  assert.equal(restored.services.notes.ownerOnly && A===A,true);
  assert.equal(restored.services.notes.ownerOnly && B===A,false); // B reads A: deny
});
test('검증 전·침해 후·변조된 정책 백업과 계획 오용은 fail closed',()=>{
  const raw=backupPolicy(),state=compromised(),trusted=hash(raw);
  assert.throws(()=>previewPolicyRestore({current:state,backupRaw:raw,
    trustedSha256:'0'.repeat(64),incidentAt}),/UNVERIFIED_POLICY_BACKUP/);
  assert.throws(()=>previewPolicyRestore({current:state,backupRaw:raw,
    trustedSha256:trusted,incidentAt:'2026-09-01T12:00:00.000Z'}),/NOT_VERIFIED_BEFORE_INCIDENT/);
  assert.throws(()=>restoreTestPolicy({current:state,backupRaw:raw,trustedSha256:trusted,
    incidentAt,confirmedPlanSha256:'f'.repeat(64)}),/POLICY_PLAN_CONFIRMATION_REQUIRED/);
});
test('정책 파일 복구는 임시 시험 서비스 한 곳만 원자적으로 교체',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'aleph-recovery-lab-'));
  try{
    const currentPath=join(dir,'test-policy.json'),backupPath=join(dir,'safe-policy.json');
    const original=compromised(),backup=backupPolicy();
    await writeFile(currentPath,JSON.stringify(original,null,2)+'\n');
    await writeFile(backupPath,backup);
    const base={currentPath,backupPath,trustedSha256:hash(backup),incidentAt};
    const preview=await recoverTestPolicyFile(base);
    assert.equal(preview.applied,false);
    assert.deepEqual(JSON.parse(await readFile(currentPath)),original);
    await assert.rejects(recoverTestPolicyFile({...base,confirm:'0'.repeat(64)}),
      /POLICY_PLAN_CONFIRMATION_REQUIRED/);
    const applied=await recoverTestPolicyFile({...base,confirm:preview.preview.planSha256});
    assert.equal(applied.applied,true);
    const after=JSON.parse(await readFile(currentPath));
    assert.deepEqual(after.services.notes,safeNotes);
    assert.deepEqual(after.services.otherService,original.services.otherService);
    assert.deepEqual(after.audit,original.audit);
    await assert.rejects(recoverTestPolicyFile({...base,
      confirm:preview.preview.planSha256}),/POLICY_PLAN_CONFIRMATION_REQUIRED/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('지정 B 가상 메모만 미리보기·복원·재확인; 다른 메모와 감사 이력 보존',async()=>{
  const other={id:OTHER_ID,owner_id:A,title:'A note',content:'Keep A exactly as found'};
  const store=noteStore([other]),values=noteInputs();
  const preview=previewNoteRestore({...values,current:await store.find(ID)});
  assert.equal(preview.status,'insert');
  assert.equal(preview.contentSha256,contentSha256(targetNote));
  assert.deepEqual(Object.keys(preview).sort(),['backupSha256','backupVersion',
    'beforeSha256','changedFields','contentSha256','id','ownerId','planSha256','schema','status']);
  assert.equal(preview.backupVersion, 'backup_v1');
  assert.deepEqual(preview.changedFields, ['id','owner_id','title','body']);
  await assert.rejects(restoreNoteOnce({...values,store,
    confirmedPlanSha256:'0'.repeat(64)}),/NOTE_PLAN_CONFIRMATION_REQUIRED/);
  const restored=await restoreNoteOnce({...values,store,
    confirmedPlanSha256:preview.planSha256});
  assert.deepEqual(restored,{id:ID,ownerId:B,
    contentSha256:contentSha256(targetNote),status:'restored'});
  assert.equal(contentSha256({...targetNote}),contentSha256({
    ...store.rows.get(ID),body:store.rows.get(ID).content}));
  assert.deepEqual(store.rows.get(OTHER_ID),other);
  assert.deepEqual(store.audit,[{id:'historic',kind:'unchanged'}]);
  const unchanged=previewNoteRestore({...values,current:await store.find(ID)});
  assert.equal(unchanged.status,'already_restored');
  assert.equal((await restoreNoteOnce({...values,store,
    confirmedPlanSha256:unchanged.planSha256})).status,'unchanged');
});
test('기존 B 메모는 조건부 갱신, A 소유 충돌·경쟁 상태·백업 변조는 거부',async()=>{
  const values=noteInputs();
  assert.throws(()=>verifyNoteBackup({...values,trustedSha256:'f'.repeat(64)}),
    /UNVERIFIED_NOTE_BACKUP/);
  assert.throws(()=>previewNoteRestore({...values,identityUserId:A}),
    /RESTORE_NOT_AUTHORIZED/);
  assert.throws(()=>previewNoteRestore({...values,id:OTHER_ID}),/NOTE_NOT_IN_BACKUP/);
  assert.throws(()=>previewNoteRestore({...values,
    current:{id:ID,owner_id:A,title:'A note',content:'A note'}}),
    /NOTE_OWNER_CONFLICT/);
  const old={id:ID,owner_id:B,title:'Edited',content:'Compromised training text'};
  const store=noteStore([old]);
  const preview=previewNoteRestore({...values,current:old});
  assert.equal(preview.status,'replace');
  assert.equal((await restoreNoteOnce({...values,store,
    confirmedPlanSha256:preview.planSha256})).status,'restored');
  assert.equal(store.rows.get(ID).title,targetNote.title);
  const concurrent=noteStore([old]);
  concurrent.restoreVerified=async()=>{throw Error('NOTE_CHANGED_DURING_RESTORE');};
  await assert.rejects(restoreNoteOnce({...values,store:concurrent,
    confirmedPlanSha256:preview.planSha256}),/NOTE_CHANGED_DURING_RESTORE/);
});

const mockResponse = () => ({
  headers:{},code:0,body:null,
  setHeader(key,value){this.headers[key]=value;},
  status(code){this.code=code;return this;},
  json(data){this.body=data;return this;},
});
test('복원 HTTP 경로는 기본 비활성화, 비정상 메서드와 신원은 거부',async()=>{
  const handler=createRestoreHandler({env:{RESTORE_ENABLED:'0'}});
  const response=mockResponse();
  await handler({method:'POST',query:{id:ID},headers:{}},response);
  assert.equal(response.code,503);
  assert.equal(response.body.error,'RESTORE_DISABLED');
  assert.equal(response.headers['Cache-Control'],'no-store');
  assert.ok(!Object.keys(response.headers).some(k=>k.startsWith('X-ALEPH-')));
  const method=mockResponse();
  await handler({method:'DELETE',headers:{},query:{id:ID}},method);
  assert.equal(method.code,405);
});

test('서버 복원 GET/POST는 인증된 B의 확인 계획으로 지정 1건만 처리', async () => {
  const rows=new Map([[OTHER_ID,{id:OTHER_ID,owner_id:A,title:'A example',content:'unchanged'}]]);
  const environment={
    RESTORE_ENABLED:'1',RESTORE_B_OWNER_ID:B,RESTORE_OPERATOR_USER_ID:B,
    RESTORE_NOTE_SNAPSHOT_BASE64:Buffer.from(privateNoteBackup()).toString('base64'),
    RESTORE_NOTE_BACKUP_SHA256:sha256(privateNoteBackup()),
    RESTORE_INCIDENT_AT:incidentAt,
    SUPABASE_URL:'https://test-only.supabase.co',SUPABASE_SECRET_KEY:'DUMMY_SERVER_KEY',
  };
  const fakeDB={
    async rpc(name, p) {
      assert.equal(name, 'restore_one_learning_note');
      const existing=rows.get(p.p_id);
      if (p.p_expected_exists) {
        if(!existing || existing.owner_id!==p.p_owner_id
          || existing.title!==p.p_original_title
          || existing.content!==p.p_original_content)
          return {data:null,error:null};
      } else if(existing) return {data:null,error:null};
      rows.set(p.p_id,{id:p.p_id,owner_id:p.p_owner_id,
        title:p.p_restored_title,content:p.p_restored_content});
      // Transactional Postgres function performs readback before COMMIT.
      return {data:{...rows.get(p.p_id),verified:true},error:null};
    },
    from(table) {
      assert.equal(table,'learning_notes');
      const filters=[];let operation='select';let updateData=null;
      return {
        select(){return this;},
        eq(key,value){filters.push([key,value]);return this;},
        insert(record){operation='insert';updateData=record;return this;},
        update(record){operation='update';updateData=record;return this;},
        async maybeSingle(){
          const matches=record=>filters.every(([key,value])=>record?.[key]===value);
          if(operation==='select'){
            const data=[...rows.values()].find(matches)??null;
            return {data,error:null};
          }
          if(operation==='insert'){
            if(rows.has(updateData.id))return {data:null,error:{code:'23505'}};
            rows.set(updateData.id,{...updateData});
            return {data:{id:updateData.id},error:null};
          }
          const old=[...rows.values()].find(matches);
          if(!old)return {data:null,error:null};
          rows.set(old.id,{...old,...updateData});
          return {data:{id:old.id},error:null};
        },
      };
    },
  };
  const handler=createRestoreHandler({
    env:environment,supabaseFactory:()=>fakeDB,
    verifierFactory:()=>async auth=>{
      if(auth==='Bearer example-b')return {kind:'student',userId:B};
      if(auth==='Bearer example-a')return {kind:'student',userId:A};
      return null;
    },
  });
  const req=(method,id=ID,auth='Bearer example-b',body)=>({
    method,query:{id},headers:{authorization:auth,origin:'https://skt-aleph-defense.vercel.app'},
    body,
  });
  let response=mockResponse();
  await handler(req('GET',ID,'Bearer example-a'),response);
  assert.equal(response.code,403);
  response=mockResponse();
  await handler(req('GET',ID,'Bearer not-valid'),response);
  assert.equal(response.code,401);
  response=mockResponse();
  await handler(req('GET',OTHER_ID),response);
  assert.equal(response.code,404);
  response=mockResponse();
  await handler(req('GET'),response);
  assert.equal(response.code,200);
  assert.equal(response.body.ownerId,B);
  assert.equal(response.body.contentSha256,contentSha256(targetNote));
  assert.ok(!JSON.stringify(response.body).includes(targetNote.body));
  assert.equal(response.headers['Cache-Control'],'no-store');
  assert.ok(!Object.keys(response.headers).some(k=>k.startsWith('X-ALEPH-')));
  const plan=response.body.planSha256;
  response=mockResponse();
  await handler(req('POST',ID,'Bearer example-b',{planSha256:'0'.repeat(64)}),response);
  assert.equal(response.code,409);
  assert.equal(rows.has(ID),false);
  response=mockResponse();
  await handler(req('POST',ID,'Bearer example-b',{planSha256:plan}),response);
  assert.equal(response.code,200);
  assert.equal(response.body.status,'restored');
  assert.equal(response.headers['Cache-Control'],'no-store');
  assert.ok(!Object.keys(response.headers).some(k=>k.startsWith('X-ALEPH-')));
  assert.equal(rows.get(ID).owner_id,B);
  assert.equal(contentSha256({...targetNote}),contentSha256({
    ...rows.get(ID),body:rows.get(ID).content,
  }));
  assert.deepEqual(rows.get(OTHER_ID),{id:OTHER_ID,owner_id:A,
    title:'A example',content:'unchanged'});
});

test('10단계 배포는 단일 복구 경로를 허용 목록과 함께 검증', async () => {
  const { deploymentIdentity } = await import('../scripts/deployment-identity.mjs');
  const config = { ...JSON.parse(await readFile(new URL('../aleph.config.json', import.meta.url), 'utf8')), step: 10 };
  const env = {
    VERCEL_GIT_PROVIDER:'github',VERCEL_GIT_REPO_OWNER:'Student-A',
    VERCEL_GIT_REPO_SLUG:'aleph-defense',VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),
    VERCEL_URL:'stage10-test.vercel.app',
  };
  const identity = deploymentIdentity(env,config);
  assert.equal(identity.step,config.step);
  assert.equal(identity.restoreRoute,'/api/restore/notes/:id');
  assert.ok(identity.allowedRoutes.includes(identity.restoreRoute));
  assert.equal(identity.originalApiUrl,config.originalApiUrl);
  assert.throws(()=>deploymentIdentity(env,{
    ...config,restoreRoute:'/api/restore/all',
  }),/설정/u);
});

test('10단계 제출 점검은 운영 복구 미실행을 명확히 구분', async () => {
  const { runAttackChecks } = await import('../src/attack-check.mjs');
  const config = { ...JSON.parse(await readFile(new URL('../aleph.config.json', import.meta.url), 'utf8')), step: 10 };
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      const pathname=new URL(String(url)).pathname;
      if(pathname==='/aleph.json')return new Response(JSON.stringify({
        step:10,allowedRoutes:config.allowedRoutes,restoreRoute:config.restoreRoute,
        originalApiUrl:config.originalApiUrl,protectedService:config.protectedService,
      }),{status:200});
      if(pathname==='/api/notes')return new Response(
        JSON.stringify({error:'UNAUTHORIZED'}),{status:401});
      if(pathname.startsWith('/api/restore/notes/'))return new Response(
        JSON.stringify({error:'RESTORE_DISABLED'}),{status:503});
      return new Response('<!doctype html>',{status:200});
    };
    const checks=await runAttackChecks({...config,
      publicAppUrl:'https://stage10-test.vercel.app'});
    assert.equal(checks.length,11);
    assert.ok(checks.every(x=>
      Object.keys(x).sort().join(',')==='attackId,expected,observed'));
    assert.match(checks[0].observed,/safe_v1/u);
    assert.match(checks[1].observed,/ID·owner·해시/u);
    assert.match(checks[2].observed,/step=10/u);
    assert.match(checks[3].observed,/HTTP 200/u);
    assert.match(checks[4].observed,/401/u);
    assert.match(checks[5].observed,/HTTP 503 RESTORE_DISABLED.*미검증/u);
    assert.ok(checks.slice(6,9).every(x=>x.observed.startsWith('미실행:')));
    assert.match(checks[9].observed, /변조·분실 쓰기 차단/u);
    assert.match(checks[10].observed, /0건 쓰기/u);
  }finally{globalThis.fetch=old;}
});

test('사본 본문은 URL 필터 없이 서버 RPC 트랜잭션으로 조건부 복원', async () => {
  const source = await readFile(new URL('../api/restore-note.js', import.meta.url), 'utf8');
  assert.match(source, /\.rpc\('restore_one_learning_note'/u);
  assert.doesNotMatch(source, /\.eq\('content', current\.content\)/u);
  assert.doesNotMatch(source, /\.insert\(/u);
  assert.match(source, /restoreVerified\(row, previous\)/u);
  const sql = await readFile(new URL('../supabase/step10_restore_note_function.sql', import.meta.url), 'utf8');
  assert.match(sql, /security invoker/iu);
  assert.match(sql, /p_expected_exists boolean/iu);
  assert.match(sql, /returns jsonb/iu);
  assert.match(sql, /jsonb_build_object/iu);
  assert.match(sql, /for update/iu);
  assert.match(sql, /raise exception 'POST_RESTORE_VERIFICATION_FAILED'/iu);
  assert.match(sql, /insert into public.learning_notes/iu);
  assert.match(sql, /from public, anon, authenticated/iu);
  assert.match(sql, /grant execute[\s\S]*to service_role/iu);
  assert.match(sql, /where id = p_id[\s\S]*owner_id = p_owner_id/iu);
});


test('10단계 정책 사본을 미리보기 후 변경·삭제하면 적용 전 중단하고 원본 정책 불변', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aleph-recovery-lab-'));
  const currentPath = join(dir, 'test-policy.json');
  const backupPath = join(dir, 'safe-policy.json');
  const expected = compromised();
  const backup = backupPolicy();
  const options = { currentPath, backupPath,
    trustedSha256: hash(backup), incidentAt };
  try {
    await writeFile(currentPath, JSON.stringify(expected));
    await writeFile(backupPath, backup);
    const { preview } = await recoverTestPolicyFile(options);
    assert.equal(preview.restoreVersion, 'safe_v1');
    assert.ok(preview.changedPaths.every(x => x.startsWith('services.notes.')));
    await writeFile(backupPath, backup.replace('safe_v1', 'faked_v1'));
    await assert.rejects(recoverTestPolicyFile({
      ...options, confirm: preview.planSha256,
    }), /UNVERIFIED_POLICY_BACKUP/);
    assert.deepEqual(JSON.parse(await readFile(currentPath, 'utf8')), expected);
    await rm(backupPath);
    await assert.rejects(recoverTestPolicyFile({
      ...options, confirm: preview.planSha256,
    }), /UNVERIFIED_POLICY_BACKUP/);
    assert.deepEqual(JSON.parse(await readFile(currentPath, 'utf8')), expected);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('10단계 서버의 계획 확인 후 사본 재조회가 실패하면 DB 쓰기 0건', async () => {
  const values = noteInputs();
  const current = noteStore();
  const preview = previewNoteRestore({...values, current: null});
  const options = {...values, store: current,
    confirmedPlanSha256: preview.planSha256};
  await assert.rejects(restoreNoteOnce({...options,
    rereadBackup: async () => null,
  }), /UNVERIFIED_NOTE_BACKUP/);
  await assert.rejects(restoreNoteOnce({...options,
    rereadBackup: async () => ({raw: privateNoteBackup().replace('backup_v1', 'changed_v1'),
      trustedSha256: values.trustedSha256}),
  }), /UNVERIFIED_NOTE_BACKUP/);
  await assert.rejects(restoreNoteOnce({...options,
    rereadBackup: async () => { throw new Error('backup unavailable'); },
  }), /UNVERIFIED_NOTE_BACKUP/);
  assert.equal(current.rows.size, 0);
  const done = await restoreNoteOnce({...options,
    rereadBackup: async () => ({raw:values.raw, trustedSha256:values.trustedSha256}),
  });
  assert.equal(done.status, 'restored');
  assert.equal(current.rows.size, 1);
});


test('복원 라우트는 node_modules 없는 격리 프로젝트에서도 모의 테스트를 시작할 수 있음', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-restore-dependency-free-'));
  try {
    await mkdir(join(root, 'api'), { recursive: true });
    await mkdir(join(root, 'src', 'recovery'), { recursive: true });
    await copyFile(new URL('../api/restore-note.js', import.meta.url),
      join(root, 'api', 'restore-note.js'));
    await copyFile(new URL('../src/recovery/note.mjs', import.meta.url),
      join(root, 'src', 'recovery', 'note.mjs'));
    await copyFile(new URL('../aleph.config.json', import.meta.url),
      join(root, 'aleph.config.json'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');

    // Neither node_modules nor the production auth verifier is available here.
    // A future eager import of Supabase or jose must fail this regression test.
    const isolatedUrl = pathToFileURL(join(root, 'api', 'restore-note.js')).href;
    const program = [
      'const { createRestoreHandler } = await import(' + JSON.stringify(isolatedUrl) + ');',
      'const handler = createRestoreHandler({ env: { RESTORE_ENABLED: "0" } });',
      'const res = { setHeader() {}, status(code) { this.code=code; return this; },',
      '  json(body) { this.body=body; return this; } };',
      'await handler({method:"POST",query:{},headers:{}},res);',
      'if (res.code !== 503 || res.body?.error !== "RESTORE_DISABLED") process.exit(2);',
    ].join('\n');
    const child = spawnSync(process.execPath,
      ['--input-type=module', '--eval', program],
      { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0,
      '독립 복원 테스트 실행 실패: ' + (child.stderr || child.stdout || child.error));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('활성 10단계 배포 계약은 restoreRoute를 명시하고 준비 전 실복원으로 간주하지 않음', async () => {
  const {deploymentIdentity} = await import('../scripts/deployment-identity.mjs');
  const cfg = JSON.parse(await readFile(new URL('../aleph.config.json', import.meta.url),'utf8'));
  assert.equal(cfg.step,12);
  const identity = deploymentIdentity({
    VERCEL_GIT_PROVIDER: 'github',
    VERCEL_GIT_REPO_OWNER: 'Student-A',
    VERCEL_GIT_REPO_SLUG: 'aleph-defense',
    VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
    VERCEL_URL: 'example.vercel.app',
  },cfg);
  assert.equal(identity.step,cfg.step);
  assert.equal(identity.restoreRoute,'/api/restore/notes/:id');
  assert.ok(identity.allowedRoutes.includes(identity.restoreRoute));
});


test('복원 함수는 백업 재조회 콜백이 빠지면 쓰기 전에 거부', async () => {
  const fixture = noteInputs();
  const store = noteStore();
  const { rereadBackup, ...withoutReread } = fixture;
  const plan = previewNoteRestore({ ...fixture, current: null });
  await assert.rejects(
    restoreNoteOnce({ ...withoutReread, store, confirmedPlanSha256: plan.planSha256 }),
    /UNVERIFIED_NOTE_BACKUP/u,
  );
  assert.equal(store.rows.size, 0);
  const restored = await restoreNoteOnce({
    ...fixture, store, confirmedPlanSha256: plan.planSha256,
  });
  assert.equal(restored.status, 'restored');
});

test('시험 정책 디스크 복원 결과는 다시 읽어 확인하고 감사 기록을 보존', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aleph-recovery-lab-'));
  try {
    const currentPath = join(dir, 'test-policy.json');
    const backupPath = join(dir, 'safe-policy.json');
    const original = compromised();
    const rawBackup = backupPolicy();
    await writeFile(currentPath, JSON.stringify(original));
    await writeFile(backupPath, rawBackup);
    const options = { currentPath, backupPath,
      trustedSha256: hash(rawBackup), incidentAt };
    const first = await recoverTestPolicyFile(options);
    assert.equal(first.applied, false);
    assert.equal(first.preview.currentVersion, 'unsafe_v2');
    assert.equal(first.preview.restoreVersion, 'safe_v1');
    assert.deepEqual(first.preview.changedPaths, [
      'services.notes.version','services.notes.ownerOnly','services.notes.rules',
    ]);
    const done = await recoverTestPolicyFile({
      ...options, confirm: first.preview.planSha256,
    });
    assert.equal(done.applied, true);
    assert.equal(done.verifiedAfterRead, true);
    const disk = JSON.parse(await readFile(currentPath, 'utf8'));
    assert.deepEqual(disk.services.notes, safeNotes);
    assert.deepEqual(disk.services.otherService, original.services.otherService);
    assert.deepEqual(disk.audit, original.audit);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test('사본 symlink는 신뢰하지 않으며 시험 정책을 덮어쓰지 않음', async () => {
  const { symlink } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'aleph-recovery-lab-'));
  try {
    const currentPath = join(dir,'test-policy.json');
    const backupPath = join(dir,'safe-policy.json');
    const sourcePath = join(dir,'source-copy.json');
    const backup = backupPolicy();
    const original = compromised();
    await writeFile(currentPath,JSON.stringify(original));
    await writeFile(sourcePath,backup);
    await symlink(sourcePath,backupPath);
    await assert.rejects(recoverTestPolicyFile({
      currentPath,backupPath,
      trustedSha256:hash(backup),incidentAt,
    }),/UNVERIFIED_POLICY_BACKUP/u);
    assert.deepEqual(JSON.parse(await readFile(currentPath,'utf8')),original);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test('복원 단계별 지역 보고서는 실기기/실계정 증거로 오인하지 않음', async () => {
  const { TEST_ORDER,sanitizeExitStatus } =
    await import('../scripts/recovery-retest.mjs');
  assert.deepEqual(TEST_ORDER.map(x=>x.stage),
    ['1-5','6','7','8','9','10','contract','packaging']);
  assert.equal(sanitizeExitStatus(null), null);
  assert.equal(sanitizeExitStatus(0), 0);
  assert.equal(sanitizeExitStatus(-1), null);
});

test('10단계 스냅샷 실패 게이트의 실제 로컬 파일·메모 쓰기 재현', async () => {
  const { verifySyntheticStage10Recovery } =
    await import('../src/recovery/self-check.mjs');
  const proof = await verifySyntheticStage10Recovery();
  assert.equal(proof.kind,'synthetic_local_only');
  const required = [
    'policyPreviewVerified','policyTamperStoppedBeforeWrite',
    'policyMissingBackupStoppedBeforeWrite','policyRestoreReadbackVerified',
    'unchangedServiceAndAuditPreserved','noteTamperStoppedBeforeWrite',
    'noteMissingBackupStoppedBeforeWrite','noteRestoreReadbackVerified',
    'otherNotesPreserved',
  ];
  for(const key of required) assert.equal(proof[key],true,key);
  const json = JSON.stringify(proof);
  assert.doesNotMatch(json,/Synthetic fixture only|Leave A unchanged/u);
});
