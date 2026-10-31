import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  REPORT_SCHEMA, EVENT_LIMIT, WINDOWS_FIREWALL_QUERY, windowsEventQuery,
  readNetwork, readFirewall, readWindowsEvents, collectHostObservation, saveHostObservation,
} from '../student/collect-host.mjs';

const T = Date.parse('2026-10-31T00:00:00.000Z');
const iface = () => ({ loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true, mac: 'do-not-export' }],
  eth0: [{ family: 'IPv6', address: 'fe80::1%eth0', internal: false, mac: 'secret' }] });
const dns = () => ['1.1.1.1'];

test('network reads only the Node runtime interfaces and DNS, never MAC or hostname', () => {
  const value = readNetwork({ networkInterfaces: iface, dnsServers: dns, clock: () => T });
  assert.equal(value.status, 'ok');
  assert.equal(value.interfaces.length, 2);
  assert.deepEqual(value.dns, ['1.1.1.1']);
  assert.equal(value.gateway.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(value), /do-not-export|secret|hostname|mac"/);
  assert.equal(value.measuredAt, '2026-10-31T00:00:00.000Z');
});
test('permission failures and network read errors fail closed, not 0 or firewall disabled', async () => {
  const err = Object.assign(new Error('Access denied: sensitive path'), { code: 'EACCES' });
  const denied = async () => { throw err; };
  const firewall = await readFirewall({ platform: 'win32', run: denied, clock: () => T });
  const logs = await readWindowsEvents({ platform: 'win32', run: denied, clock: () => T });
  assert.equal(firewall.status, 'unavailable'); assert.equal(firewall.reason, 'PERMISSION_DENIED');
  assert.equal(logs.status, 'unavailable');
  assert.equal(logs.system.warning, null);
  assert.equal(logs.application.error, null);
  assert.doesNotMatch(JSON.stringify({ firewall, logs }), /sensitive path/);
  const network = readNetwork({ networkInterfaces: () => { throw Error('private path'); }, clock: () => T });
  assert.equal(network.status, 'unavailable');
  assert.equal(network.interfaces.length, 0);
});
test('Windows fixed PowerShell scripts contain only read-only APIs and bounded 24h event filters', async () => {
  const commands = [];
  const run = async (file, args) => {
    commands.push({ file, args });
    assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(args.slice(0, 3), ['-NoProfile','-NonInteractive','-Command']);
    assert.doesNotMatch(args[3], /\b(?:Set|New|Remove|Disable|Enable|Clear|Restart)-/iu);
    if (args[3].includes('Get-NetFirewallProfile')) return JSON.stringify({ profiles: [
      { Name: 'Domain', Enabled: true, DefaultInboundAction: 'Block', DefaultOutboundAction: 'Allow' },
      { Name: 'Private', Enabled: false, DefaultInboundAction: 'NotConfigured', DefaultOutboundAction: 'Allow' },
    ] });
    assert.match(args[3], /Get-WinEvent\s+-FilterHashtable/);
    assert.match(args[3], /-MaxEvents 2001/);
    assert.match(args[3], /Level=@\(2,3\)/);
    return JSON.stringify({ System: { status: 'ok', warning: 4, error: 2 }, Application: { status: 'ok', warning: 0, error: 5 } });
  };
  const report = await collectHostObservation({ platform: 'win32', run, clock: () => T, networkInterfaces: iface, dnsServers: dns });
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.readOnly, true);
  assert.equal(report.firewall.status, 'ok');
  assert.equal(report.firewall.profiles[0].inbound, 'Block');
  assert.match(report.firewall.note, /ActiveStore.*현재 사용 중인 프로필/);
  assert.equal(report.windowsEvents.status, 'ok');
  assert.deepEqual(report.windowsEvents.system, { status: 'ok', warning: 4, error: 2 });
  assert.equal(report.windowsEvents.application.error, 5);
  assert.equal(report.windowsEvents.detection, false);
  assert.equal(Date.parse(report.windowsEvents.windowEnd) - Date.parse(report.windowsEvents.windowStart), 86_400_000);
  assert.equal(commands.length, 2);
});
test('Windows log cap does not misrepresent >=2001 results as an exact count', async () => {
  assert.match(windowsEventQuery(T - 86_400_000, T), /EVENT_LIMIT_EXCEEDED/);
  const data = await readWindowsEvents({ platform: 'win32', clock: () => T, run: async () => JSON.stringify({
    System: { status: 'partial', warning: null, error: null, reason: 'EVENT_LIMIT_EXCEEDED' },
    Application: { status: 'ok', warning: 0, error: 0 },
  }) });
  assert.equal(data.status, 'partial');
  assert.equal(data.system.warning, null);
  assert.equal(data.application.warning, 0);
  assert.equal(EVENT_LIMIT, 2000);
});
test('Windows malformed or uncertain event counts never become verified numbers', async () => {
  const log = await readWindowsEvents({ platform: 'win32', clock: () => T, run: async () => JSON.stringify({
    System: { status: 'ok', warning: -1, error: 0 },
    Application: { status: 'ok', warning: 0, error: 0 },
  }) });
  assert.equal(log.system.status, 'unavailable');
  assert.equal(log.system.warning, null);
  assert.equal(log.application.warning, 0);
  assert.equal(log.status, 'partial');
});
test('macOS Application Firewall is observed without sudo and Windows logs are inapplicable', async () => {
  const calls = [];
  const report = await collectHostObservation({ platform: 'darwin', clock: () => T, networkInterfaces: iface, dnsServers: dns,
    run: async (path, args) => { calls.push({ path, args }); return 'Firewall is enabled. (State = 1)'; } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { path: '/usr/libexec/ApplicationFirewall/socketfilterfw', args: ['--getglobalstate'] });
  assert.equal(report.firewall.state, 'enabled');
  assert.equal(report.windowsEvents.status, 'not_applicable');
  assert.equal(report.windowsEvents.system, null);
});
test('Linux read-only backend queries are independent; missing UFW cannot certify firewalld as all firewalls', async () => {
  const report = await collectHostObservation({ platform: 'linux', clock: () => T, networkInterfaces: iface, dnsServers: dns,
    run: async (path, args) => {
      if (path === '/usr/bin/firewall-cmd') { assert.deepEqual(args, ['--state']); return 'running\n'; }
      assert.equal(path, '/usr/sbin/ufw'); assert.deepEqual(args, ['status']);
      throw Object.assign(Error('missing'), { code: 'ENOENT' });
    } });
  assert.equal(report.firewall.status, 'partial');
  assert.equal(report.firewall.backends[0].state, 'running');
  assert.equal(report.firewall.reason, 'OTHER_BACKEND_UNVERIFIED');
  assert.equal(report.windowsEvents.status, 'not_applicable');
});
test('a stopped firewalld is not mislabeled as system-wide firewall disabled', async () => {
  const state = await readFirewall({ platform: 'linux', clock: () => T,
    run: async file => { if (file.includes('firewall-cmd')) throw Object.assign(Error('stopped'), { code: 252, output: 'not running\n' }); return 'Status: active\n'; } });
  assert.equal(state.status, 'ok');
  assert.deepEqual(state.backends.map(b => b.state), ['not-running', 'enabled']);
});
test('local report is saved only to a new private temporary folder, without overwriting existing files', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'claire-test-parent-'));
  try {
    const report = await collectHostObservation({ platform: 'linux', clock: () => T,
      networkInterfaces: iface, dnsServers: dns, run: async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); } });
    const path = await saveHostObservation(report, { folder: dest });
    assert.ok(path.startsWith(dest));
    assert.equal(basename(path), 'observation.json');
    const loaded = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(loaded.schema, REPORT_SCHEMA);
    assert.equal(loaded.windowsEvents.detection, false);
    const info = await stat(path);
    if (process.platform !== 'win32') assert.equal(info.mode & 0o077, 0);
    assert.equal(await readFile(path, 'utf8').then(text => text.includes('do-not-export')), false);
  } finally { await rm(dest, { recursive: true, force: true }); }
});
test('the actual runner can collect its own user-mode report without changing OS settings', { timeout: 30000 }, async () => {
  const sampled = await collectHostObservation();
  assert.equal(sampled.schema, REPORT_SCHEMA);
  assert.equal(sampled.readOnly, true);
  assert.equal(sampled.scope, 'local-node-runtime');
  assert.ok(Number.isFinite(Date.parse(sampled.producedAt)));
  for (const name of ['network','firewall','windowsEvents']) {
    assert.ok(['ok','partial','unavailable','not_applicable'].includes(sampled[name].status));
    assert.ok(Number.isFinite(Date.parse(sampled[name].measuredAt)));
  }
  assert.equal(sampled.windowsEvents.detection,false);
  if (process.platform !== 'win32') assert.equal(sampled.windowsEvents.status,'not_applicable');
  if (sampled.windowsEvents.status === 'unavailable') {
    assert.notEqual(sampled.windowsEvents.system?.warning,0);
    assert.notEqual(sampled.windowsEvents.application?.error,0);
  }
});
