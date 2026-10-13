import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const noteInputs = () => ({
  raw:privateNoteBackup(), trustedSha256:sha256(privateNoteBackup()),
  incidentAt,pinnedBOwnerId:B,identityUserId:B,id:ID,
});
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
  assert.deepEqual(Object.keys(preview).sort(),['backupSha256','beforeSha256',
    'contentSha256','id','ownerId','planSha256','schema','status']);
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
  concurrent.replaceIfCurrent=async()=>{throw Error('NOTE_CHANGED_DURING_RESTORE');};
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
      const current=rows.get(p.p_id);
      if(!current || current.owner_id!==p.p_owner_id
          || current.title!==p.p_original_title || current.content!==p.p_original_content)
        return {data:null,error:null};
      rows.set(p.p_id,{...current,title:p.p_restored_title,content:p.p_restored_content});
      return {data:p.p_id,error:null};
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
  const plan=response.body.planSha256;
  response=mockResponse();
  await handler(req('POST',ID,'Bearer example-b',{planSha256:'0'.repeat(64)}),response);
  assert.equal(response.code,409);
  assert.equal(rows.has(ID),false);
  response=mockResponse();
  await handler(req('POST',ID,'Bearer example-b',{planSha256:plan}),response);
  assert.equal(response.code,200);
  assert.equal(response.body.status,'restored');
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
  assert.equal(identity.step,10);
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
    assert.equal(checks.length,9);
    assert.ok(checks.every(x=>
      Object.keys(x).sort().join(',')==='attackId,expected,observed'));
    assert.match(checks[0].observed,/safe_v1/u);
    assert.match(checks[1].observed,/ID·owner·해시/u);
    assert.match(checks[2].observed,/step=10/u);
    assert.match(checks[3].observed,/HTTP 200/u);
    assert.match(checks[4].observed,/401/u);
    assert.match(checks[5].observed,/HTTP 503/u);
    assert.ok(checks.slice(6).every(x=>x.observed.startsWith('미실행:')));
  }finally{globalThis.fetch=old;}
});

test('사본 본문은 URL 필터 없이 서버 RPC 트랜잭션으로 조건부 복원', async () => {
  const source = await readFile(new URL('../api/restore-note.js', import.meta.url), 'utf8');
  assert.match(source, /\.rpc\('restore_one_learning_note'/u);
  assert.doesNotMatch(source, /\.eq\('content', current\.content\)/u);
  const sql = await readFile(new URL('../supabase/step10_restore_note_function.sql', import.meta.url), 'utf8');
  assert.match(sql, /security invoker/iu);
  assert.match(sql, /from public, anon, authenticated/iu);
  assert.match(sql, /grant execute[\s\S]*to service_role/iu);
  assert.match(sql, /where id = p_id[\s\S]*owner_id = p_owner_id/iu);
});
