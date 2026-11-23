import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const clientDirectory = fileURLToPath(new URL('../', import.meta.url));
const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const launcherPath = fileURLToPath(new URL('../tools/start-alekov.ps1', import.meta.url));
const identityHeader = 'x-claire-process-id';
const gateMarker = 'SYNTHETIC_STARTUP_GATE_READY';
// Hold only this synthetic child's pre-main startup. Releasing the pipe runs
// the actual, unchanged CLI entry point and its actual listen/error behavior.
const startupGate = `await new Promise(resolve => { process.stdin.once('data', resolve); process.stdout.write('${gateMarker}\\n'); }); process.stdin.pause();`;
const alive = entry => entry.child.exitCode === null && entry.child.signalCode === null;

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function bindAndRelease(port = 0) {
  const listener = net.createServer();
  listener.listen(port, '127.0.0.1');
  await once(listener, 'listening');
  const selected = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return selected;
}

async function startCli(t, port, { gated = false } = {}) {
  // Retain only Windows OS runtime essentials, never application adapters,
  // project scanning configuration, native settings or credentials.
  const env = { ON_PORT: String(port) };
  for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name];
  const args = gated ? ['--import', `data:text/javascript,${encodeURIComponent(startupGate)}`, serverPath] : [serverPath];
  const child = spawn(process.execPath, args, { cwd: clientDirectory, env, windowsHide: true,
    stdio: [gated ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
  const exited = new Promise((resolve, reject) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  void exited.catch(() => {});
  const entry = { child, exited, output: () => ({ stdout, stderr }) };
  t.after(async () => {
    if (alive(entry)) child.kill('SIGTERM');
    try { await bounded(exited, 3000, 'Owned synthetic child did not stop'); }
    catch (error) {
      if (!alive(entry)) throw error;
      child.kill('SIGKILL');
      await bounded(exited, 3000, 'Owned synthetic child did not stop after forced cleanup');
    }
  });
  await once(child, 'spawn');
  if (gated) {
    const deadline = performance.now() + 5000;
    while (!stdout.includes(gateMarker) && alive(entry) && performance.now() < deadline) await delay(10);
    assert.ok(stdout.includes(gateMarker), 'The synthetic child must reach its controlled startup boundary');
    assert.ok(alive(entry));
  }
  return entry;
}

function readHeaders(port, { path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const request = http.get({ host: '127.0.0.1', port, path, headers, agent: false }, response => {
      clearTimeout(timer);
      const result = { status: response.statusCode, headers: response.headers, rawHeaders: response.rawHeaders };
      // Attribution needs only the headers; neither test nor launcher buffers
      // a readiness response body.
      response.destroy();
      resolve(result);
    });
    request.once('error', error => { clearTimeout(timer); reject(error); });
    timer = setTimeout(() => request.destroy(new Error('Synthetic readiness HTTP deadline')), 1000);
  });
}

async function ready(entry, port) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline && alive(entry)) {
    try {
      const response = await readHeaders(port);
      if (response.status === 200) return response;
    } catch { /* A starting CLI has not bound yet. */ }
    await delay(10);
  }
  assert.fail(`Actual disconnected CLI did not listen: ${entry.output().stderr}`);
}

function assertOwnIdentity(response, entry) {
  assert.equal(response.status, 200);
  assert.equal(response.headers[identityHeader], String(entry.child.pid));
  const names = response.rawHeaders.filter((_, index) => index % 2 === 0);
  assert.equal(names.filter(name => name.toLowerCase() === identityHeader).length, 1);
  assert.ok(alive(entry));
}

async function rejectCompetingBind(second) {
  second.child.stdin.end('continue\n');
  const exit = await bounded(second.exited, 5000, 'Competing actual CLI did not report its bind failure');
  assert.equal(exit.code, 1);
  assert.match(second.output().stderr, /EADDRINUSE/u);
  assert.doesNotMatch(second.output().stdout, /Claire .*http:\/\/127\.0\.0\.1/u);
}

test('actual CLI publishes one own PID only on successful root readiness responses', { timeout: 15000 }, async t => {
  const port = await bindAndRelease();
  const server = await startCli(t, port);
  assertOwnIdentity(await ready(server, port), server);
  // A request cannot supply or replace the answering process's identity.
  assertOwnIdentity(await readHeaders(port, { headers: { [identityHeader]: '42' } }), server);
  for (const [options, status] of [
    [{ path: '/index.html' }, 200],
    [{ path: '/missing-readiness-route' }, 404],
    [{ path: '/?readiness=1' }, 400],
    [{ headers: { Host: `unexpected.example:${port}` } }, 403],
  ]) {
    const response = await readHeaders(port, options);
    assert.equal(response.status, status);
    assert.equal(response.headers[identityHeader], undefined);
  }
});

test('real competing CLI cannot attribute the first listener response to its still-live child', { timeout: 15000 }, async t => {
  const port = await bindAndRelease();
  await bindAndRelease(port); // Both launcher-style checks succeed and release.
  const first = await startCli(t, port);
  assertOwnIdentity(await ready(first, port), first);
  const second = await startCli(t, port, { gated: true });
  assert.ok(alive(second));
  const response = await readHeaders(port);
  assertOwnIdentity(response, first);
  assert.notEqual(response.headers[identityHeader], String(second.child.pid));
  assert.ok(alive(second), 'Rejection must not depend on the losing child already exiting');
  await rejectCompetingBind(second);
  assertOwnIdentity(await readHeaders(port), first);
});

// Fixture ceiling: CLI preparation ~10 s + one PowerShell process 30 s +
// verification 6 s + two owned-child cleanup paths 12 s, with setup headroom.
// The subprocess owns its timeout; node:test cannot preempt a synchronous spawn.
test('actual PowerShell readiness accepts its listening CLI and rejects another live CLI on that port', { timeout: 75000 }, async t => {
  const command = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const port = await bindAndRelease();
  await bindAndRelease(port);
  const first = await startCli(t, port);
  assertOwnIdentity(await ready(first, port), first);
  const second = await startCli(t, port, { gated: true });
  const quotedLauncher = `'${launcherPath.replaceAll("'", "''")}'`;
  // Evaluate actual function definitions only, never copied readiness logic or
  // the launcher's configuration/policy/process-start statements.
  const program = `
[Console]::Error.WriteLine('CLAIRE_READINESS_PHASE scriptentered')
Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$tokens=$null; $parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${quotedLauncher}, [ref]$tokens, [ref]$parseErrors)
if ($null -ne $parseErrors -and $parseErrors.Length -gt 0) { throw ($parseErrors | Out-String) }
$wanted=@('Initialize-AlekovReadinessHttp','Start-AlekovReadinessProbe','Stop-AlekovReadinessProbe','Test-AlekovReadinessActive','Get-AlekovReadinessRemaining','Wait-AlekovReadiness')
$functions=@($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $node.Name }, $true))
if ($functions.Count -ne $wanted.Count) { throw 'Actual production readiness functions were not found' }
foreach ($function in $functions) { Invoke-Expression ($function.Extent.Text) }
[Console]::Error.WriteLine('CLAIRE_READINESS_PHASE functionsloaded')
Initialize-AlekovReadinessHttp
[Console]::Error.WriteLine('CLAIRE_READINESS_PHASE transportinitialized')
$listening=[Diagnostics.Process]::GetProcessById(${first.child.pid})
$competing=[Diagnostics.Process]::GetProcessById(${second.child.pid})
try {
  $own=Wait-AlekovReadiness $listening 'http://127.0.0.1:${port}/' 3000 ([Diagnostics.Stopwatch]::StartNew())
  [Console]::Error.WriteLine('CLAIRE_READINESS_PHASE ownfinished')
  $other=Wait-AlekovReadiness $competing 'http://127.0.0.1:${port}/' 1000 ([Diagnostics.Stopwatch]::StartNew())
  [Console]::Error.WriteLine('CLAIRE_READINESS_PHASE competingfinished')
  $listening.Refresh(); $competing.Refresh()
  [pscustomobject]@{own=$own; competing=$other; firstAlive=(-not $listening.HasExited); secondAlive=(-not $competing.HasExited)} | ConvertTo-Json -Compress
} finally { $listening.Dispose(); $competing.Dispose() }
`;
  // Interpreter startup/AST compilation share this fixture envelope. The actual
  // production checks above retain their 3000 ms and 1000 ms deadlines.
  const started = performance.now();
  const result = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', program], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  const diagnostics = [
    `PowerShell readiness fixture: ${JSON.stringify({ status: result.status, errorCode: result.error?.code ?? null,
      signal: result.signal, elapsedMs: performance.now() - started })}`,
    result.stderr, result.error?.message, result.stdout,
  ].filter(Boolean).join('\n');
  if (result.error?.code === 'ENOENT' && process.platform !== 'win32') {
    t.skip('PowerShell is unavailable locally; Windows CI executes production readiness against real competing CLI instances');
    return;
  }
  // A timed-out child can handle SIGTERM and still report status 0 with valid JSON.
  assert.equal(result.error, undefined, diagnostics);
  assert.equal(result.status, 0, diagnostics);
  let observed;
  assert.doesNotThrow(() => { observed = JSON.parse(result.stdout.replace(/^\uFEFF/u, '').trim()); }, diagnostics);
  assert.deepEqual(observed, {
    own: true, competing: false, firstAlive: true, secondAlive: true,
  }, diagnostics);
  await rejectCompetingBind(second);
  assertOwnIdentity(await readHeaders(port), first);
});
