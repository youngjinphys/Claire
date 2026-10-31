import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import config from '../aleph.config.json' with { type: 'json' };
import { runStage12ReadOnlyChecks } from '../src/attack-check-stage12.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const origin = new URL(config.publicAppUrl);

function http(status, body = null, extra = {}) {
  return new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      ...extra,
    },
  });
}

function mockFetch(calls, overrides = {}) {
  return async (url, options) => {
    assert.equal(typeof url, 'string', 'the HTTP request recorder accepts URL strings, not URL objects');
    const u = new URL(url);
    assert.equal(u.origin, origin.origin, 'the checker must never request another host');
    assert.ok(['GET', 'HEAD'].includes(options.method), 'only GET/HEAD are allowed');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    calls.push(options.method + ' ' + u.pathname + u.search);
    const key = options.method + ' ' + u.pathname + u.search;
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (key === 'GET /aleph.json') return http(200, {
      schema: 'aleph.defense.deployment.v1',
      step: 12, repoUrl: config.repoUrl, publicAppUrl: config.publicAppUrl,
      restoreRoute: config.restoreRoute, originalApiUrl: config.originalApiUrl,
      allowedRoutes: config.allowedRoutes,
    });
    if (key === 'GET /') return http(200, '<!DOCTYPE html>', { 'content-type': 'text/html' });
    if (key === 'HEAD /') return http(200, null, { 'x-content-type-options': 'nosniff' });
    if (key === 'GET /data.json') return http(200, { notes: [] });
    if (key === 'GET /api/ops') return http(200, {
      schema: 'aleph.operations.snapshot.v1',
      verdict: {officialJudgeEvidence:false,complete:false,attackTypesVerified:0,stagesVerified:0},
      records: [{method:'GET'}],
    });
    if (key === 'GET /api/auth?action=login') return http(405,{error:'METHOD_NOT_ALLOWED'},{allow:'POST'});
    if (key === 'GET /manifest.webmanifest') return http(200, {
      name:'BYTE BACK · 내 보안 자료실',display:'standalone',
      icons:[{src:'/icon-192.png'}],
    }, {'content-type':'application/manifest+json'});
    if (key === 'GET /api/restore/notes/' + fixture) return http(503, {
      error:'RESTORE_DISABLED'
    });
    if ([
      'GET /api/notes','GET /api/notes/' + fixture,
      'GET /api/announcements/' + fixture,'GET /api/device?action=status',
    ].includes(key)) return http(401, {error:'UNAUTHORIZED'}, {'www-authenticate':'Bearer'});
    throw new Error('unexpected probe: ' + key);
  };
}

test('Stage12 uses only same-origin public HTTPS GET/HEAD and returns exactly 20 schema-safe records', async () => {
  const calls = [];
  const attempts = await runStage12ReadOnlyChecks(config, origin, mockFetch(calls));
  assert.equal(attempts.length, 20);
  assert.equal(calls.length, 12);
  assert.equal(calls.filter(x => x.startsWith('HEAD')).length, 1);
  assert.equal(new Set(calls).size, calls.length);
  const ids = new Set();
  for (const attempt of attempts) {
    assert.deepEqual(Object.keys(attempt).sort(), ['attackId','expected','observed']);
    assert.ok(!ids.has(attempt.attackId));
    assert.ok(attempt.expected.length > 0 && attempt.expected.length < 301);
    assert.ok(attempt.observed.length > 0 && attempt.observed.length < 301);
    ids.add(attempt.attackId);
  }
  assert.equal(attempts.filter(a => a.observed === 'not_run').length, 8);
  assert.match(attempts.find(a => a.attackId === 'stage12_security_headers').observed,
    /^HEAD https:\/\/skt-aleph-defense\.vercel\.app\/ HTTP 200; requestId=unavailable;/u);
  assert.match(attempts.find(a => a.attackId === 'stage12_operations_snapshot').observed,
    /공식 0\/12·0\/41/u);
  assert.match(attempts.find(a => a.attackId === 'recovery_default_fail_closed').observed,
    /GET https:\/\/skt-aleph-defense\.vercel\.app\/api\/restore\/notes\/.* HTTP 503; requestId=unavailable;.*미검증/u);
});

test('HTTP failures stay not_run instead of pretending to be verified results', async () => {
  const attempts = await runStage12ReadOnlyChecks(config, origin, async () => {
    throw new Error('isolated network denied');
  });
  assert.equal(attempts.length, 20);
  assert.ok(attempts.every(x => x.observed === 'not_run'));
});

test('oversized, malformed, or private response bodies are not admitted as evidence', async () => {
  const calls = [];
  const oversized = http(200, {notes:[], metadata:'A'.repeat(25000)});
  const badNotes = http(200, {notes:[{body:'do not read this'}]});
  const badOps = http(200, {
    schema:'aleph.operations.snapshot.v1',
    verdict:{officialJudgeEvidence:false,complete:false,attackTypesVerified:0,stagesVerified:0},
    records:[{method:'GET',token:'do not emit'}],
  });
  const attempts = await runStage12ReadOnlyChecks(config, origin, mockFetch(calls, {
    'GET /data.json': oversized,
    'GET /api/notes': badNotes,
    'GET /api/ops': badOps,
  }));
  const asMap = Object.fromEntries(attempts.map(a => [a.attackId,a.observed]));
  for (const id of ['stage12_static_data_redaction','anonymous_notes_denied','stage12_operations_snapshot']) {
    assert.match(asMap[id], /미확인/u);
  }
  assert.ok(!JSON.stringify(attempts).includes('do not emit'));
  assert.ok(!JSON.stringify(attempts).includes('do not read this'));
});

test('sandbox-style Node import allowlist does not traverse node:os or node:fs/promises', t => {
  // Run the public Stage12 entry under the same Node builtin import constraint
  // without touching repository files or sending network requests.
  const script = [
    "import { registerHooks } from 'node:module';",
    "if (typeof registerHooks !== 'function') process.exit(80);",
    "registerHooks({resolve(specifier, context, nextResolve) {",
    "  const permitted = new Set(['node:fs','node:path','node:url','node:child_process','node:crypto']);",
    "  if (specifier.startsWith('node:') && !permitted.has(specifier)) throw new Error('UNSUPPORTED_MODULE:' + specifier);",
    "  return nextResolve(specifier, context);",
    "}});",
    "globalThis.fetch = async () => { throw new Error('offline'); };",
    "const { runAttackChecks } = await import('./src/attack-check.mjs');",
    "const config = (await import('./aleph.config.json', {with:{type:'json'}})).default;",
    "const checks = await runAttackChecks(config);",
    "if (checks.length !== 20 || checks.some(x => x.observed !== 'not_run')) process.exit(81);",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd:root, encoding:'utf8', timeout:15000,
  });
  if (child.status === 80) t.skip('Node version lacks module.registerHooks');
  else assert.equal(child.status, 0, child.stderr);
});

test('bonus contract: policy decisions use only documented request properties and registered ruleIds', async () => {
  const { decide, RULE_IDS } = await import('../src/decider.mjs');
  const { fixtureRequests } = await import('../scripts/fixture-7.mjs');
  const { normal } = fixtureRequests();
  const allowedReasons = new Set(['starter_not_ready','device_not_registered',
    'approved','step_up_required']);
  const allowedKeys = [
    'schema','requestId','classId','projectId','subjectId','deviceId',
    'service','method','path','route','queryLength','querySha256',
    'at','policyRevision','deviceRegistered','stepUp','recentEvents','signals',
  ];
  const mutations = [
    undefined, null, '', 0, false, [], {}, 'unexpected',
    {verified:false,authAgeSeconds:null}, {verified:true,authAgeSeconds:950},
    [{kind:'risk_signal',ageSeconds:30,count:22}],
  ];
  let examined = 0;
  for (let index = 0; index < 1100; index++) {
    const input = { ...normal, stepUp: {...normal.stepUp},
      signals: {...normal.signals}, recentEvents: [...normal.recentEvents] };
    if (index % 13 !== 0) {
      const key = allowedKeys[index % allowedKeys.length];
      input[key] = mutations[Math.floor(index / allowedKeys.length) % mutations.length];
    }
    for (const excluded of ['role','identity','device','geo']) {
      Object.defineProperty(input, excluded, {
        get() { throw new Error('undeclared request property read: ' + excluded); },
      });
    }
    const result = decide(input);
    assert.deepEqual(Object.keys(result).sort(),
      ['decision','reasonCode','requestId','ruleIds','schema']);
    assert.equal(result.schema, 'aleph.decision.v1');
    assert.equal(result.requestId, typeof input.requestId === 'string' ? input.requestId : '');
    assert.ok(['allow','deny','step_up'].includes(result.decision));
    assert.ok(allowedReasons.has(result.reasonCode));
    assert.ok(Array.isArray(result.ruleIds) && result.ruleIds.length > 0);
    assert.ok(result.ruleIds.every(id => RULE_IDS.includes(id)));
    examined++;
  }
  assert.equal(examined, 1100);
});


test('entire bundle rejects ALL child processes and every forbidden builtin import', () => {
  // Unlike the previous self-selected Git whitelist, this test allows ZERO
  // child_process imports. It executes the real bundle entry and validates
  // the HTTP boundary at the same time, not just one helper in isolation.
  const code = [
    "import { registerHooks } from 'node:module';",
    "registerHooks({ resolve(specifier, context, nextResolve) {",
    "  const permitted = new Set(['node:fs','node:path','node:url','node:crypto']);",
    "  if (specifier === 'node:child_process' || specifier === 'child_process')",
    "    throw new Error('FORBIDDEN_CHILD_PROCESS');",
    "  if ((specifier.startsWith('node:') || ['fs','path','url','crypto'].includes(specifier))",
    "     && !permitted.has(specifier)) throw new Error('FORBIDDEN_MODULE:' + specifier);",
    "  return nextResolve(specifier, context);",
    "} });",
    "globalThis.structuredClone = undefined;",
    "const requests=[];",
    "globalThis.fetch = async (url, options={}) => {",
    "  const target = new URL(url);",
    "  if (target.origin !== 'https://skt-aleph-defense.vercel.app'",
    "    || !['GET','HEAD'].includes(options.method) || options.body",
    "    || options.headers?.Authorization || options.headers?.authorization)",
    "    throw new Error('FORBIDDEN_HTTP_METHOD_OR_ORIGIN');",
    "  requests.push(options.method + ' ' + target.pathname + target.search);",
    "  throw new Error('network intentionally disabled');",
    "};",
    "await import('./scripts/bundle.mjs');",
    "if (process.exitCode) throw new Error('BUNDLE_FAILED');",
    "const {readFileSync} = await import('node:fs');",
    "const b=JSON.parse(readFileSync('./artifacts/submission.json','utf8'));",
    "if (b.attackAttempts.length !== 20 || b.attackAttempts.some(x => x.observed !== 'not_run'))",
    "  throw Error('UNOBSERVED_RESULT_REPORTED_AS_VERIFIED');",
    "if (requests.length !== 12 || requests.some(x => !/^(GET|HEAD) /.test(x)))",
    "  throw Error('INVALID_READONLY_REQUEST_COUNT');",
    "const manifest=JSON.parse(readFileSync('./package/bundle-commit-files.json','utf8'));",
    "if (JSON.stringify(b.changedFiles)!==JSON.stringify(manifest.files))",
    "  throw Error('INVALID_MANIFEST');",
    "console.log('ZERO_CHILD_PROCESSES; HTTPS_GET_HEAD=' + requests.length);",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd:root, encoding:'utf8', timeout:30000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /ZERO_CHILD_PROCESSES; HTTPS_GET_HEAD=12/u);
});

test('read-only HEAD parser supports detached, local refs, packed refs and worktrees', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const {join} = await import('node:path');
  const {readCurrentCommit} = await import('../scripts/bundle-commit-metadata.mjs');
  const scratch = mkdtempSync(join(tmpdir(), 'aleph-head-'));
  const headSha = 'a'.repeat(40);
  const packedSha = 'b'.repeat(40);
  try {
    mkdirSync(join(scratch,'.git','refs','heads'), {recursive:true});
    const headFile = join(scratch,'.git','HEAD');
    writeFileSync(headFile, headSha+'\n');
    assert.equal(readCurrentCommit(scratch), headSha);
    writeFileSync(headFile, 'ref: refs/heads/main\n');
    writeFileSync(join(scratch,'.git','refs','heads','main'), headSha+'\n');
    assert.equal(readCurrentCommit(scratch), headSha);
    rmSync(join(scratch,'.git','refs','heads','main'));
    writeFileSync(join(scratch,'.git','packed-refs'),
      '# pack-refs with: peeled fully-peeled\n'+packedSha+' refs/heads/main\n');
    assert.equal(readCurrentCommit(scratch), packedSha);
    writeFileSync(headFile, 'ref: refs/heads/../../etc/passwd\n');
    assert.throws(() => readCurrentCommit(scratch), /INVALID_GIT_REF/u);
    writeFileSync(headFile, 'bad commit id\n');
    assert.throws(() => readCurrentCommit(scratch), /INVALID_GIT_HEAD/u);
    // A linked worktree stores .git as a pointer file, not a directory.
    writeFileSync(headFile, headSha+'\n');
    const linked = join(scratch, 'linked');
    mkdirSync(linked);
    writeFileSync(join(linked, '.git'), 'gitdir: ../.git\n');
    assert.equal(readCurrentCommit(linked), headSha);
  } finally { rmSync(scratch,{recursive:true,force:true}); }
});

test('commit file manifest rejects path traversal and missing source files', async () => {
  const {mkdtempSync, mkdirSync,writeFileSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {readSubmissionChangedFiles} = await import('../scripts/bundle-commit-metadata.mjs');
  const scratch = mkdtempSync(join(tmpdir(), 'aleph-manifest-'));
  const manifest = join(scratch,'package','bundle-commit-files.json');
  try {
    mkdirSync(join(scratch,'package'), {recursive:true});
    const input = {schema:'aleph.defense.commit-files.v1',
      files:['package/bundle-commit-files.json','scripts/not-committed.js']};
    writeFileSync(manifest,JSON.stringify(input));
    assert.throws(()=>readSubmissionChangedFiles(scratch),/CHANGE_FILE_MISSING/u);
    input.files=['../secrets','package/bundle-commit-files.json'];
    writeFileSync(manifest,JSON.stringify(input));
    assert.throws(()=>readSubmissionChangedFiles(scratch),/INVALID_CHANGE_FILE_LIST/u);
    writeFileSync(manifest,JSON.stringify({schema:'aleph.defense.commit-files.v1',files:[]}));
    assert.throws(()=>readSubmissionChangedFiles(scratch),/INVALID_CHANGE_MANIFEST/u);
    writeFileSync(manifest,JSON.stringify({schema:'aleph.defense.commit-files.v1',files:['package/bundle-commit-files.json']}));
    assert.deepEqual(readSubmissionChangedFiles(scratch),['package/bundle-commit-files.json']);
  } finally {rmSync(scratch,{recursive:true,force:true});}
});
test('declared commit files match the sorted name-only diff of HEAD', async () => {
  const {readFileSync} = await import('node:fs');
  const list = JSON.parse(readFileSync(new URL('../package/bundle-commit-files.json', import.meta.url), 'utf8')).files;
  const diff = spawnSync('git', ['diff', '--name-only', 'HEAD^', 'HEAD'], {cwd: root, encoding: 'utf8'});
  assert.equal(diff.status, 0, diff.stderr);
  const actual = diff.stdout.trim().split(/\r?\n/u).sort();
  assert.deepEqual(list, actual);
});
test('regular clone never opens missing .git/commondir, including the full bundle', () => {
  const program = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "const read = fs.readFileSync;",
    "fs.readFileSync = (path, ...args) => {",
    "  if (String(path).replaceAll('\\\\', '/').endsWith('/.git/commondir'))",
    "    throw Error('UNSUPPORTED_MISSING_COMMONDIR_READ');",
    "  return read(path, ...args);",
    "};",
    "syncBuiltinESMExports();",
    "globalThis.fetch = async () => { throw Error('isolated network'); };",
    "await import('./scripts/bundle.mjs');",
    "if (process.exitCode) throw Error('BUNDLE_FAILED');",
    "const b = JSON.parse(read('./artifacts/submission.json','utf8'));",
    "if (b.attackAttempts.length !== 20) throw Error('INVALID_ATTACK_ATTEMPTS');",
    "console.log('NO_MISSING_COMMONDIR_READ');",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module','-e', program], {
    cwd:root, encoding:'utf8', timeout:30000
  });
  assert.equal(child.status,0,child.stderr || child.stdout);
  assert.match(child.stdout,/NO_MISSING_COMMONDIR_READ/u);
});

test('Stage12 validates tracked bundle notes and returns fresh resource zones without structuredClone', async () => {
  const { readFileSync } = await import('node:fs');
  const { validateBundleNotes } = await import('../scripts/bundle-notes-validation.mjs');
  const { validateOriginalApiUrl, validateResourceZones } = await import('../scripts/config-contract.mjs');
  const notes = JSON.parse(readFileSync('package/bundle-notes.template.json', 'utf8'));
  assert.equal(validateBundleNotes(notes, config.step), notes.explanation.trim());
  assert.equal(validateOriginalApiUrl(config), config.originalApiUrl);

  const oldClone = globalThis.structuredClone;
  try {
    globalThis.structuredClone = undefined;
    const first = validateResourceZones(config);
    first.memo.apiPath = '/tampered';
    const next = validateResourceZones(config);
    assert.equal(next.memo.apiPath, '/api/notes/:id',
      'resource zone result must be allocated afresh');
  } finally { globalThis.structuredClone = oldClone; }
});

test('entire Stage12 bundle works with structuredClone unavailable and network blocked', () => {
  const code = [
    "globalThis.structuredClone = undefined;",
    "globalThis.fetch = async () => { throw Error('offline'); };",
    "await import('./scripts/bundle.mjs');",
    "if (process.exitCode) throw Error('BUNDLE_FAILED');",
    "const fs = await import('node:fs');",
    "const result = JSON.parse(fs.readFileSync('artifacts/submission.json', 'utf8'));",
    "const config=JSON.parse(fs.readFileSync('aleph.config.json','utf8'));",
    "if (result.repoUrl !== config.repoUrl) throw Error('BUNDLE_REPOSITORY_MISMATCH');",
    "if (result.step !== 12 || result.attackAttempts.length !== 20)",
    "  throw Error('INVALID_BUNDLE');",
    "if (result.attackAttempts.some(a => a.observed !== 'not_run'))",
    "  throw Error('FALSE_EVIDENCE');",
    "console.log('NO_STRUCTURED_CLONE_REQUIRED');",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd:root, encoding:'utf8', timeout:30000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /NO_STRUCTURED_CLONE_REQUIRED/u);
});

test('invalid Stage8 resource zone is not misreported as a Stage5 URL error', () => {
  const code = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "const read = fs.readFileSync;",
    "fs.readFileSync = (path, ...opts) => {",
    "  const value = read(path, ...opts);",
    "  if (String(path).endsWith('/aleph.config.json')) {",
    "    const config = JSON.parse(value);",
    "    config.resourceZones.memo.apiPath = '/invalid/test/path';",
    "    return JSON.stringify(config);",
    "  }",
    "  return value;",
    "};",
    "syncBuiltinESMExports();",
    "globalThis.fetch = async () => { throw Error('no network'); };",
    "await import('./scripts/bundle.mjs');",
    "if (process.exitCode !== 1) throw Error('EXPECTED_FAILURE_MISSING');",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd:root, encoding:'utf8', timeout:30000,
  });
  assert.equal(child.status, 1, child.stderr || child.stdout);
  assert.match(child.stderr, /8단계 resourceZones/u);
  assert.doesNotMatch(child.stderr, /5단계 originalApiUrl/u);
});

test('tracked Stage12 notes template keeps original three-line rationale', async () => {
  const {validateBundleNotes}=await import('../scripts/bundle-notes-validation.mjs');
  const {readFileSync}=await import('node:fs');
  const template=JSON.parse(readFileSync('package/bundle-notes.template.json','utf8'));
  const validated=validateBundleNotes(template,config.step);
  assert.equal(validated.split(/\r?\n/u).filter(line=>line.trim()).length,3);
  assert.match(validated,/미실행/u);
  const manifest=JSON.parse(readFileSync('package/bundle-commit-files.json','utf8'));
  assert.ok(!manifest.files.includes('bundle-notes.json'),
    'private student notes must not become tracked submission files');
});

test('deployment identity reports configured production alias, not transient VERCEL_URL', async () => {
  const {deploymentIdentity}=await import('../scripts/deployment-identity.mjs');
  const meta={
    VERCEL_GIT_PROVIDER:'github',
    VERCEL_GIT_REPO_OWNER:'youngjinphys',
    VERCEL_GIT_REPO_SLUG:'Claire',
    VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),
    VERCEL_URL:'choi-bujang-secret-vault-unique.vercel.app',
  };
  const manifest=deploymentIdentity(meta,config);
  assert.equal(manifest.publicAppUrl,config.publicAppUrl);
  assert.equal(manifest.repoUrl,config.repoUrl);
  assert.notEqual(manifest.publicAppUrl,'https://'+meta.VERCEL_URL);
  assert.throws(()=>deploymentIdentity({...meta,VERCEL_GIT_REPO_SLUG:'choi-bujang-secret-vault'},config),
    /배포 GitHub 저장소/u);
  assert.throws(()=>deploymentIdentity(meta,{...config,repoUrl:'https://github.com/youngjinphys/other-project'}),
    /배포 GitHub 저장소/u);
  assert.equal(manifest.originalApiUrl,config.originalApiUrl);
  assert.throws(()=>deploymentIdentity(meta,{...config,publicAppUrl:'https://untrusted.example/'}),
    /배포 식별 정보/u);
});

test('entire isolated bundle stays valid when global URL and structuredClone are unavailable', () => {
  const script=[
    "import {URL as NodeURL} from 'node:url';",
    "globalThis.URL=undefined;",
    "globalThis.structuredClone=undefined;",
    "let requests=0;",
    "globalThis.fetch=async (url, options={})=>{",
    "  const target=new NodeURL(url);",
    "  if(target.origin!=='https://skt-aleph-defense.vercel.app'",
    "    || !['GET','HEAD'].includes(options.method)) throw Error('UNSAFE_REQUEST');",
    "  requests++;throw Error('network blocked by sandbox');",
    "};",
    "await import('./scripts/bundle.mjs');",
    "if(process.exitCode)throw Error('BUNDLE_FAILURE');",
    "const {readFileSync}=await import('node:fs');",
    "const bundle=JSON.parse(readFileSync('./artifacts/submission.json','utf8'));",
    "if(bundle.attackAttempts.length!==20 || bundle.attackAttempts.some(x=>x.observed!=='not_run'))",
    "  throw Error('MISREPORTED_EVIDENCE');",
    "if(requests!==12)throw Error('MISSING_READONLY_CHECKS');",
    "console.log('SAFE_WITHOUT_GLOBAL_URL_OR_STRUCTUREDCLONE');",
  ].join('\n');
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{
    cwd:root,encoding:'utf8',timeout:30000
  });
  assert.equal(child.status,0,child.stderr||child.stdout);
  assert.match(child.stdout,/SAFE_WITHOUT_GLOBAL_URL_OR_STRUCTUREDCLONE/u);
});
test('Stage12 ignores private bundle-notes.json in the restricted checkout', () => {
  const script = [
    "import fs from 'node:fs';",
    "import {syncBuiltinESMExports} from 'node:module';",
    "const originalRead = fs.readFileSync;",
    "fs.readFileSync = (path,...args) => {",
    "  if (String(path).endsWith('/bundle-notes.json')) throw Error('PRIVATE_NOTES_READ');",
    "  return originalRead(path,...args);",
    "};",
    "syncBuiltinESMExports();",
    "globalThis.fetch = async () => {throw Error('network blocked');};",
    "await import('./scripts/bundle.mjs');",
    "if (process.exitCode) throw Error('BUNDLE_FAILED');",
    "const b = JSON.parse(originalRead('./artifacts/submission.json','utf8'));",
    "const template = JSON.parse(originalRead('./package/bundle-notes.template.json','utf8'));",
    "if (b.explanation !== template.explanation) throw Error('INCORRECT_THREE_LINE_NOTES');",
    "console.log('PRIVATE_NOTES_NOT_READ');",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module','-e',script],{
    cwd:root, encoding:'utf8',timeout:30000
  });
  assert.equal(child.status,0,child.stderr||child.stdout);
  assert.match(child.stdout,/PRIVATE_NOTES_NOT_READ/u);
});

test('twelve server responses are individually attributed to the actual method, URL, status and x-vercel-id', async () => {
  const calls = [];
  let sequence = 0;
  const fetcher = mockFetch(calls);
  const attempts = await runStage12ReadOnlyChecks(config, origin, async (url, options) => {
    const response = await fetcher(url, options);
    // Unit-test-only simulated server header, never used as a live observation.
    response.headers.set('x-vercel-id', 'icn1::unit-' + (++sequence) + '-abc123');
    return response;
  });
  const expected = {
    stage11_manifest_present: ['GET', '/manifest.webmanifest', 200],
    stage11_device_status_denied: ['GET', '/api/device?action=status', 401],
    stage12_operations_snapshot: ['GET', '/api/ops', 200],
    deployed_restore_route: ['GET', '/aleph.json', 200],
    existing_browser_ui: ['GET', '/', 200],
    anonymous_notes_denied: ['GET', '/api/notes', 401],
    recovery_default_fail_closed: ['GET', '/api/restore/notes/' + fixture, 503],
    stage12_static_data_redaction: ['GET', '/data.json', 200],
    stage12_security_headers: ['HEAD', '/', 200],
    stage12_anonymous_notice_denied: ['GET', '/api/announcements/' + fixture, 401],
    stage12_anonymous_item_denied: ['GET', '/api/notes/' + fixture, 401],
    stage12_auth_method_guard: ['GET', '/api/auth?action=login', 405],
  };
  const actual = attempts.filter(record => record.observed !== 'not_run');
  assert.equal(actual.length, 12);
  assert.equal(calls.length, 12);
  const ids = new Set();
  for (const record of actual) {
    const [method, path, status] = expected[record.attackId] || [];
    assert.ok(method, 'never invent additional response-backed probes');
    const url = new URL(path, origin).href;
    assert.ok(record.observed.startsWith(method + ' ' + url + ' HTTP ' + status + '; '),
      record.attackId + ': ' + record.observed);
    const match = /; requestId=x-vercel-id:(icn1::unit-\d+-abc123);/u.exec(record.observed);
    assert.ok(match, record.attackId + ': missing response-bound server ID');
    assert.ok(!ids.has(match[1]), 'each response must keep its own ID');
    ids.add(match[1]);
    assert.ok(record.observed.length <= 300);
  }
  assert.equal(ids.size, 12);
  assert.equal(attempts.filter(record => record.observed === 'not_run').length, 8);
});

test('caseId and requestKey appear only if returned verbatim by the server', async () => {
  const observed = http(401, {error:'UNAUTHORIZED'}, {
    'www-authenticate':'Bearer',
    'x-vercel-id':'icn1::unit-real-header',
    'x-case-id':'server-actual-case',
    'x-request-key':'server-actual-key',
  });
  const attempts=await runStage12ReadOnlyChecks(config,origin,mockFetch([],{
    'GET /api/notes': observed,
  }));
  const note=attempts.find(a=>a.attackId==='anonymous_notes_denied').observed;
  assert.match(note,/requestId=x-vercel-id:icn1::unit-real-header/u);
  assert.match(note,/caseId=server-actual-case/u);
  assert.match(note,/requestKey=server-actual-key/u);
  const anonymousPage=attempts.find(a=>a.attackId==='existing_browser_ui').observed;
  // No default fixture invents official judge correlation headers.
  assert.doesNotMatch(anonymousPage,/caseId=|requestKey=/u);
  assert.doesNotMatch(anonymousPage,/server-actual-case|server-actual-key/u);
  assert.equal(attempts.filter(a=>a.observed==='not_run').length,8);
});

test('unavailable or malformed server request IDs are never fabricated', async () => {
  const notes = http(401, {error:'UNAUTHORIZED'}, {
    'www-authenticate':'Bearer',
    'x-vercel-id':'invalid id with spaces',
    'x-request-id':'edge-safe-001',
  });
  const calls = [];
  const attempts = await runStage12ReadOnlyChecks(config, origin, mockFetch(calls, {
    'GET /api/notes': notes,
  }));
  const byId = Object.fromEntries(attempts.map(item => [item.attackId, item.observed]));
  assert.match(byId.anonymous_notes_denied,
    /GET https:\/\/skt-aleph-defense\.vercel\.app\/api\/notes HTTP 401; requestId=x-request-id:edge-safe-001;/u);
  assert.doesNotMatch(byId.anonymous_notes_denied, /invalid id with spaces/u);
  assert.match(byId.stage11_manifest_present,
    /HTTP 200; requestId=unavailable;/u);
  assert.equal(calls.length, 12);
});

test('no HTTP response means not_run even when all twelve string requests were attempted', async () => {
  const attempted = [];
  const checks = await runStage12ReadOnlyChecks(config, origin, async (url, options) => {
    assert.equal(typeof url, 'string');
    const target = new URL(url);
    assert.equal(target.origin, origin.origin);
    assert.ok(options.method === 'GET' || options.method === 'HEAD');
    attempted.push(options.method + ' ' + target.pathname + target.search);
    return undefined;
  });
  assert.equal(attempted.length, 12);
  assert.equal(new Set(attempted).size, 12);
  assert.equal(checks.length, 20);
  assert.ok(checks.every(item => item.observed === 'not_run'));
});

test('HTTP responses without judge headers retain their actual method, URL and status', async () => {
  const calls=[];
  const checks=await runStage12ReadOnlyChecks(config,origin,mockFetch(calls));
  assert.equal(calls.length,12);
  assert.equal(checks.filter(x=>x.observed==='not_run').length,8);
  const checked=checks.filter(x=>x.observed!=='not_run');
  assert.equal(checked.length,12);
  assert.ok(checked.every(x=>/^(GET|HEAD) https:\/\/skt-aleph-defense\.vercel\.app\/.* HTTP (?:200|401|405|503); requestId=unavailable;/u.test(x.observed)));
  assert.ok(checked.every(x=>!/caseId=|requestKey=/u.test(x.observed)));
});

test('optional judge correlation headers never change whether HTTP was observed', async () => {
  // Unit-test-only headers. These do not establish actual judge acceptance.
  const correlated = new Set(['/aleph.json','/data.json','/api/notes']);
  const fetcher = mockFetch([]);
  const attempts = await runStage12ReadOnlyChecks(config,origin,async (url,options)=>{
    const response=await fetcher(url,options);
    if(correlated.has(new URL(url).pathname)) response.headers.set('x-case-id','fixture-correlation');
    return response;
  });
  const checked=attempts.filter(x=>x.observed!=='not_run');
  assert.equal(checked.length,12);
  assert.equal(checked.filter(x=>x.observed.includes('caseId=fixture-correlation')).length,3);
  assert.equal(attempts.filter(x=>x.observed==='not_run').length,8);
});

test('Stage12 memo output preserves the three statements and strips only extra blank lines', async () => {
  const {validateBundleNotes}=await import('../scripts/bundle-notes-validation.mjs');
  const {readFileSync}=await import('node:fs');
  const original=JSON.parse(readFileSync('package/bundle-notes.template.json','utf8'));
  const lines=original.explanation.split('\n');
  assert.equal(lines.length,3);
  const decorated='  \r\n'+lines[0]+'\r\n\r\n'+lines[1]+'\r\n'+lines[2]+'\r\n';
  assert.equal(validateBundleNotes({...original,explanation:decorated},12),lines.join('\n'));
  assert.throws(()=>validateBundleNotes({
    explanation:original.explanation+'\n추가되거나 실제 검증하지 않은 사실을 기재하지 않습니다.'
  },12),/정확히 세 줄/u);
});

test('Stage12 bundle rejects noncanonical configured repository URLs before network',()=>{
  const source=[
    "import fs from 'node:fs';",
    "import {syncBuiltinESMExports} from 'node:module';",
    "const original=fs.readFileSync;",
    "fs.readFileSync=(path,...args)=>{",
    "  const data=original(path,...args);",
    "  if(String(path).endsWith('/aleph.config.json')){",
    "    const config=JSON.parse(data);config.repoUrl += '/';",
    "    return JSON.stringify(config);",
    "  }",
    "  return data;",
    "};",
    "syncBuiltinESMExports();",
    "globalThis.fetch=async()=>{throw Error('NETWORK_MUST_NOT_RUN');};",
    "await import('./scripts/bundle.mjs');",
    "if(process.exitCode!==1)throw Error('BUNDLE_MUST_REJECT_INVALID_REPO_URL');",
  ].join('\n');
  const child=spawnSync(process.execPath,['--input-type=module','-e',source],{
    cwd:root,encoding:'utf8',timeout:30000
  });
  assert.equal(child.status,1,child.stderr||child.stdout);
  assert.match(child.stderr,/12단계 제출 저장소 URL/u);
  assert.doesNotMatch(child.stderr,/NETWORK_MUST_NOT_RUN/u);
});
