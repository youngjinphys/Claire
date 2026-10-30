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
      if (!Number.isSafeInteger(left[key]) || !Number.isSafeInteger(right[key]) || left[key] < 0 || right[key] < 0) return null;
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
  sensorTimeoutMs = 2000,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 2000) throw new TypeError('Invalid CPU interval');
  if (!Number.isInteger(sensorTimeoutMs) || sensorTimeoutMs < 25 || sensorTimeoutMs > 10000) throw new TypeError('Invalid sensor deadline');
  // A timed-out statfs syscall cannot be cancelled by Node. Keep its single-flight
  // slot until it settles so repeated manual retries never accumulate OS reads.
  let pendingDisk = null;
  const cancelled = () => Object.assign(new Error('MEASUREMENT_CANCELLED'), { code: 'MEASUREMENT_CANCELLED' });
  function checkSignal(signal) { if (signal?.aborted) throw cancelled(); }
  async function deadline(work, signal, code) {
    checkSignal(signal);
    let timer, onAbort;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), sensorTimeoutMs);
      onAbort = () => reject(cancelled());
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([work, limit]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }

  async function cpu(signal) {
    const source = 'os.cpus';
    let started;
    try {
      started = stamp(clock);
      const startedMono = monotonic();
      const before = cpus();
      await deadline(Promise.resolve().then(() => wait(intervalMs, signal)), signal, 'CPU_READ_TIMEOUT');
      checkSignal(signal);
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
    } catch (error) {
      checkSignal(signal);
      return unavailable(source, '%', stamp(clock), error?.code === 'CPU_READ_TIMEOUT' ? 'CPU_READ_TIMEOUT' : 'CPU_READ_FAILED');
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
        usedBytes: total - free, totalBytes: total,
        note: 'os.freemem 기준 사용률(운영체제별 캐시 포함 방식 차이)',
      };
    } catch {
      return unavailable(source, '%', stamp(clock), 'MEMORY_READ_FAILED');
    }
  }

  async function disk(signal) {
    const source = 'fs.statfs';
    try {
      checkSignal(signal);
      if (pendingDisk) return unavailable(source, 'GiB', stamp(clock), 'DISK_READ_IN_PROGRESS');
      const operation = Promise.resolve().then(() => { checkSignal(signal); return statfsRead(projectPath); });
      pendingDisk = operation;
      const clearPending = () => { if (pendingDisk === operation) pendingDisk = null; };
      operation.then(clearPending, clearPending);
      const info = await deadline(operation, signal, 'DISK_READ_TIMEOUT');
      checkSignal(signal);
      if (typeof info?.bsize !== 'bigint' || typeof info?.bavail !== 'bigint') {
        return unavailable(source, 'GiB', stamp(clock), 'DISK_INVALID');
      }
      const size = info.bsize, available = info.bavail;
      const measuredAt = stamp(clock);
      if (size <= 0n || available < 0n) return unavailable(source, 'GiB', measuredAt, 'DISK_INVALID');
      const bytes = available * size;
      // Convert the integer GiB part before the fractional remainder to avoid unsafe byte-to-Number precision.
      const whole = bytes / BigInt(GIB), remainder = bytes % BigInt(GIB);
      const value = Number(whole) + Number(remainder) / GIB;
      return whole <= BigInt(Number.MAX_SAFE_INTEGER) && Number.isFinite(value) && value >= 0
        ? { status: 'ok', value: round(value), unit: 'GiB', source, measuredAt, scope: 'project-filesystem', note: '앱 폴더 파일시스템의 OS 보고 여유 공간. 사용자 할당량/네트워크 드라이브 예외는 별도 확인 필요' }
        : unavailable(source, 'GiB', measuredAt, 'DISK_INVALID');
    } catch (error) {
      checkSignal(signal);
      const reason = error?.code === 'DISK_READ_TIMEOUT' ? 'DISK_READ_TIMEOUT'
        : ['EACCES', 'EPERM'].includes(error?.code) ? 'DISK_PERMISSION_DENIED'
        : ['ENOSYS', 'ENOTSUP'].includes(error?.code) ? 'DISK_UNSUPPORTED' : 'DISK_READ_FAILED';
      return unavailable(source, 'GiB', stamp(clock), reason);
    }
  }

  return Object.freeze({
    async sample({ signal } = {}) {
      checkSignal(signal);
      // Record instantaneous memory before the CPU sampling delay instead of disguising a late reading as simultaneous.
      const memoryValue = memory();
      const [cpuValue, diskValue] = await Promise.all([cpu(signal), disk(signal)]);
      checkSignal(signal);
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
