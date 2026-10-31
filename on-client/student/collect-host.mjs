/** Claire user-mode, read-only host report. No elevation, service changes, or remote calls. */
import os from 'node:os';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPORT_SCHEMA = 'claire.host-observation.v1';
export const EVENT_LIMIT = 2000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REPORT_BYTES = 128 * 1024;
const WINDOWS_PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const COMMAND_TIMEOUT_MS = 8000;
const SAFE_OUTPUT_BYTES = 64 * 1024;
const iso = time => new Date(time).toISOString();
const failure = (reason, measuredAt, source) => ({ status: 'unavailable', reason, measuredAt, source });
const errorReason = error => {
  const text = String(error?.output ?? error?.message ?? '');
  if (['EPERM', 'EACCES'].includes(error?.code) || /permission denied|you need to be root|operation not permitted/iu.test(text)) return 'PERMISSION_DENIED';
  if (error?.code === 'ENOENT') return 'COMMAND_NOT_FOUND';
  if (error?.killed || error?.code === 'ETIMEDOUT') return 'QUERY_TIMEOUT';
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'RESULT_TOO_LARGE';
  return 'READ_FAILED';
};
const bounded = (value, limit = 80) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);

function runReadOnlyCommand(file, args, { timeout = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((fulfill, reject) => {
    execFile(file, args, { timeout, maxBuffer: SAFE_OUTPUT_BYTES, windowsHide: true, shell: false }, (error, stdout, stderr) => {
      if (error) { error.output = (stdout || '') + (stderr ? '\n' + stderr : ''); reject(error); }
      else fulfill(stdout);
    });
  });
}

/** No MAC, hostname, user name, external probes or network access. */
export function readNetwork({ networkInterfaces = () => os.networkInterfaces(), dnsServers = () => dns.getServers(), clock = Date.now } = {}) {
  const measuredAt = iso(clock()), source = 'node:os.networkInterfaces+node:dns.getServers';
  try {
    const raw = networkInterfaces();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('INVALID_INTERFACES');
    const entries = Object.entries(raw);
    const interfaces = [];
    let truncated = entries.length > 32;
    for (const [name, addresses] of entries.slice(0, 32)) {
      if (!bounded(name, 90) || !Array.isArray(addresses)) throw Error('INVALID_INTERFACES');
      if (addresses.length > 8) truncated = true;
      const list = [];
      for (const entry of addresses.slice(0, 8)) {
        const family = entry?.family === 4 || entry?.family === 'IPv4' ? 'IPv4'
          : entry?.family === 6 || entry?.family === 'IPv6' ? 'IPv6' : null;
        const address = entry?.address;
        if (!family || !bounded(address, 90) || isIP(address) !== (family === 'IPv4' ? 4 : 6)) { truncated = true; continue; }
        list.push({ family, address, internal: entry.internal === true });
      }
      interfaces.push({ name, addresses: list });
    }
    const servers = dnsServers();
    if (!Array.isArray(servers)) throw Error('INVALID_DNS');
    if (servers.length > 12) truncated = true;
    const dnsValues = servers.slice(0, 12).filter(s => bounded(s, 90));
    if (dnsValues.length !== Math.min(servers.length, 12)) throw Error('INVALID_DNS');
    return { status: truncated ? 'partial' : 'ok', reason: truncated ? 'RESULT_LIMIT' : null,
      measuredAt, source, interfaces, dns: dnsValues,
      gateway: { status: 'unavailable', reason: 'GATEWAY_NOT_COLLECTED' },
      note: '해당 Node 실행 환경의 인터페이스와 DNS 설정. MAC·호스트 이름은 수집하지 않음' };
  } catch {
    return { ...failure('NETWORK_READ_FAILED', measuredAt, source), interfaces: [], dns: [],
      gateway: { status: 'unavailable', reason: 'GATEWAY_NOT_COLLECTED' } };
  }
}

export const WINDOWS_FIREWALL_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
$p = @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop | ForEach-Object {
  @{ Name = [string]$_.Name; Enabled = [bool]$_.Enabled;
     DefaultInboundAction = [string]$_.DefaultInboundAction;
     DefaultOutboundAction = [string]$_.DefaultOutboundAction }
})
@{ profiles = $p } | ConvertTo-Json -Depth 4 -Compress
`;

function validateProfiles(raw) {
  if (!Array.isArray(raw?.profiles) || raw.profiles.length < 1 || raw.profiles.length > 3) return null;
  const acceptedNames = new Set(['Domain', 'Private', 'Public']);
  const names = new Set();
  const profiles = [];
  for (const p of raw.profiles) {
    if (!acceptedNames.has(p?.Name) || names.has(p.Name) || typeof p.Enabled !== 'boolean'
        || !['Allow', 'Block', 'NotConfigured'].includes(p.DefaultInboundAction)
        || !['Allow', 'Block', 'NotConfigured'].includes(p.DefaultOutboundAction)) return null;
    names.add(p.Name);
    profiles.push({ name: p.Name, enabled: p.Enabled, inbound: p.DefaultInboundAction, outbound: p.DefaultOutboundAction });
  }
  return profiles;
}

export async function readFirewall({ platform = process.platform, run = runReadOnlyCommand, clock = Date.now } = {}) {
  const measuredAt = iso(clock());
  if (platform === 'win32') {
    const source = 'windows:Get-NetFirewallProfile(ActiveStore)';
    try {
      const output = await run(WINDOWS_PS, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_FIREWALL_QUERY]);
      const profiles = validateProfiles(JSON.parse(output));
      return profiles ? { status: 'ok', measuredAt, source, profiles, note: 'ActiveStore 정책 저장소의 Domain/Private/Public 구성. 현재 사용 중인 프로필과 타 제품 방화벽의 전체 적용 상태를 증명하지 않음' }
        : failure('FIREWALL_RESPONSE_INVALID', measuredAt, source);
    } catch (error) { return failure(errorReason(error), measuredAt, source); }
  }
  if (platform === 'darwin') {
    const source = 'macos:socketfilterfw(--getglobalstate)';
    try {
      const output = await run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']);
      const match = /\bState\s*=\s*([01])\b/iu.exec(output);
      return match ? { status: 'ok', measuredAt, source, state: match[1] === '1' ? 'enabled' : 'disabled',
        note: 'macOS Application Firewall 상태만 해당. pf 등의 다른 필터는 별도' }
        : failure('FIREWALL_RESPONSE_INVALID', measuredAt, source);
    } catch (error) { return failure(errorReason(error), measuredAt, source); }
  }
  if (platform === 'linux') {
    const candidates = [
      { source: 'linux:firewall-cmd(--state)', file: '/usr/bin/firewall-cmd', args: ['--state'] },
      { source: 'linux:ufw(status)', file: '/usr/sbin/ufw', args: ['status'] },
    ];
    const observed = [], failures = [];
    for (const candidate of candidates) {
      let output;
      try { output = await run(candidate.file, candidate.args); }
      catch (error) {
        // firewalld uses a nonzero code for stopped service; still just a limited daemon observation.
        if (candidate.source.includes('firewall-cmd') && /^not running\s*$/iu.test(String(error.output ?? '').trim())) output = String(error.output);
        else { failures.push({ source: candidate.source, reason: errorReason(error) }); continue; }
      }
      const trimmed = String(output).trim();
      const state = candidate.source.includes('firewall-cmd')
        ? trimmed === 'running' ? 'running' : trimmed === 'not running' ? 'not-running' : null
        : /^Status:\s*active(?:\s|$)/imu.test(trimmed) ? 'enabled'
          : /^Status:\s*inactive(?:\s|$)/imu.test(trimmed) ? 'disabled' : null;
      if (state === null) failures.push({ source: candidate.source, reason: 'FIREWALL_RESPONSE_INVALID' });
      else observed.push({ backend: candidate.source, state });
    }
    if (!observed.length) {
      const reason = failures.some(x => x.reason === 'PERMISSION_DENIED') ? 'PERMISSION_DENIED'
        : failures.every(x => x.reason === 'COMMAND_NOT_FOUND') ? 'FIREWALL_BACKEND_NOT_FOUND' : 'FIREWALL_READ_FAILED';
      return failure(reason, measuredAt, 'linux:firewalld+ufw');
    }
    return { status: failures.length ? 'partial' : 'ok', measuredAt, source: 'linux:firewalld+ufw',
      backends: observed, reason: failures.length ? 'OTHER_BACKEND_UNVERIFIED' : null,
      note: '조회 가능한 관리 도구만 관측. nftables/iptables 및 모든 방화벽의 통합 상태를 보증하지 않음' };
  }
  return { status: 'not_applicable', measuredAt, source: 'host:unsupported', reason: 'PLATFORM_UNSUPPORTED' };
}

/** 2 = error, 3 = warning. A capped scan never claims an exact count. */
export function windowsEventQuery(fromMs, toMs) {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs <= fromMs || toMs - fromMs !== WINDOW_MS) throw TypeError('INVALID_WINDOW');
  return String.raw`
$ErrorActionPreference = 'Stop'
$start = [DateTimeOffset]::FromUnixTimeMilliseconds(${fromMs}).LocalDateTime
$end = [DateTimeOffset]::FromUnixTimeMilliseconds(${toMs}).LocalDateTime
function Read-Counts([string]$logName) {
  try {
    $items = @(Get-WinEvent -FilterHashtable @{LogName=$logName;StartTime=$start;EndTime=$end;Level=@(2,3)} -MaxEvents ${EVENT_LIMIT + 1} -ErrorAction Stop)
    if ($items.Count -gt ${EVENT_LIMIT}) { return @{status='partial';reason='EVENT_LIMIT_EXCEEDED';warning=$null;error=$null} }
    $warnings = @($items | Where-Object { $_.Level -eq 3 }).Count
    $errors = @($items | Where-Object { $_.Level -eq 2 }).Count
    return @{status='ok';reason=$null;warning=[int]$warnings;error=[int]$errors}
  } catch {
    $fault = [string]$_.FullyQualifiedErrorId
    if ($fault -like 'NoMatchingEventsFound*') { return @{status='ok';reason=$null;warning=0;error=0} }
    if ($fault -match 'AccessDenied|Unauthorized|Permission') { return @{status='unavailable';reason='PERMISSION_DENIED';warning=$null;error=$null} }
    return @{status='unavailable';reason='EVENT_READ_FAILED';warning=$null;error=$null}
  }
}
@{ System = (Read-Counts 'System'); Application = (Read-Counts 'Application') } | ConvertTo-Json -Depth 4 -Compress
`;
}

function parseEventLog(data) {
  const status = data?.status;
  if (status === 'ok' && Number.isSafeInteger(data.warning) && data.warning >= 0 && data.warning <= EVENT_LIMIT
    && Number.isSafeInteger(data.error) && data.error >= 0 && data.error <= EVENT_LIMIT
    && data.warning + data.error <= EVENT_LIMIT) {
    return { status: 'ok', warning: data.warning, error: data.error };
  }
  if (status === 'partial' && data.reason === 'EVENT_LIMIT_EXCEEDED' && data.warning === null && data.error === null)
    return { status: 'partial', reason: 'EVENT_LIMIT_EXCEEDED', warning: null, error: null };
  if (status === 'unavailable' && ['PERMISSION_DENIED', 'EVENT_READ_FAILED'].includes(data.reason)
    && data.warning === null && data.error === null)
    return { status: 'unavailable', reason: data.reason, warning: null, error: null };
  return { status: 'unavailable', reason: 'EVENT_RESPONSE_INVALID', warning: null, error: null };
}

export async function readWindowsEvents({ platform = process.platform, run = runReadOnlyCommand, clock = Date.now } = {}) {
  const endMs = clock(), measuredAt = iso(endMs), windowStart = iso(endMs - WINDOW_MS), windowEnd = measuredAt;
  const source = platform === 'win32' ? 'windows:Get-WinEvent(System+Application)' : 'windows:NotApplicable';
  if (platform !== 'win32') return { status: 'not_applicable', reason: 'WINDOWS_ONLY', measuredAt, source,
    windowStart, windowEnd, system: null, application: null, detection: false };
  try {
    const output = await run(WINDOWS_PS, ['-NoProfile', '-NonInteractive', '-Command', windowsEventQuery(endMs - WINDOW_MS, endMs)]);
    const payload = JSON.parse(output);
    const system = parseEventLog(payload?.System), application = parseEventLog(payload?.Application);
    const status = system.status === 'ok' && application.status === 'ok' ? 'ok'
      : system.status === 'unavailable' && application.status === 'unavailable' ? 'unavailable' : 'partial';
    return { status, measuredAt, source, windowStart, windowEnd,
      windowHours: 24, limitPerLog: EVENT_LIMIT, system, application, detection: false,
      note: '운영체제 System/Application 경고(Level 3)·오류(Level 2)의 집계. 공격/침해 탐지 결과 아님' };
  } catch (error) {
    const reason = errorReason(error);
    return { status: 'unavailable', reason, measuredAt, source, windowStart, windowEnd,
      windowHours: 24, limitPerLog: EVENT_LIMIT, system: { status: 'unavailable', reason, warning: null, error: null },
      application: { status: 'unavailable', reason, warning: null, error: null }, detection: false };
  }
}

export async function collectHostObservation(options = {}) {
  const platform = options.platform ?? process.platform, clock = options.clock ?? Date.now;
  const [firewall, windowsEvents] = await Promise.all([
    readFirewall({ ...options, platform, clock }), readWindowsEvents({ ...options, platform, clock }),
  ]);
  return { schema: REPORT_SCHEMA, producedAt: iso(clock()), platform, scope: 'local-node-runtime',
    evidence: 'user-generated-local-file-not-authenticated', readOnly: true,
    network: readNetwork({ networkInterfaces: options.networkInterfaces, dnsServers: options.dnsServers, clock }),
    firewall, windowsEvents };
}

export async function saveHostObservation(report, { folder = tmpdir() } = {}) {
  const bytes = JSON.stringify(report, null, 2) + '\n';
  if (Buffer.byteLength(bytes, 'utf8') > MAX_REPORT_BYTES) throw Error('REPORT_LIMIT_EXCEEDED');
  // Never write snapshots into the repository or system configuration directories.
  const dir = await mkdtemp(join(folder, 'claire-host-'));
  const path = join(dir, 'observation.json');
  await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error('추가 옵션은 허용하지 않습니다. node student/collect-host.mjs 로 실행하세요.');
    process.exitCode = 2;
  } else {
    try {
      const result = await collectHostObservation();
      const path = await saveHostObservation(result);
      console.log('읽기 전용 보고서: ' + path);
      console.log('생성 시각: ' + result.producedAt + ' / 수집 환경: ' + result.platform);
      console.log('Claire 학생 상태 화면의 다시 조회 버튼에서 위 observation.json 파일을 선택하세요.');
      console.log('네트워크 주소가 포함될 수 있으므로 보고서를 공개 저장소에 올리지 마세요.');
    } catch {
      console.error('확인 불가: 보고서를 생성하지 못했습니다. 임시 폴더 권한·여유 공간을 확인하세요.');
      process.exitCode = 1;
    }
  }
}
