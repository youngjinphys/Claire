<#
  앱 학생 앱 실행 도구 (ALEKOV-STUDENT-LAUNCH-GUIDE-01, 채널 #705 묶음 3)

  하는 일
   - 이 파일이 들어 있는 앱 폴더(on-client)의 src/server.mjs 하나만 실행합니다.
   - 실행 전에 Node.js 버전, 폴더 구성, 포트 사용 여부를 확인합니다.
   - 서버가 뜨면 브라우저로 열 주소를 알려 줍니다. AI 연결 여부는 화면에서 확인합니다.

  하지 않는 일
   - 프로그램 설치, 전역 실행 정책 변경, 드라이버·터널·인증 설정을 하지 않습니다.
   - 이미 포트를 쓰는 다른 프로그램을 종료하지 않습니다.
   - 열쇠·토큰 같은 비밀 환경변수를 서버에 넘기거나 화면·기록에 남기지 않습니다.

  사용 (앱 폴더에서)
    powershell -NoProfile -File .\tools\start-alekov.ps1
    powershell -NoProfile -File .\tools\start-alekov.ps1 -Port 5190
    powershell -NoProfile -File .\tools\start-alekov.ps1 -Background
  기존 실행 정책이 허용할 때만 이 도구를 사용합니다. 정책 때문에 실행되지 않으면
  앱 폴더에서 node src/server.mjs 를 실행합니다. 실행 정책은 변경하지 않습니다.
  옵션·종료·예제 실행 안내: docs/STUDENT_LAUNCH_GUIDE.md
#>
[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)][int]$Port = 5189,
  [switch]$Demo,
  [switch]$Background,
  [string]$NativeHostConfig,
  [string]$SdpHostConfig,
  [ValidateRange(1, 120)][int]$WaitSeconds = 20
)
Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

function Say([string]$text) { Write-Host $text }
function Stop-With([string]$text, [int]$code = 1) { Write-Host $text -ForegroundColor Yellow; exit $code }

function Test-SupportedNodeVersion([int]$Major, [int]$Minor) {
  return (($Major -eq 22 -and $Minor -ge 15) -or ($Major -eq 23 -and $Minor -ge 5) -or $Major -eq 24 -or $Major -eq 26)
}

function Get-AlternativePort([int]$CurrentPort) {
  if ($CurrentPort -lt 65535) { return $CurrentPort + 1 }
  return 5189
}

# HTTP continuation and response ownership stay in .NET, never a PowerShell
# scriptblock invoked on a thread-pool thread without its original runspace.
function Initialize-AlekovReadinessHttp {
  if ('ClaireLauncher.ReadinessProbe' -as [type]) { return }
  Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
  $definition = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
namespace ClaireLauncher {
  public sealed class ReadinessProbe {
    private readonly object gate = new object();
    private readonly CancellationTokenSource cancellation;
    private bool finished, cancellationRequested, cancellationQueued, cancellationDisposed;
    public Task<int> Completion { get; private set; }
    private ReadinessProbe(string url, int expectedProcessId, HttpMessageHandler handler, CancellationTokenSource source) {
      cancellation = source;
      Completion = ReadStatusAsync(url, expectedProcessId, handler);
    }
    public static ReadinessProbe Start(string url, int expectedProcessId) {
      var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, UseDefaultCredentials = false };
      return Start(url, expectedProcessId, handler, new CancellationTokenSource());
    }
    public static ReadinessProbe Start(string url, int expectedProcessId, HttpMessageHandler handler, CancellationTokenSource source) {
      return new ReadinessProbe(url, expectedProcessId, handler, source);
    }
    private async Task<int> ReadStatusAsync(string url, int expectedProcessId, HttpMessageHandler handler) {
      try {
        using (var client = new HttpClient(handler)) {
          client.Timeout = Timeout.InfiniteTimeSpan;
          using (var request = new HttpRequestMessage(HttpMethod.Get, url))
          using (var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation.Token).ConfigureAwait(false)) {
            if ((int)response.StatusCode == 200) {
              // Local startup attribution to the live owned child, not authentication.
              IEnumerable<string> values;
              if (expectedProcessId <= 0 || !response.Headers.TryGetValues("X-Claire-Process-Id", out values)) { return 0; }
              using (var identity = values.GetEnumerator()) {
                if (!identity.MoveNext() || identity.Current != expectedProcessId.ToString(CultureInfo.InvariantCulture) || identity.MoveNext()) { return 0; }
              }
            }
            return (int)response.StatusCode;
          }
        }
      } catch { return 0; }
      finally {
        lock (gate) { finished = true; DisposeCancellationIfFinished(); }
      }
    }
    private void DisposeCancellationIfFinished() {
      if (finished && !cancellationQueued && !cancellationDisposed) {
        cancellation.Dispose(); cancellationDisposed = true;
      }
    }
    public void Cancel() {
      lock (gate) {
        if (finished || cancellationRequested) { return; }
        cancellationRequested = true; cancellationQueued = true;
      }
      // Cancellation handlers and disposal must not extend the launcher's wait.
      ThreadPool.QueueUserWorkItem(delegate(object unused) {
        try { cancellation.Cancel(); } catch { }
        finally { lock (gate) { cancellationQueued = false; DisposeCancellationIfFinished(); } }
      });
    }
  }
}
'@
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    Add-Type -TypeDefinition $definition -ReferencedAssemblies 'System.Net.Http.dll' -ErrorAction Stop
  } else {
    Add-Type -TypeDefinition $definition -ErrorAction Stop
  }
}

function Start-AlekovReadinessProbe([string]$Url, [int]$ExpectedProcessId) {
  return [ClaireLauncher.ReadinessProbe]::Start($Url, $ExpectedProcessId)
}

function Stop-AlekovReadinessProbe([object]$Probe) {
  if ($null -ne $Probe) { try { $Probe.Cancel() } catch { } }
}

function Test-AlekovReadinessActive([object]$Process, [object]$Watch, [int]$TimeoutMilliseconds) {
  try {
    if ($Watch.Elapsed.TotalMilliseconds -ge $TimeoutMilliseconds) { return $false }
    [void]$Process.Refresh()
    if ($Process.HasExited) { return $false }
    return ($Watch.Elapsed.TotalMilliseconds -lt $TimeoutMilliseconds)
  } catch { return $false }
}

function Get-AlekovReadinessRemaining([object]$Watch, [double]$DeadlineMilliseconds) {
  return [int][Math]::Max(0, [Math]::Floor($DeadlineMilliseconds - $Watch.Elapsed.TotalMilliseconds))
}

function Wait-AlekovReadiness([object]$Process, [string]$Url, [int]$TimeoutMilliseconds, [object]$Watch) {
  while (Test-AlekovReadinessActive $Process $Watch $TimeoutMilliseconds) {
    $attemptDeadline = [Math]::Min($TimeoutMilliseconds, $Watch.Elapsed.TotalMilliseconds + 2000)
    $status = 0
    $probe = $null
    try {
      if ((Get-AlekovReadinessRemaining $Watch $attemptDeadline) -le 0) { return $false }
      $probe = Start-AlekovReadinessProbe $Url $Process.Id
      if (-not (Test-AlekovReadinessActive $Process $Watch $TimeoutMilliseconds)) { return $false }
      $remaining = Get-AlekovReadinessRemaining $Watch $attemptDeadline
      if ($probe.Completion.IsCompleted -or ($remaining -gt 0 -and $probe.Completion.Wait($remaining))) { $status = [int]$probe.Completion.Result }
    } catch { $status = 0 }
    finally { Stop-AlekovReadinessProbe $probe }
    # Recheck after all completion/cleanup work, before publishing readiness.
    if (-not (Test-AlekovReadinessActive $Process $Watch $TimeoutMilliseconds)) { return $false }
    if ($status -eq 200 -and $Watch.Elapsed.TotalMilliseconds -lt $attemptDeadline) { return $true }
    $remaining = Get-AlekovReadinessRemaining $Watch $TimeoutMilliseconds
    if ($remaining -le 0) { return $false }
    Start-Sleep -Milliseconds ([Math]::Min(300, $remaining))
  }
  return $false
}

# 1) 폴더 확인: 이 스크립트가 있는 tools 의 상위가 앱 폴더여야 합니다.
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'src\server.mjs'
$package = Join-Path $root 'package.json'
foreach ($path in @($root, $server, $package)) {
  if (-not (Test-Path -LiteralPath $path)) { Stop-With "앱 폴더가 아닙니다. 받은 시작 틀의 on-client 폴더 안에서 tools\start-alekov.ps1 을 실행해 주세요. (없는 파일: $path)" }
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-With "바로가기(링크)로 연결된 폴더나 파일에서는 실행하지 않습니다. 실제 앱 폴더(on-client)에서 실행해 주세요. ($path)" }
}
try { $meta = Get-Content -LiteralPath $package -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Stop-With 'package.json 을 읽지 못했습니다. 시작 틀을 다시 받아 주세요.' }
if ($meta.name -ne 'alekov-client-starter') { Stop-With '시작 틀 폴더가 아닙니다. 받은 시작 틀의 on-client 폴더에서 실행해 주세요.' }

# 명시한 설정 파일만 전달한다. 내용·소유 SID·보호 ACL은 native startup이 최종 확인한다.
$nativeArgument = ''
if ($PSBoundParameters.ContainsKey('NativeHostConfig')) {
  if ([string]::IsNullOrWhiteSpace($NativeHostConfig) -or $NativeHostConfig -notmatch '^[A-Za-z]:\\' -or
      $NativeHostConfig -match '["\x00-\x1f\x7f]' -or $NativeHostConfig.Substring(2).Contains(':')) {
    Stop-With 'NativeHostConfig에는 따옴표·제어문자·대체 스트림이 없는 Windows 절대 파일 경로를 지정해 주세요.'
  }
  try {
    $absoluteConfig = [IO.Path]::GetFullPath($NativeHostConfig)
    if (-not [string]::Equals($absoluteConfig, $NativeHostConfig, [StringComparison]::OrdinalIgnoreCase)) { throw 'PATH_NOT_CANONICAL' }
    $configItem = Get-Item -LiteralPath $absoluteConfig -Force
    if ($configItem -isnot [IO.FileInfo]) { throw 'CONFIG_NOT_FILE' }
    for ($currentItem = $configItem; $null -ne $currentItem; $currentItem = $(if ($currentItem -is [IO.FileInfo]) { $currentItem.Directory } else { $currentItem.Parent })) {
      if ($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CONFIG_LINK_REJECTED' }
    }
  } catch { Stop-With 'NativeHostConfig 파일이나 상위 경로를 확인하지 못했습니다. 실제 일반 파일의 정규화된 절대 경로를 지정해 주세요.' }
  $nativeArgument = ' --native-host-config "' + $absoluteConfig + '"'
}

# SDP 개인 자격은 별도 설정 파일로 선택한다. 이 도구는 파일 내용을 읽지 않는다.
$sdpArgument = ''
if ($PSBoundParameters.ContainsKey('SdpHostConfig')) {
  if ($Demo) { Stop-With 'SDP 연결과 예제 모드는 함께 실행할 수 없습니다.' }
  if ([string]::IsNullOrWhiteSpace($SdpHostConfig) -or $SdpHostConfig -notmatch '^[A-Za-z]:\\' -or
      $SdpHostConfig -match '["\x00-\x1f\x7f]' -or $SdpHostConfig.Substring(2).Contains(':')) {
    Stop-With 'SdpHostConfig에는 따옴표·제어문자·대체 스트림이 없는 Windows 절대 파일 경로를 지정해 주세요.'
  }
  try {
    $sdpConfigPath = [IO.Path]::GetFullPath($SdpHostConfig)
    if (-not [string]::Equals($sdpConfigPath, $SdpHostConfig, [StringComparison]::OrdinalIgnoreCase)) { throw 'PATH_NOT_CANONICAL' }
    $sdpConfigItem = Get-Item -LiteralPath $sdpConfigPath -Force
    if ($sdpConfigItem -isnot [IO.FileInfo]) { throw 'CONFIG_NOT_FILE' }
    for ($sdpCurrent = $sdpConfigItem; $null -ne $sdpCurrent; $sdpCurrent = $(if ($sdpCurrent -is [IO.FileInfo]) { $sdpCurrent.Directory } else { $sdpCurrent.Parent })) {
      if ($sdpCurrent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CONFIG_LINK_REJECTED' }
    }
  } catch { Stop-With 'SDP 설정 파일과 상위 경로를 확인하지 못했습니다. 실제 일반 파일의 정규화된 절대 경로를 지정해 주세요.' }
  $sdpArgument = ' --sdp-host-config "' + $sdpConfigPath + '"'
}

# 2) Node.js 확인: 설치하지 않고 안내만 합니다.
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { Stop-With 'Node.js 가 없습니다. https://nodejs.org 에서 Node.js 24.19.0(LTS)을 설치한 뒤 새 PowerShell 창에서 다시 실행해 주세요.' }
$versionText = (& $node.Source --version 2>$null | Out-String).Trim()
if ($versionText -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { Stop-With "Node.js 버전을 확인하지 못했습니다($versionText). Node.js 24.19.0 을 설치해 주세요." }
$major = [int]$Matches[1]
$minor = [int]$Matches[2]
if (-not (Test-SupportedNodeVersion $major $minor)) { Stop-With "지금 Node.js 는 $versionText 입니다. 앱은 Node.js 22.15 이상(22.x), 23.5 이상(23.x), 24.x와 26.x에서 실행합니다. Node.js 24.19.0 을 권장합니다." }
if ($versionText -ne 'v24.19.0') { Say "참고: 지금 Node.js 는 $versionText 입니다. 수업 기준은 v24.19.0 입니다." }

# 3) 포트 확인: 사용 중이면 다른 프로그램을 끄지 않고 다른 번호를 안내합니다.
$busy = $false
try {
  $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
  $probe.Start(); $probe.Stop()
} catch { $busy = $true }
if ($busy) { Stop-With "포트 $Port 를 다른 프로그램이 쓰고 있습니다. 그 프로그램은 그대로 두고, 다른 번호로 실행해 주세요. 예: -Port $(Get-AlternativePort $Port)" }

# 4) 실행: 셸(cmd·PowerShell)을 거치지 않고 node 를 직접 실행합니다. 비밀로 보이는 환경변수는 넘기지 않습니다.
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $node.Source
$info.WorkingDirectory = $root
$info.UseShellExecute = $false
# Windows 경로에는 큰따옴표가 들어갈 수 없으므로 경로를 큰따옴표로 감싸 한 인자로 넘깁니다(공백·한글 경로 포함).
$info.Arguments = '"' + $server + '"' + $(if ($Demo) { ' --demo' } else { '' }) + $nativeArgument + $sdpArgument
$secret = '(?i)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|^ON_AI_|^OPENAI|^ANTHROPIC|^SUPABASE)'
foreach ($name in @($info.EnvironmentVariables.Keys)) { if ($name -match $secret) { $info.EnvironmentVariables.Remove($name) } }
$info.EnvironmentVariables['ON_PORT'] = [string]$Port
if ($Background) {
  $info.CreateNoWindow = $true
  $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
}
try { Initialize-AlekovReadinessHttp } catch { Stop-With '앱 실행 도구의 HTTP 확인을 준비하지 못했습니다. 이 창의 메시지를 담당 강사에게 보여 주세요.' }
$process = [Diagnostics.Process]::Start($info)
$url = "http://127.0.0.1:$Port/"

# 5) 뜰 때까지 기다린 뒤 주소를 알려 줍니다. 서버가 응답한 것만 확인하며, AI 연결 성공을 뜻하지 않습니다.
$watch = [Diagnostics.Stopwatch]::StartNew()
$waitMilliseconds = $WaitSeconds * 1000
$ready = Wait-AlekovReadiness $process $url $waitMilliseconds $watch
if (-not $ready -or -not (Test-AlekovReadinessActive $process $watch $waitMilliseconds)) {
  try { [void]$process.Refresh(); if (-not $process.HasExited) { $process.Kill() } } catch { }
  Stop-With "앱 서버가 $WaitSeconds 초 안에 뜨지 않았습니다. 이 창의 메시지를 담당 강사에게 보여 주세요."
}
Say "Claire가 켜졌습니다. 브라우저에서 $url 을 여세요."
Say '서버가 응답한 것만 확인했습니다. AI 연결 상태는 화면에서 따로 확인해 주세요.'
if ($Background) {
  Say "뒤에서 실행 중입니다(프로세스 번호 $($process.Id)). 끄려면 이 번호의 node 를 작업 관리자에서 종료하세요."
  exit 0
}
Say '끄려면 이 창에서 Ctrl+C 를 누르세요.'
$process.WaitForExit()
exit $process.ExitCode
