import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const rootPackage = JSON.parse(read('../../package.json'));
const clientPackage = JSON.parse(read('../package.json'));
const lock = JSON.parse(read('../../package-lock.json'));
const launcher = read('../tools/start-alekov.ps1');
const launcherPath = fileURLToPath(new URL('../tools/start-alekov.ps1', import.meta.url));
const psString = value => `'${value.replaceAll("'", "''")}'`;

function readinessProgram(t, body) {
  // Parse the real production file, then evaluate only its function definitions.
  // The launch/configuration/policy/process-start statements are never executed.
  const program = `
Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psString(launcherPath)}, [ref]$tokens, [ref]$parseErrors)
if ($null -ne $parseErrors -and $parseErrors.Length -gt 0) { throw ($parseErrors | Out-String) }
$wanted = @('Initialize-AlekovReadinessHttp','Start-AlekovReadinessProbe','Stop-AlekovReadinessProbe','Test-AlekovReadinessActive','Get-AlekovReadinessRemaining','Wait-AlekovReadiness')
$functions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $node.Name }, $true))
if ($functions.Count -ne $wanted.Count) { throw 'Actual production readiness functions were not found' }
foreach ($function in $functions) { Invoke-Expression ($function.Extent.Text) }
${body}
`;
  assert.ok(program.length < 28000, 'read the launcher by path rather than exceed the Windows command-line limit');
  const command = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const started = performance.now();
  const child = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', program], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  const diagnostics = [
    `PowerShell readiness contract fixture: ${JSON.stringify({ status: child.status, errorCode: child.error?.code ?? null,
      signal: child.signal, elapsedMs: performance.now() - started })}`,
    child.stderr, child.error?.message, child.stdout,
  ].filter(Boolean).join('\n');
  if (child.error?.code === 'ENOENT' && process.platform !== 'win32') {
    t.skip('PowerShell is unavailable locally; Windows CI executes the actual readiness functions and .NET transport');
    return null;
  }
  // A timed-out child can handle SIGTERM and still report status 0 with valid JSON.
  assert.equal(child.error, undefined, diagnostics);
  assert.equal(child.status, 0, diagnostics);
  return JSON.parse(child.stdout.replace(/^\uFEFF/u, '').trim());
}
// SQLite is available without a flag at 22.13/23.4; the complete regression
// suite additionally imports module.registerHooks, introduced at 22.15/23.5.
const boundaries = [
  ['21.9.0', false], ['22.0.0', false], ['22.12.0', false], ['22.13.0', false],
  ['22.14.9', false], ['22.15.0', true], ['22.16.0', true], ['22.99.0', true],
  ['23.0.0', false], ['23.4.9', false], ['23.5.0', true], ['23.11.0', true],
  ['24.0.0', true], ['24.19.0', true], ['25.0.0', false], ['25.9.0', false],
  ['26.0.0', true], ['26.9.0', true], ['27.0.0', false],
];

function satisfies(version, range) {
  const actual = version.split('.').map(Number);
  return range.split('||').some(alternative => alternative.trim().split(/\s+/u).every(comparator => {
    const match = /^(>=|>|<=|<|=)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(comparator);
    assert.ok(match, 'test supports explicit numeric engine comparisons');
    const expected = match.slice(2).map(part => Number(part ?? 0));
    const difference = actual.findIndex((part, i) => part !== expected[i]);
    const order = difference < 0 ? 0 : Math.sign(actual[difference] - expected[difference]);
    return { '>=': order >= 0, '>': order > 0, '<=': order <= 0, '<': order < 0, '=': order === 0 }[match[1]];
  }));
}

test('declared runtimes agree and include only API-capable supported release boundaries', () => {
  assert.equal(rootPackage.engines.node, clientPackage.engines.node);
  assert.equal(rootPackage.engines.node, lock.packages[''].engines.node);
  for (const [version, expected] of boundaries) {
    assert.equal(satisfies(version, rootPackage.engines.node), expected, version);
  }
  assert.match(launcher, /\$minor = \[int\]\$Matches\[2\]/u);
  assert.match(launcher, /if \(-not \(Test-SupportedNodeVersion \$major \$minor\)\)/u);
  assert.match(launcher, /-Port \$\(Get-AlternativePort \$Port\)/u);
});

test('PowerShell launcher enforces runtime boundaries and always suggests a valid alternative port', t => {
  const versionFunction = launcher.match(/^function Test-SupportedNodeVersion\([\s\S]*?^\}/mu)?.[0];
  const portFunction = launcher.match(/^function Get-AlternativePort\([\s\S]*?^\}/mu)?.[0];
  assert.ok(versionFunction && portFunction);
  // Evaluate the launcher's actual pure functions, never start a real server.
  const cases = boundaries.map(([version]) => {
    const [major, minor] = version.split('.');
    return `(Test-SupportedNodeVersion ${major} ${minor})`;
  });
  const ports = [1024, 5189, 65534, 65535];
  const program = [versionFunction, portFunction,
    `$versions = @(${cases.join(';')})`,
    `$ports = @(${ports.map(port => `(Get-AlternativePort ${port})`).join(';')})`,
    '[pscustomobject]@{versions=$versions; ports=$ports} | ConvertTo-Json -Compress',
  ].join('\n');
  const command = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  // Match readinessProgram's bounded interpreter envelope, including cold startup.
  const started = performance.now();
  const child = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', program], {
    encoding: 'utf8', timeout: 30000,
  });
  const diagnostics = [
    `PowerShell runtime boundary fixture: ${JSON.stringify({ status: child.status, errorCode: child.error?.code ?? null,
      signal: child.signal, elapsedMs: performance.now() - started })}`,
    child.stderr, child.error?.message, child.stdout,
  ].filter(Boolean).join('\n');
  if (child.error?.code === 'ENOENT' && process.platform !== 'win32') {
    t.skip('PowerShell is unavailable locally; Windows CI executes the actual functions');
    return;
  }
  // A timed-out child can handle SIGTERM and still report status 0 with valid JSON.
  assert.equal(child.error, undefined, diagnostics);
  assert.equal(child.status, 0, diagnostics);
  const result = JSON.parse(child.stdout.replace(/^\uFEFF/u, '').trim());
  assert.deepEqual(result.versions, boundaries.map(([, expected]) => expected));
  for (let i = 0; i < ports.length; i++) {
    assert.ok(Number.isInteger(result.ports[i]) && result.ports[i] >= 1024 && result.ports[i] <= 65535);
    assert.notEqual(result.ports[i], ports[i]);
  }
});

test('launcher preserves Windows encoding and initializes bounded readiness before owning a child', () => {
  const bytes = readFileSync(launcherPath);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(launcher.includes('\r\n'));
  assert.equal(launcher.replaceAll('\r\n', '').includes('\n'), false, 'preserve CRLF for Windows PowerShell');
  const initializeAt = launcher.indexOf('try { Initialize-AlekovReadinessHttp }');
  const childStartAt = launcher.indexOf('$process = [Diagnostics.Process]::Start($info)');
  assert.ok(initializeAt >= 0 && childStartAt >= 0);
  assert.ok(initializeAt < childStartAt);
  assert.match(launcher, /\$watch = \[Diagnostics\.Stopwatch\]::StartNew\(\)/u);
  assert.match(launcher, /\$ready = Wait-AlekovReadiness \$process \$url \$waitMilliseconds \$watch/u);
  assert.doesNotMatch(launcher, /\bGet-Date\b|\bInvoke-WebRequest\b|\bSet-ExecutionPolicy\b/u);
});

test('PowerShell readiness applies its actual monotonic loop and final owned-child acceptance to synthetic boundaries', t => {
  const result = readinessProgram(t, String.raw`
function Advance-Elapsed([double]$Milliseconds) { $script:fixture.Watch.Elapsed.TotalMilliseconds += $Milliseconds }
function Get-Date { $script:fixture.DateReads++; return $script:fixture.Wall }
function Start-Sleep([int]$Milliseconds) {
  [void]$script:fixture.Sleeps.Add($Milliseconds)
  Advance-Elapsed $Milliseconds
  $script:fixture.Wall = $script:fixture.Wall.AddMilliseconds($script:fixture.WallJump)
}
function Start-AlekovReadinessProbe([string]$Url, [int]$ExpectedProcessId) {
  if ($ExpectedProcessId -ne $script:fixture.Process.Id) { throw 'Readiness did not use its owned child identity' }
  $script:fixture.Requests++
  if ($script:fixture.Plan.Count -eq 0) { throw 'Unexpected extra readiness probe' }
  $step = $script:fixture.Plan.Dequeue()
  if ($step.ContainsKey('DispatchAdvance')) { Advance-Elapsed $step.DispatchAdvance }
  if ($step.ContainsKey('DispatchThrow')) { throw 'Synthetic dispatch failure' }
  $immediate = $false
  if ($step.ContainsKey('Immediate')) { $immediate = [bool]$step.Immediate }
  $task = [pscustomobject]@{ Step=$step; IsCompleted=$immediate; Result=[int]$step.Status }
  $task | Add-Member -MemberType ScriptMethod -Name Wait -Value {
    param([int]$Milliseconds)
    [void]$script:fixture.Waits.Add($Milliseconds)
    $complete = $true
    if ($this.Step.ContainsKey('WaitResult')) { $complete = [bool]$this.Step.WaitResult }
    if ($this.Step.ContainsKey('WaitAdvance')) { Advance-Elapsed $this.Step.WaitAdvance }
    elseif (-not $complete) { Advance-Elapsed $Milliseconds }
    if ($this.Step.ContainsKey('ExitDuringWait')) { $script:fixture.Process.HasExited = $true }
    if ($this.Step.ContainsKey('WaitThrow')) { throw 'Synthetic wait failure' }
    $this.IsCompleted = $complete
    return $complete
  }
  $probe = [pscustomobject]@{ Completion=$task; Step=$step }
  $probe | Add-Member -MemberType ScriptMethod -Name Cancel -Value {
    $script:fixture.Cancellations++
    if ($this.Step.ContainsKey('CleanupAdvance')) { Advance-Elapsed $this.Step.CleanupAdvance }
    if ($this.Step.ContainsKey('ExitDuringCleanup')) { $script:fixture.Process.PendingExit = $true }
    if ($this.Step.ContainsKey('CleanupThrow')) { throw 'Synthetic cancellation failure' }
  }
  return $probe
}
function New-FakeProcess([bool]$Exited) {
  $child = [pscustomobject]@{ Id=12345; HasExited=$Exited; PendingExit=$false; Refreshes=0; Kills=0 }
  $child | Add-Member -MemberType ScriptMethod -Name Refresh -Value {
    $this.Refreshes++
    if ($this.PendingExit) { $this.HasExited = $true }
  }
  $child | Add-Member -MemberType ScriptMethod -Name Kill -Value { $this.Kills++; $this.HasExited = $true }
  return $child
}
function Run-Case([string]$Name, [int]$Budget, [object[]]$Plan, [bool]$Exited=$false, [int]$WallJump=0) {
  $queue = [Collections.Queue]::new()
  foreach ($step in $Plan) { $queue.Enqueue($step) }
  $script:fixture = [pscustomobject]@{
    Watch=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=[double]0}}
    Process=(New-FakeProcess $Exited); Plan=$queue; Requests=0; Cancellations=0
    Waits=[Collections.Generic.List[int]]::new(); Sleeps=[Collections.Generic.List[int]]::new()
    DateReads=0; Wall=[datetime]'2026-01-01T00:00:00Z'; WallJump=$WallJump
  }
  $ready = Wait-AlekovReadiness $script:fixture.Process 'http://127.0.0.1:5189/' $Budget $script:fixture.Watch
  if ($ready -isnot [bool]) { throw 'Readiness emitted values other than its one boolean result' }
  return [pscustomobject]@{ name=$Name; ready=$ready; elapsed=$script:fixture.Watch.Elapsed.TotalMilliseconds
    requests=$script:fixture.Requests; cancellations=$script:fixture.Cancellations; waits=@($script:fixture.Waits.ToArray())
    sleeps=@($script:fixture.Sleeps.ToArray()); dateReads=$script:fixture.DateReads }
}
$cases = @(
  (Run-Case 'timely' 1000 @(@{Status=200;WaitAdvance=20}))
  (Run-Case 'fractional-timely' 1000 @(@{Status=200;WaitAdvance=999.5}))
  (Run-Case 'already-complete-fractional' 1000 @(@{Status=200;DispatchAdvance=999.5;Immediate=$true}))
  (Run-Case 'late200' 1000 @(@{Status=200;WaitAdvance=1500}))
  (Run-Case 'exact200' 1000 @(@{Status=200;WaitAdvance=1000}))
  (Run-Case 'after-boundary200' 1000 @(@{Status=200;WaitAdvance=1000.5}))
  (Run-Case 'dispatch-expired' 1000 @(@{Status=200;DispatchAdvance=1000}))
  (Run-Case 'cleanup-expired' 1000 @(@{Status=200;WaitAdvance=1;CleanupAdvance=1000;CleanupThrow=$true}))
  (Run-Case 'already-exited' 1000 @() $true)
  (Run-Case 'exit-during-wait' 1000 @(@{Status=200;ExitDuringWait=$true}))
  (Run-Case 'exit-during-cleanup' 1000 @(@{Status=200;ExitDuringCleanup=$true}))
  (Run-Case 'retry-sleep-budget' 1000 @(@{Status=503;WaitAdvance=850}))
  (Run-Case 'retry-wait-budget' 3000 @(@{Status=0;WaitResult=$false},@{Status=0;WaitResult=$false}))
  (Run-Case 'late-attempt200' 5000 @(@{Status=200;WaitAdvance=2100},@{Status=200;WaitAdvance=100}))
  (Run-Case 'wait-failure' 1000 @(@{Status=0;WaitThrow=$true},@{Status=200;WaitAdvance=10}))
  (Run-Case 'dispatch-failure' 1000 @(@{Status=0;DispatchThrow=$true},@{Status=200;WaitAdvance=10}))
  (Run-Case 'wall-backward' 1000 @(@{Status=503;WaitAdvance=100},@{Status=200;WaitAdvance=100}) $false -60000)
  (Run-Case 'wall-forward' 1000 @(@{Status=503;WaitAdvance=100},@{Status=200;WaitAdvance=100}) $false 60000)
)
# Execute the actual outer acceptance/cleanup statement with fake owned objects.
# No child is started and neither a PID nor a process name is looked up.
$acceptance = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if (-not $ready -or -not (Test-AlekovReadinessActive ') }, $true))
if ($acceptance.Count -ne 1) { throw 'Actual final launcher acceptance was not found' }
function Stop-With([string]$Text, [int]$Code=1) { $script:stops++; throw 'SYNTHETIC_LAUNCHER_STOP' }
function Get-Process { throw 'Must not locate another process' }
function Stop-Process { throw 'Must not kill another process' }
function Run-Final([string]$Name, [double]$Elapsed, [bool]$Exited, [bool]$PendingExit) {
  $ready = $true; $waitMilliseconds=1000; $WaitSeconds=1
  $watch = [pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=$Elapsed}}
  $process = New-FakeProcess $Exited; $process.PendingExit=$PendingExit
  $unrelated = New-FakeProcess $false; $script:stops=0
  try { Invoke-Expression ($acceptance[0].Extent.Text) } catch { if ($_.Exception.Message -ne 'SYNTHETIC_LAUNCHER_STOP') { throw } }
  return [pscustomobject]@{name=$Name; stopped=$script:stops; ownedKills=$process.Kills; unrelatedKills=$unrelated.Kills}
}
$final = @((Run-Final 'timely' 999.5 $false $false),(Run-Final 'deadline' 1000 $false $false),(Run-Final 'exited' 20 $true $false),(Run-Final 'fresh-exit' 20 $false $true))
[pscustomobject]@{cases=$cases; final=$final} | ConvertTo-Json -Depth 8 -Compress
`);
  if (result === null) return;
  const cases = new Map(result.cases.map(item => [item.name, item]));
  assert.equal(cases.size, 18);
  for (const name of ['timely', 'fractional-timely', 'already-complete-fractional', 'late-attempt200', 'wait-failure', 'dispatch-failure', 'wall-backward', 'wall-forward']) {
    assert.equal(cases.get(name).ready, true, name);
  }
  for (const name of ['late200', 'exact200', 'after-boundary200', 'dispatch-expired', 'cleanup-expired', 'already-exited', 'exit-during-wait', 'exit-during-cleanup', 'retry-sleep-budget', 'retry-wait-budget']) {
    assert.equal(cases.get(name).ready, false, name);
  }
  assert.deepEqual(cases.get('retry-sleep-budget').sleeps, [150]);
  assert.deepEqual(cases.get('retry-wait-budget').waits, [2000, 700]);
  assert.deepEqual(cases.get('retry-wait-budget').sleeps, [300]);
  assert.equal(cases.get('late-attempt200').requests, 2);
  assert.equal(cases.get('already-exited').requests, 0);
  assert.deepEqual(cases.get('dispatch-expired').waits, []);
  assert.deepEqual(cases.get('already-complete-fractional').waits, []);
  for (const item of result.cases) {
    assert.equal(item.dateReads, 0, item.name);
    assert.equal(item.cancellations, item.requests - (item.name === 'dispatch-failure' ? 1 : 0), item.name);
  }
  assert.deepEqual(result.final, [
    { name: 'timely', stopped: 0, ownedKills: 0, unrelatedKills: 0 },
    { name: 'deadline', stopped: 1, ownedKills: 1, unrelatedKills: 0 },
    { name: 'exited', stopped: 1, ownedKills: 0, unrelatedKills: 0 },
    { name: 'fresh-exit', stopped: 1, ownedKills: 0, unrelatedKills: 0 },
  ]);
});

test('PowerShell production HTTP probe owns headers-only responses, late cleanup and nonblocking cancellation', t => {
  const result = readinessProgram(t, String.raw`
Initialize-AlekovReadinessHttp
$fixtures = @'
using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
namespace ClaireLauncherFixtures {
  public sealed class TrackedSource : CancellationTokenSource {
    public int Disposals;
    protected override void Dispose(bool disposing) {
      if (disposing) { Interlocked.CompareExchange(ref Disposals, 1, 0); }
      base.Dispose(disposing);
    }
  }
  public sealed class TrackedContent : HttpContent {
    public int Reads, Disposals;
    protected override Task SerializeToStreamAsync(Stream stream, TransportContext context) {
      Interlocked.Increment(ref Reads);
      return new TaskCompletionSource<object>().Task;
    }
    protected override bool TryComputeLength(out long length) { length = 0; return false; }
    protected override void Dispose(bool disposing) {
      if (disposing) { Interlocked.CompareExchange(ref Disposals, 1, 0); }
      base.Dispose(disposing);
    }
  }
  public sealed class Handler : HttpMessageHandler {
    private readonly TaskCompletionSource<HttpResponseMessage> pending = new TaskCompletionSource<HttpResponseMessage>();
    public readonly ManualResetEventSlim CancellationObserved = new ManualResetEventSlim(false);
    public readonly ManualResetEventSlim ReleaseCancellation = new ManualResetEventSlim(true);
    public TrackedContent RequestContent, ResponseContent;
    public bool HonorCancellation, ThrowOnSend;
    public int Sends, Disposals, CancellationGateTimedOut;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
      Interlocked.Increment(ref Sends);
      RequestContent = new TrackedContent(); request.Content = RequestContent;
      if (ThrowOnSend) { throw new InvalidOperationException("Synthetic transport failure"); }
      token.Register(delegate {
        CancellationObserved.Set();
        if (!ReleaseCancellation.Wait(5000)) { Interlocked.Increment(ref CancellationGateTimedOut); }
        if (HonorCancellation) { pending.TrySetCanceled(); }
      });
      return pending.Task;
    }
    public void Reply(int status, string[] identities) {
      ResponseContent = new TrackedContent();
      var response = new HttpResponseMessage((HttpStatusCode)status) { Content = ResponseContent };
      if (identities != null) { response.Headers.TryAddWithoutValidation("X-Claire-Process-Id", identities); }
      pending.SetResult(response);
    }
    protected override void Dispose(bool disposing) {
      if (disposing) { Interlocked.CompareExchange(ref Disposals, 1, 0); }
      base.Dispose(disposing);
    }
  }
}
'@
if ($PSVersionTable.PSVersion.Major -lt 6) {
  Add-Type -TypeDefinition $fixtures -ReferencedAssemblies 'System.Net.Http.dll' -ErrorAction Stop
} else { Add-Type -TypeDefinition $fixtures -ErrorAction Stop }
function Run-HttpCase([string]$Name) {
  $handler = [ClaireLauncherFixtures.Handler]::new()
  $source = [ClaireLauncherFixtures.TrackedSource]::new()
  $probe = $null; $pendingAfterCancel=$false; $sourceAliveAfterCancel=$false
  $handler.HonorCancellation = $Name -in @('cancelled','blocked-cancel')
  $handler.ThrowOnSend = $Name -eq 'send-failure'
  if ($Name -eq 'blocked-cancel') { $handler.ReleaseCancellation.Reset() }
  try {
    # The production C# routine receives an in-memory handler. No socket, child
    # process, policy, credential or native account operation is involved.
    $probe = [ClaireLauncher.ReadinessProbe]::Start('http://127.0.0.1:5189/', 12345, $handler, $source)
    $pendingInitially = -not $probe.Completion.IsCompleted
    $sourceCancellationInitially = $source.IsCancellationRequested
    $transportCancellationInitially = $handler.CancellationObserved.IsSet
    if ($Name -in @('late-response','cancelled','blocked-cancel')) {
      Stop-AlekovReadinessProbe $probe
      if (-not $handler.CancellationObserved.Wait(5000)) { throw 'Production cancellation was not delivered' }
      if ($Name -in @('late-response','blocked-cancel')) {
        $pendingAfterCancel = -not $probe.Completion.IsCompleted
        $sourceAliveAfterCancel = $source.Disposals -eq 0
        if (-not $pendingAfterCancel -or -not $sourceAliveAfterCancel) { throw 'Cancellation waited for blocked work or disposed an in-use source' }
      }
      if ($Name -eq 'late-response') { $handler.Reply(200, [string[]]@('12345')) }
      if ($Name -eq 'blocked-cancel') { $handler.ReleaseCancellation.Set() }
    } elseif ($Name -eq 'timely') { $handler.Reply(200, [string[]]@('12345')) }
    elseif ($Name -eq 'unready') { $handler.Reply(503, $null) }
    elseif ($Name -eq 'identity-absent') { $handler.Reply(200, $null) }
    elseif ($Name -eq 'identity-wrong') { $handler.Reply(200, [string[]]@('12346')) }
    elseif ($Name -eq 'identity-duplicate') { $handler.Reply(200, [string[]]@('12345','12345')) }
    elseif ($Name -eq 'identity-combined') { $handler.Reply(200, [string[]]@('12345, 12345')) }
    elseif ($Name -eq 'identity-leading-zero') { $handler.Reply(200, [string[]]@('012345')) }
    elseif ($Name -eq 'identity-sign') { $handler.Reply(200, [string[]]@('+12345')) }
    elseif ($Name -eq 'identity-decimal') { $handler.Reply(200, [string[]]@('12345.0')) }
    elseif ($Name -eq 'identity-junk') { $handler.Reply(200, [string[]]@('12345-child')) }
    if (-not $probe.Completion.Wait(5000)) { throw 'Production probe did not finish; a response body must never be buffered' }
    # The cancellation worker may outlive the HTTP task by one scheduling turn.
    $cleanup = [Diagnostics.Stopwatch]::StartNew()
    while ($source.Disposals -eq 0 -and $cleanup.Elapsed.TotalMilliseconds -lt 5000) { Start-Sleep -Milliseconds 1 }
    Stop-AlekovReadinessProbe $probe
    $responseReads=0; $responseDisposed=0
    if ($null -ne $handler.ResponseContent) { $responseReads=$handler.ResponseContent.Reads; $responseDisposed=$handler.ResponseContent.Disposals }
    return [pscustomobject]@{
      name=$Name; status=$probe.Completion.Result; sends=$handler.Sends
      requestReads=$handler.RequestContent.Reads; requestDisposed=$handler.RequestContent.Disposals
      responseReads=$responseReads; responseDisposed=$responseDisposed
      handlerDisposed=$handler.Disposals; sourceDisposed=$source.Disposals
      sourceCancellationRequested=$source.IsCancellationRequested
      transportCancellationObserved=$handler.CancellationObserved.IsSet; cancellationGateTimedOut=$handler.CancellationGateTimedOut
      pendingInitially=$pendingInitially; sourceCancellationInitially=$sourceCancellationInitially
      transportCancellationInitially=$transportCancellationInitially
      pendingAfterCancel=$pendingAfterCancel; sourceAliveAfterCancel=$sourceAliveAfterCancel
    }
  } finally { $handler.ReleaseCancellation.Set(); Stop-AlekovReadinessProbe $probe }
}
$results = @('timely','unready','send-failure','late-response','cancelled','blocked-cancel','identity-absent','identity-wrong','identity-duplicate','identity-combined','identity-leading-zero','identity-sign','identity-decimal','identity-junk') | ForEach-Object { Run-HttpCase $_ }
@($results) | ConvertTo-Json -Depth 5 -Compress
`);
  if (result === null) return;
  const cases = new Map(result.map(item => [item.name, item]));
  assert.equal(cases.size, 14);
  assert.equal(cases.get('timely').status, 200);
  assert.equal(cases.get('unready').status, 503);
  for (const name of ['send-failure', 'cancelled', 'blocked-cancel']) assert.equal(cases.get(name).status, 0, name);
  for (const [name, item] of cases) if (name.startsWith('identity-')) assert.equal(item.status, 0, name);
  // HttpClient versions may discard a status after cancellation; neither form
  // may expose a response, read its body or lose its resource ownership.
  assert.ok([0, 200].includes(cases.get('late-response').status));
  for (const item of result) {
    assert.equal(item.sends, 1, item.name);
    assert.equal(item.requestReads, 0, item.name);
    assert.equal(item.responseReads, 0, item.name);
    assert.equal(item.requestDisposed, 1, item.name);
    assert.equal(item.responseDisposed, ['send-failure', 'cancelled', 'blocked-cancel'].includes(item.name) ? 0 : 1, item.name);
    assert.equal(item.handlerDisposed, 1, item.name);
    assert.equal(item.sourceDisposed, 1, item.name);
    assert.equal(item.cancellationGateTimedOut, 0, item.name);
    assert.equal(item.sourceCancellationInitially, false, item.name);
    assert.equal(item.transportCancellationInitially, false, item.name);
    if (item.name !== 'send-failure') assert.equal(item.pendingInitially, true, item.name);
    const explicitlyCancelled = ['late-response', 'cancelled', 'blocked-cancel'].includes(item.name);
    assert.equal(item.sourceCancellationRequested, explicitlyCancelled, item.name);
    // Framework can cancel HttpClient's linked token during completed-client
    // disposal. That is not cancellation of the original source owned here.
    // Explicit cancellation must still reach the in-flight transport.
    assert.equal(typeof item.transportCancellationObserved, 'boolean', item.name);
    if (explicitlyCancelled) assert.equal(item.transportCancellationObserved, true, item.name);
  }
  for (const name of ['late-response', 'blocked-cancel']) {
    assert.equal(cases.get(name).pendingAfterCancel, true, name);
    assert.equal(cases.get(name).sourceAliveAfterCancel, true, name);
  }
});
