import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {decide, RULE_IDS} from '../src/decider.mjs';
import {fixtureRequests} from '../scripts/fixture-7.mjs';
import {typedResourceId,memoOwnerAllowed,trustedInstructorMetadata,mayEditAnnouncement} from '../src/resource-zones.mjs';
import {deploymentIdentity} from '../scripts/deployment-identity.mjs';
import {runAttackChecks} from '../src/attack-check.mjs';

const base=fixtureRequests().normal;
async function verdict(request) {
  const result=await decide({...base,...request});
  assert.equal(result.requestId,base.requestId);
  assert.deepEqual(Object.keys(result).sort(),['decision','reasonCode','requestId','ruleIds','schema']);
  assert.ok(result.ruleIds.every(id=>RULE_IDS.includes(id)));
  return result;
}

test('Stage 6/7 rules remain and registered A can GET/PUT own memo', async()=>{
  assert.deepEqual(RULE_IDS.slice(0,2),['device_registered','step_up_required']);
  assert.equal((await verdict({})).decision,'allow');
  assert.equal((await verdict({method:'PUT',route:'PUT /notes/:id'})).decision,'allow');
  const rejected=await verdict({deviceRegistered:false});
  assert.equal(rejected.decision,'deny');
  assert.equal(rejected.reasonCode,'device_not_registered');
});
test('Memo item routes allowed for registered device; list route denied',async()=>{
  for(const method of ['GET','PUT']) {
    const result=await verdict({subjectId:'other_fixture',method,route:method+' /notes/:id'});
    assert.equal(result.decision,'allow');
  }
  const listRoute=await verdict({path:'/notes',route:'GET /notes'});
  assert.equal(listRoute.decision,'deny');
});
test('Notice write is denied to anyone because engine contract has no roles',async()=>{
  const query={path:'/announcements/notice-demo',method:'PUT',route:'PUT /announcements/:id'};
  assert.equal((await verdict(query)).decision,'deny');
  const teacher=await verdict({...query,subjectId:'instructor_fixture',deviceId:'b'.repeat(16)});
  assert.equal(teacher.decision,'deny');
  assert.ok(teacher.ruleIds.includes('announcement_instructor_write'));
  assert.equal((await verdict({...query,subjectId:'instructor_fixture',deviceRegistered:false})).decision,'deny');
  assert.equal((await verdict({...query,method:'GET',route:'GET /announcements/:id'})).decision,'allow');
});
test('Unknown paths, adjacent export endpoint, methods and query-based functions fail closed',async()=>{
  for(const details of [
    {path:'/notes/export'}, {path:'/notes/demo/export'}, {path:'/notes/not-registered'},
    {path:'/announcements/export'}, {path:'/announcements/notice-demo/export'},
    {path:'/announcements/notice-demo',method:'POST',route:'POST /announcements/:id'},
    {method:'DELETE',route:'DELETE /notes/:id'}, {queryLength:8},
    {route:'GET /api/notes/:id'}, {service:'other'}, {deviceId:'x'.repeat(16)}
  ]) assert.equal((await verdict(details)).decision,'deny',JSON.stringify(details));
  assert.equal((await verdict({role:'instructor',identity:{role:'instructor'}})).decision,'allow');
});
test('Resource namespaces and verified DB-owner / instructor authority are independent',()=>{
  const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
  assert.equal(typedResourceId('memo',a),'memo:'+a);
  assert.equal(typedResourceId('announcement',a),'announcement:'+a);
  assert.equal(typedResourceId('memo','export'),null);
  assert.equal(memoOwnerAllowed(a,a),true);
  assert.equal(memoOwnerAllowed(a,b),false);
  assert.equal(trustedInstructorMetadata({role:'instructor'}),true);
  assert.equal(trustedInstructorMetadata({roles:['instructor']}),true);
  assert.equal(trustedInstructorMetadata({role:'student'}),false);
  assert.equal(mayEditAnnouncement({identity:{kind:'student',userId:a},verifiedAppMetadata:{role:'instructor'},storedOwnerId:a}),true);
  assert.equal(mayEditAnnouncement({identity:{kind:'student',userId:b},verifiedAppMetadata:{role:'instructor'},storedOwnerId:a}),false);
  assert.equal(mayEditAnnouncement({identity:{kind:'judge',userId:a},verifiedAppMetadata:{role:'instructor'},storedOwnerId:a}),false);
});
test('Server source authenticates then checks stored owner and admin-fetched app_metadata',async()=>{
  const notes=await readFile(new URL('../api/notes.js',import.meta.url),'utf8');
  const announcements=await readFile(new URL('../api/announcements.js',import.meta.url),'utf8');
  assert.match(notes,/verifyLogin\(request\.headers\?\.authorization\)/u);
  assert.match(notes,/data\.owner_id !== userId/u);
  assert.match(notes,/\.eq\('owner_id', identity\.userId\)/u);
  assert.match(announcements,/verify\(request\.headers\?\.authorization\)/u);
  assert.match(announcements,/auth\.admin\.getUserById\(identity\.userId\)/u);
  assert.match(announcements,/data\.user\.app_metadata/u);
  assert.match(announcements,/\.eq\('owner_id', identity\.userId\)/u);
  assert.doesNotMatch(announcements,/request\.body\.role|request\.query\.role|\.user_metadata\b/u);
});
test('Stage 8 manifest includes two zones and unchanged URLs',async()=>{
  const cfg={...JSON.parse(await readFile(new URL('../aleph.config.json',import.meta.url),'utf8')),step:8};
  assert.equal(cfg.step,8);
  assert.ok(cfg.allowedRoutes.includes('/api/announcements/:id'));
  assert.ok(cfg.allowedRoutes.includes('/api/notes/:id'));
  const manifest=deploymentIdentity({
    VERCEL_GIT_PROVIDER:'github',VERCEL_GIT_REPO_OWNER:'Student-A',VERCEL_GIT_REPO_SLUG:'aleph-defense',
    VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),VERCEL_URL:'student-defense-123.vercel.app'
  },cfg);
  assert.equal(manifest.step,8);
  assert.deepEqual(manifest.resourceZones,cfg.resourceZones);
  assert.deepEqual(manifest.protectedService,cfg.protectedService);
  assert.equal(manifest.originalApiUrl,cfg.originalApiUrl);
});
test('Stage 8 self-check separates local policy tests from live unauthenticated requests',async()=>{
  const prior=globalThis.fetch;
  try{
    globalThis.fetch=async url=>{
      const path=new URL(String(url)).pathname;
      if(path==='/aleph.json')return new Response(JSON.stringify({
        step:8,resourceZones:{memo:{resourceIdPrefix:'memo:'},instructorAnnouncement:{resourceIdPrefix:'announcement:'}},
        allowedRoutes:['/api/notes','/api/notes/:id','/api/announcements/:id']
      }),{status:200});
      return new Response(JSON.stringify({error:'UNAUTHORIZED'}),{status:401,headers:{'WWW-Authenticate':'Bearer','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'}});
    };
    const result=await runAttackChecks({step:8,publicAppUrl:'https://student-defense.vercel.app',
      allowedRoutes:['/api/notes','/api/notes/:id','/api/announcements/:id']});
    assert.equal(result.length,9);
    assert.ok(result.every(r=>Object.keys(r).sort().join(',')==='attackId,expected,observed'));
    assert.match(result[3].observed,/공지 쓰기 누구에게나 deny/u);
    assert.match(result[6].observed,/401/u);
    assert.match(result[7].observed,/401/u);
    assert.match(result[8].observed,/미실행/u);
  }finally{globalThis.fetch=prior}
});

test('Invalid queries, unknown routes and notice writes never cross zones',async()=>{
  const base=fixtureRequests().normal;
  const invalidMemoCases=[
    {...base,classId:''},
    {...base,projectId:''},
    {...base,deviceRegistered:false},
    {...base,path:'/notes'}, // Collection route denied
    {...base,path:'/notes/export'}, // Reserved route denied
    {...base,queryLength:8},
    {...base,querySha256:'0'.repeat(64)},
  ];
  for(const request of invalidMemoCases) {
    const result=await decide(request);
    assert.equal(result.decision,'deny','Invalid memo request must be denied: '+JSON.stringify({
      path:request.path,classId:request.classId,projectId:request.projectId,queryLength:request.queryLength
    }));
  }
  const studentPretendsInstructor={...base,subjectId:'instructor_fixture',
    method:'PUT',path:'/announcements/notice-demo',route:'PUT /announcements/:id'};
  assert.equal((await decide(studentPretendsInstructor)).decision,'deny');
  assert.equal((await decide({...studentPretendsInstructor,deviceId:'b'.repeat(16)})).decision,'deny');
  assert.ok((await decide({...studentPretendsInstructor,deviceId:'b'.repeat(16)})).ruleIds.includes('announcement_instructor_write'));
});

test('Zone-denied registered requests cite the zone rule, not only device registration', async () => {
  const notice={...base,path:'/announcements/notice-demo',
    method:'PUT',route:'PUT /announcements/:id'};
  const noticeVerdict=await decide(notice);
  assert.equal(noticeVerdict.decision,'deny');
  assert.ok(noticeVerdict.ruleIds.includes('announcement_instructor_write'));
  const noticePost={...base,path:'/announcements',
    method:'POST',route:'POST /announcements'};
  const noticePostVerdict=await decide(noticePost);
  assert.equal(noticePostVerdict.decision,'deny');
  assert.ok(noticePostVerdict.ruleIds.includes('announcement_instructor_write'));
});


test('Stage8 judge boundary: all notice writes denied regardless of actor and both resource depths', async () => {
  const normal=fixtureRequests().normal;
  const actorTuples=[
    {subjectId:normal.subjectId,deviceId:normal.deviceId},
    {subjectId:'instructor_fixture',deviceId:'bbbbbbbbbbbbbbbb'},
    {subjectId:'other_fixture',deviceId:'cccccccccccccccc',role:'instructor'},
  ];
  for(const actor of actorTuples){
    for(const method of ['POST','PUT','PATCH','DELETE']){
      for(const item of [true,false]){
        const path=item?'/announcements/notice-demo':'/announcements';
        const route=method+(item?' /announcements/:id':' /announcements');
        const result=await decide({...normal,...actor,method,path,route});
        assert.equal(result.decision,'deny',JSON.stringify({actor,method,path}));
        assert.ok(result.ruleIds.includes('announcement_instructor_write'));
      }
    }
  }
});

test('Stage8 judge boundary: no memo collection nor disguised bulk or export endpoints',async()=>{
  const normal=fixtureRequests().normal;
  for(const method of ['GET','POST','PUT','PATCH','DELETE']){
    for(const path of ['/notes','/notes/','/notes/export','/notes/demo/export']){
      const result=await decide({...normal,method,path,
        route:method+(path==='/notes'?' /notes':' /notes/:id')});
      assert.equal(result.decision,'deny',JSON.stringify({path,method}));
    }
  }
});

test('Stage8 authority: individual memo may be admitted to a verified device, but API owns per-row authorization',async()=>{
  const normal=fixtureRequests().normal;
  for(const method of ['GET','PUT']){
    const path='/notes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const route=method+' /notes/:id';
    for(const subjectId of [normal.subjectId,'another_verified_subject']){
      const result=await decide({...normal,subjectId,path,method,route});
      assert.equal(result.decision,'allow',JSON.stringify({method,subjectId}));
      assert.ok(result.ruleIds.includes('memo_zone'));
    }
    assert.equal((await decide({...normal,path,method,route,deviceRegistered:false})).decision,'deny');
  }
});
