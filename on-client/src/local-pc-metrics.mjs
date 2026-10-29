import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const DEFAULT_PROJECT = fileURLToPath(new URL('../', import.meta.url));
const GIB = 1024 ** 3;
const SCHEMA = 'claire.local-pc.v1';
const round = (value, places = 2) => Number(value.toFixed(places));
const stamp = clock => new Date(clock()).toISOString();

function unavailable(source, unit, measuredAt, reason) {
  return { status: 'unavailable', value: null, unit, source, measuredAt, reason };
}

export function calculateCpuUsage(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length === 0 || before.length !== after.length) return null;
  let busy = 0, total = 0;
  for (let i = 0; i < before.length; i += 1) {
    const left = before[i]?.times, right = after[i]?.times;
    if (!left || !right) return null;
    let sum = 0;
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
      if (!Number.isFinite(left[key]) || !Number.isFinite(right[key])) return null;
      const diff = right[key] - left[key];
      if (diff < 0) return null;
      sum += diff;
      if (key === 'idle') busy -= diff;
    }
    total += sum;
    busy += sum;
  }
  if (!(total > 0)) return null;
  const usage = busy / total * 100;
  return Number.isFinite(usage) && usage >= 0 && usage <= 100 ? round(usage) : null;
}

export function createLocalPcSampler({
  cpus = () => os.cpus(),
  totalmem = () => os.totalmem(),
  freemem = () => os.freemem(),
  statfsRead = path => statfs(path, { bigint: true }),
  projectPath = DEFAULT_PROJECT,
  clock = () => new Date(),
  monotonic = () => performance.now(),
  wait = (ms, signal) => sleep(ms, undefined, { signal }),
  intervalMs = 400,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 2000) throw new TypeError('Invalid CPU interval');

  async function cpu(signal) {
    const source = 'os.cpus';
    let started;
    try {
      started = stamp(clock);
      const startedMono = monotonic();
      const before = cpus();
      await wait(intervalMs, signal);
      const after = cpus();
      const elapsed = monotonic() - startedMono;
      const measuredAt = stamp(clock);
      const value = calculateCpuUsage(before, after);
      if (!Number.isFinite(elapsed) || elapsed < 100 || elapsed > 5000
        || Date.parse(measuredAt) < Date.parse(started)) {
        return unavailable(source, '%', measuredAt, 'CPU_INTERVAL_INVALID');
      }
      return value === null
        ? unavailable(source, '%', measuredAt, 'CPU_SAMPLE_UNAVAILABLE')
        : { status: 'ok', value, unit: '%', source, measuredAt, measuredFrom: started, windowMs: Math.round(elapsed) };
    } catch {
      return unavailable(source, '%', stamp(clock), 'CPU_READ_FAILED');
    }
  }

  function memory() {
    const source = 'os.totalmem/os.freemem';
    try {
      const total = totalmem(), free = freemem(), measuredAt = stamp(clock);
      if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0 || free < 0 || free > total) {
        return unavailable(source, '%', measuredAt, 'MEMORY_INVALID');
      }
      return {
        status: 'ok', value: round((total - free) / total * 100), unit: '%', source, measuredAt,
        usedGiB: round((total - free) / GIB), totalGiB: round(total / GIB),
        note: 'os.freemem 기준 사용률(운영체제별 캐시 포함 방식 차이)',
      };
    } catch {
      return unavailable(source, '%', stamp(clock), 'MEMORY_READ_FAILED');
    }
  }

  async function disk() {
    const source = 'fs.statfs';
    try {
      const info = await statfsRead(projectPath);
      const size = BigInt(info.bsize), available = BigInt(info.bavail);
      const measuredAt = stamp(clock);
      if (size <= 0n || available < 0n) return unavailable(source, 'GiB', measuredAt, 'DISK_INVALID');
      const bytes = available * size;
      // Convert the integer GiB part before the fractional remainder to avoid unsafe byte-to-Number precision.
      const whole = bytes / BigInt(GIB), remainder = bytes % BigInt(GIB);
      const value = Number(whole) + Number(remainder) / GIB;
      return whole <= BigInt(Number.MAX_SAFE_INTEGER) && Number.isFinite(value) && value >= 0
        ? { status: 'ok', value: round(value), unit: 'GiB', source, measuredAt, scope: 'project-filesystem', note: 'on-client가 위치한 파일시스템의 일반 사용자 사용 가능 공간' }
        : unavailable(source, 'GiB', measuredAt, 'DISK_INVALID');
    } catch {
      return unavailable(source, 'GiB', stamp(clock), 'DISK_READ_FAILED');
    }
  }

  return Object.freeze({
    async sample({ signal } = {}) {
      // Record instantaneous memory before the CPU sampling delay instead of disguising a late reading as simultaneous.
      const memoryValue = memory();
      const [cpuValue, diskValue] = await Promise.all([cpu(signal), disk()]);
      return {
        schema: SCHEMA,
        scope: 'local-machine',
        checkedAt: stamp(clock),
        metrics: { cpu: cpuValue, memory: memoryValue, disk: diskValue },
      };
    },
  });
}

const defaultSampler = createLocalPcSampler();
export function sampleLocalPc(options) {
  return defaultSampler.sample(options);
}
