import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createProjectScanner } from '../src/vulnerabilities/project-scan.mjs';
import { OSV_QUERY_BATCH_URL } from '../src/vulnerabilities/osv.mjs';
import { createVaultOnAiService } from '../src/ai/vault-service.mjs';
import { captureOnAiIncident } from '../src/ai/service.mjs';

const context = { subjectId: 'student', alephUserId: 'aleph-user', siteId: 'site', identityVersion: 1, projectId: 'review-project' };
const scope = { subjectId: context.subjectId, projectId: context.projectId, appId: 'aleph-on', audience: 'on-client' };
const identity = { alephUserId: context.alephUserId, siteId: context.siteId, identityVersion: 1 };
const incident = { incidentId: 'synthetic-incident', evidence: [{ id: 'evidence-1', summary: 'Synthetic failed login observation' }],
  rules: [{ id: 'rule-1', description: 'Synthetic review rule' }],
  currentState: { access: 'unknown', session: 'unknown', device: 'unknown' }, supportedActions: [] };
const baseUrl = 'https://ai-classroom-gateway-production.up.railway.app/api/apps/aleph-on/v1';
const credential = () => ({ schema: 'alekov.app-connect.credential.v1', appId: 'aleph-on', audience: 'on-client', ...context,
  grantId: 'grant', grantVersion: 1, credentialId: 'credential', policyVersion: 'policy', accessPolicyId: 'access',
  baseUrl, token: 'sk-on-' + 'x'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' });
const hash = value => createHash('sha256').update(value).digest('hex');
const checkedAt = '2026-11-01T00:00:00.000Z';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const osvRow = (query, vulnerabilities = []) => ({ name: query.package.name, version: query.version,
  status: vulnerabilities.length ? 'known_vulnerabilities' : 'none_found', vulnerabilities, source: OSV_QUERY_BATCH_URL, checkedAt });

function clock(t) {
  let current = 0;
  const wall = Date.now();
  t.mock.method(performance, 'now', () => current);
  t.mock.method(Date, 'now', () => wall);
  return value => { current = value; };
}

async function project(t, names = ['example']) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'claire-project-deadline-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packages = { '': { name: 'synthetic-project', version: '1.0.0' } };
  for (const name of names) {
    packages['node_modules/' + name] = { version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz` };
    await mkdir(join(directory, 'node_modules', name), { recursive: true });
    await writeFile(join(directory, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  return directory;
}

test('project scanner cannot publish complete after synchronous client work exhausts its deadline', async t => {
  const directory = await project(t), advance = clock(t);
  const scanner = createProjectScanner({ projectDirectory: directory, approvedPublicPackages: ['example'], client: {
    lookupPackages: async queries => { advance(10000); return queries.map(query => ({ name: query.package.name, version: query.version,
      status: 'none_found', vulnerabilities: [], source: OSV_QUERY_BATCH_URL, checkedAt })); },
  } });
  const result = await scanner.scan();
  assert.equal(result.status, 'partial');
  assert.equal(result.packages[0].status, 'unverifiable');
});

test('project validation expiry retains earlier findings while withdrawing every clean/current claim', async t => {
  const directory = await project(t, ['example', 'second']), advance = clock(t);
  const finding = { id: 'OSV-SYNTHETIC', modified: checkedAt };
  const scanner = createProjectScanner({ projectDirectory: directory, approvedPublicPackages: ['example', 'second'], client: {
    lookupPackages: async queries => {
      const rows = [osvRow(queries[0], [finding]), osvRow(queries[1])];
      Object.defineProperty(rows[1], 'vulnerabilities', { get() { advance(10000); return []; } });
      return rows;
    },
  } });
  const result = await scanner.scan();
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.packages.map(row => row.status), ['unverifiable', 'unverifiable']);
  assert.deepEqual(result.packages[0].vulnerabilities, [finding]);
});

test('project scanner preserves valid completion and rejects a changed installed source', async t => {
  const directory = await project(t);
  const clean = createProjectScanner({ projectDirectory: directory, approvedPublicPackages: ['example'], client: {
    lookupPackages: async queries => queries.map(query => osvRow(query)),
  } });
  const result = await clean.scan();
  assert.equal(result.status, 'complete');
  assert.equal(result.packages[0].status, 'none_found');
  const changed = createProjectScanner({ projectDirectory: directory, approvedPublicPackages: ['example'], client: {
    lookupPackages: async queries => {
      await writeFile(join(directory, 'node_modules', 'example', 'package.json'), JSON.stringify({ name: 'example', version: '2.0.0' }));
      return queries.map(query => osvRow(query));
    },
  } });
  const invalidated = await changed.scan();
  assert.equal(invalidated.status, 'partial');
  assert.equal(invalidated.packages[0].status, 'unverifiable');
});

test('project scanner cancellation disposes a delayed client result without changing the published partial report', async t => {
  const directory = await project(t), gate = deferred(), reached = deferred(), controller = new AbortController();
  const scanner = createProjectScanner({ projectDirectory: directory, approvedPublicPackages: ['example'], client: {
    lookupPackages: async queries => { reached.resolve(queries); return gate.promise; },
  } });
  const pending = scanner.scan({ signal: controller.signal }), queries = await reached.promise;
  controller.abort();
  const result = await pending, snapshot = JSON.stringify(result);
  assert.equal(result.status, 'partial');
  gate.resolve(queries.map(query => osvRow(query)));
  await tick();
  assert.equal(JSON.stringify(result), snapshot);
  assert.equal(result.packages[0].status, 'unverifiable');
});

let fixtureId = 0;
async function serviceFixture(createOnAiService) {
  const key = `__vaultServiceDeadlineFixture${++fixtureId}`;
  globalThis[key] = { createOnAiService, captureOnAiIncident };
  let source = await readFile(new URL('../src/ai/vault-service.mjs', import.meta.url), 'utf8');
  source = source.replace("import {createOnAiService,captureOnAiIncident} from './service.mjs';", `const {createOnAiService,captureOnAiIncident}=globalThis.${key};`)
    .replace("from './app-authorization.mjs'", `from '${new URL('../src/ai/app-authorization.mjs', import.meta.url).href}'`)
    .replace("from '../learner-support/service.mjs'", `from '${new URL('../src/learner-support/service.mjs', import.meta.url).href}'`);
  try { return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createVaultOnAiService; }
  finally { delete globalThis[key]; }
}

test('vault AI plain incident operation expires after load even when wall time did not advance', async t => {
  const advance = clock(t);
  let started = 0;
  const create = await serviceFixture(() => ({ explainIncident: async () => { started++; return { ok: true }; } }));
  const service = create({ enabled: true, timeoutMs: 100, appAuthorization: {}, vault: {
    load: async () => { advance(100); return credential(); },
  } });
  const result = await service.explainIncident(incident, { expectedScope: scope, expectedContext: identity });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'WB_CLCO_TIMEOUT');
  assert.equal(started, 0);
});

test('vault AI cannot publish a late plain incident result before a delayed timer runs', async t => {
  const advance = clock(t);
  const create = await serviceFixture(() => ({ explainIncident: async () => { advance(100); return { ok: true }; } }));
  const service = create({ enabled: true, timeoutMs: 100, appAuthorization: {}, vault: { load: async () => credential() } });
  const result = await service.explainIncident(incident, { expectedScope: scope, expectedContext: identity });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'WB_CLCO_TIMEOUT');
});

for (const method of ['explainIncident', 'checkConnection']) {
  test(`vault AI ${method} gives downstream only the monotonic budget remaining after load`, async t => {
    const advance = clock(t);
    let passedTimeout;
    const create = await serviceFixture(options => {
      passedTimeout = options.timeoutMs;
      return { [method]: async () => ({ ok: true }) };
    });
    const service = create({ enabled: true, timeoutMs: 100, appAuthorization: {}, vault: {
      load: async () => { advance(40); return credential(); },
    } });
    const options = { expectedScope: scope, expectedContext: identity };
    const result = await (method === 'checkConnection' ? service[method](options) : service[method](incident, options));
    assert.equal(result.ok, true);
    assert.equal(passedTimeout, 60);
  });
}

test('vault AI cancellation during load does not dispatch a late credential', async t => {
  clock(t);
  const gate = deferred(), reached = deferred(), controller = new AbortController();
  let created = 0;
  const create = await serviceFixture(() => { created++; return { explainIncident: async () => ({ ok: true }) }; });
  const service = create({ enabled: true, timeoutMs: 100, appAuthorization: {}, vault: {
    load: async () => { reached.resolve(); return gate.promise; },
  } });
  const pending = service.explainIncident(incident, { signal: controller.signal, expectedScope: scope, expectedContext: identity });
  await reached.promise;controller.abort();
  const result = await pending;
  assert.equal(result.error.code, 'WB_CLCO_CANCELLED');
  gate.resolve(credential());await tick();
  assert.equal(created, 0);
});

test('real vault AI service never begins authorization after vault loading exhausted the outer budget', async t => {
  const advance = clock(t);
  let authorizationRequests = 0;
  const service = createVaultOnAiService({ enabled: true, timeoutMs: 100,
    appAuthorization: { fetchImpl: async () => { authorizationRequests++; return Response.json({}, { status: 401 }); } },
    vault: { load: async () => { advance(100); return credential(); } },
  });
  const result = await service.explainIncident(incident, { expectedScope: scope, expectedContext: identity });
  assert.equal(result.error.code, 'WB_CLCO_TIMEOUT');
  assert.equal(authorizationRequests, 0);
});

// Evaluate the production native protocol with only OS entry points replaced.
// No real PowerShell process, vault directory, ACL, registry or DPAPI is used.
async function nativeFixture({ advance, expireAt = null, resolveContext } = {}) {
  const state = { spawns: 0, writes: 0, commits: 0, kills: 0, destroys: 0, contexts: 0 };
  const key = `__nativeVaultDeadlineFixture${++fixtureId}`;
  const spawn = (command, args, options) => {
    state.spawns++;
    assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(options.shell, false);
    assert.deepEqual(options.env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' });
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    let request;
    child.stdin = new EventEmitter();
    child.stdin.write = message => {
      state.writes++; request = JSON.parse(message);
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ stage: 'ready', nonce: request.nonce }) + '\n'));
    };
    child.stdin.end = message => {
      state.commits++;
      assert.equal(JSON.parse(message).commit, request.nonce);
      if (expireAt === 'after-commit') advance(100);
      const result = request.action === 'load' ? null : request.action === 'save'
        ? { connectionId: request.connectionId, credentialFingerprint: hash(request.credential.token), contextFingerprint: request.contextFingerprint, persisted: true }
        : { removed: true, contextFingerprint: request.contextFingerprint, credentialFingerprint: request.credentialFingerprint };
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ ok: true, result }) + '\n');
        child.exitCode = 0;
        child.emit('close', 0);
      });
    };
    child.stdin.destroy = () => { state.destroys++; };
    child.kill = () => { state.kills++; child.exitCode = -1; return true; };
    if (expireAt === 'spawn') advance(100);
    return child;
  };
  globalThis[key] = { spawn };
  let source = await readFile(new URL('../src/ai/credential-vault.mjs', import.meta.url), 'utf8');
  source = source.replace("import {spawn} from 'node:child_process';", `const {spawn}=globalThis.${key};`)
    .replace(/const HELPER = fileURLToPath\([^\n]+\);/u, "const HELPER = 'synthetic-vault-helper.ps1';")
    .replace("process.platform !== 'win32'", 'false');
  let create;
  try { ({ createAppCredentialVault: create } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))); }
  finally { delete globalThis[key]; }
  const vault = create({ vaultRoot: 'C:\\synthetic-vault', baseUrl, timeoutMs: 100,
    resolveCurrentContext: async () => {
      state.contexts++;
      if (expireAt === state.contexts) advance(100);
      return resolveContext ? resolveContext(state.contexts) : context;
    },
  });
  return { vault, state };
}

for (const expireAt of [1, 2, 3, 'spawn', 'after-commit']) {
  test(`native vault rejects monotonic expiry at ${expireAt} without pretending to undo a possible write`, async t => {
    const advance = clock(t);
    const { vault, state } = await nativeFixture({ advance, expireAt });
    await assert.rejects(vault.persistCredential({ connectionId: 'fixture-connection', expectedContext: context, credential: credential() }),
      error => error.code === 'ALEKOV_VAULT_TIMEOUT');
    assert.equal(state.spawns, expireAt === 1 ? 0 : 1);
    assert.equal(state.writes, expireAt === 1 || expireAt === 'spawn' ? 0 : 1);
    assert.equal(state.commits, expireAt === 3 || expireAt === 'after-commit' ? 1 : 0);
    assert.ok(state.kills <= 1, 'no retry or compensating write is issued');
  });
}

for (const action of ['persistCredential', 'load', 'remove']) {
  test(`native vault ${action} still completes its isolated valid three-context protocol`, async t => {
    const advance = clock(t), { vault, state } = await nativeFixture({ advance });
    const input = { expectedContext: context };
    if (action === 'persistCredential') Object.assign(input, { connectionId: 'fixture-connection', credential: credential() });
    if (action === 'remove') input.credentialFingerprint = 'a'.repeat(64);
    const result = await vault[action](input);
    assert.equal(state.contexts, 3);
    assert.equal(state.commits, 1);
    assert.equal(state.destroys, 1);
    assert.equal(state.kills, 0);
    if (action === 'persistCredential') assert.equal(result.persisted, true);
    else if (action === 'remove') assert.equal(result.removed, true);
    else assert.equal(result, null);
  });
}

for (const changedAt of [2, 3]) {
  test(`native vault retains identity continuity checks at context ${changedAt}`, async t => {
    const advance = clock(t), { vault, state } = await nativeFixture({ advance,
      resolveContext: count => count === changedAt ? { ...context, projectId: 'different-project' } : context,
    });
    await assert.rejects(vault.persistCredential({ connectionId: 'fixture-connection', expectedContext: context, credential: credential() }),
      error => error.code === 'ALEKOV_VAULT_CONTEXT_CHANGED');
    assert.equal(state.commits, changedAt === 2 ? 0 : 1);
    assert.equal(state.destroys, 1);
  });
}

test('native vault cancellation during context lookup prevents any late process spawn', async t => {
  const advance = clock(t), gate = deferred(), reached = deferred(), controller = new AbortController();
  const { vault, state } = await nativeFixture({ advance, resolveContext: () => { reached.resolve(); return gate.promise; } });
  const pending = vault.load({ expectedContext: context }, { signal: controller.signal });
  await reached.promise;controller.abort();
  await assert.rejects(pending, error => error.code === 'ALEKOV_VAULT_CANCELLED');
  gate.resolve(context);await tick();
  assert.equal(state.spawns, 0);
  assert.equal(state.commits, 0);
});
