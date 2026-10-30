import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateCpuUsage, createLocalPcSampler } from '../src/local-pc-metrics.mjs';
import { appendSample, appendGap, normalizeSnapshot, normalizeEvents, MAX_SAMPLES } from '../public/dashboard-model.mjs';
const iso = n => new Date(n).toISOString();
const ticks = (user, idle) => [{ times: { user, nice:0, sys:0, idle, irq:0 } }];
function response(time=1_000_000) {
  const metric = (value, unit, source, extra={}) => ({status:'ok',value,unit,source,measuredAt:iso(time),...extra});
  return {ok:true,data:{schema:'claire.local-pc.v1',scope:'local-machine',checkedAt:iso(time),metrics:{
    cpu:metric(30,'%', 'os.cpus',{measuredFrom:iso(time-400),windowMs:400}),
    memory:metric(50,'%', 'os.totalmem/os.freemem',{usedGiB:4,totalGiB:8}),
    disk:metric(1,'GiB','fs.statfs',{scope:'project-filesystem'}),
  }}};
}
function fakeSampler(overrides={}) {
  let n=0, clock=1000000;
  return createLocalPcSampler({
    cpus:()=>ticks(n++*30,n*70), totalmem:()=>8*1024**3,freemem:()=>4*1024**3,
    wait:async()=>{clock+=400;}, clock:()=>new Date(clock), monotonic:()=>clock,
    statfsRead:async()=>({bsize:4096n,bavail:262144n}), ...overrides,
  });
}
test('negative CPU counters cannot masquerade as a valid percentage',()=>{
  assert.equal(calculateCpuUsage(ticks(-100,100), ticks(-90,190)), null);
});
test('one hung disk cannot hide successful CPU/memory observations',async()=>{
  const sampler=fakeSampler({statfsRead:()=>new Promise(()=>{}),sensorTimeoutMs:40});
  const value=await Promise.race([sampler.sample(),new Promise(r=>setTimeout(()=>r(null),200))]);
  assert.notEqual(value,null,'disk read held the entire snapshot indefinitely');
  assert.equal(value.metrics.cpu.status,'ok');
  assert.equal(value.metrics.memory.status,'ok');
  assert.equal(value.metrics.disk.reason,'DISK_READ_TIMEOUT');
});
test('pre-cancelled measurement performs zero OS reads',async()=>{
  let reads=0; const controller=new AbortController();controller.abort();
  const sampler=fakeSampler({cpus:()=>{reads++;return ticks(1,1)},statfsRead:async()=>{reads++;return {bsize:1n,bavail:1n}},totalmem:()=>{reads++;return 8}});
  await sampler.sample({signal:controller.signal}).catch(()=>{});
  assert.equal(reads,0);
});
test('disk block counts must not be coerced from booleans',async()=>{
  const output=await fakeSampler({statfsRead:async()=>({bsize:true,bavail:262144n})}).sample();
  assert.equal(output.metrics.disk.status,'unavailable');
});
test('duplicate cached timestamp must not silently evict valid history',()=>{
  const time=1_000_000;
  const history=Array.from({length:MAX_SAMPLES},(_,i)=>({time:time-(MAX_SAMPLES-1-i)*5000,cpu:30,memory:50}));
  const next=appendSample(history,normalizeSnapshot(response(time)),time);
  assert.deepEqual(next,history);
});
test('stopping at the same timestamp still creates a continuity barrier',()=>{
  const next=appendGap([{time:1000000,cpu:30,memory:50}],1000000);
  assert.equal(next.at(-1).cpu,null);
});
test('explicit invalid coverage may not be treated as absent coverage',()=>{
  for(const coverage of [null,false,0,'']) {
    const out=normalizeEvents({ok:true,data:[],coverage,meta:{mode:'connected',checkedAt:iso(1_000_000)}});
    assert.equal(out.status,'unavailable',String(coverage));
  }
});
test('future HTTP snapshot is rejected before it can drive polling success',()=>{
  const out=normalizeSnapshot(response(1_020_000),{requestedAt:999900,receivedAt:1000000});
  assert.equal(out.status,'error');
});

test('timeouts retain one disk operation until the OS settles it',async()=>{
  let calls=0, finish;
  const sampler=fakeSampler({sensorTimeoutMs:30,statfsRead:()=>{calls++;return new Promise(r=>{finish=r})}});
  const a=await sampler.sample();assert.equal(a.metrics.disk.reason,'DISK_READ_TIMEOUT');
  const b=await sampler.sample();assert.equal(b.metrics.disk.reason,'DISK_READ_IN_PROGRESS');assert.equal(calls,1);
  finish({bsize:4096n,bavail:262144n});await new Promise(r=>setImmediate(r));
  const c=await sampler.sample();assert.equal(c.metrics.disk.reason,'DISK_READ_TIMEOUT');assert.equal(calls,2);
});
test('raw memory counts and rounded percentage remain internally consistent',()=>{
  const data=response();data.data.metrics.memory.usedBytes=4*1024**3;data.data.metrics.memory.totalBytes=8*1024**3;
  assert.equal(normalizeSnapshot(data).metrics.memory.status,'ok');
  data.data.metrics.memory.usedBytes=7*1024**3;
  assert.equal(normalizeSnapshot(data).metrics.memory.status,'unavailable');
});
test('measurement export preserves times, units, failures and excludes arbitrary fields',async()=>{
  const model=await import('../public/dashboard-model.mjs');assert.equal(typeof model.exportMeasurements,'function');
  const input=response(); input.data.metrics.disk={status:'unavailable',value:null,source:'fs.statfs',unit:'GiB',measuredAt:iso(1000000),reason:'DISK_READ_FAILED'};
  const history=appendSample([],normalizeSnapshot(input),1000000);
  history[0].secret='DO_NOT_EXPORT';history[0].metrics.cpu.secret='DO_NOT_EXPORT';
  const out=model.exportMeasurements(history,iso(1000010));
  assert.equal(out.schema,'claire.measurements.v1');
  assert.equal(out.records[0].metrics.cpu.unit,'%');
  assert.equal(out.records[0].metrics.cpu.measuredAt,iso(1000000));
  assert.equal(out.records[0].metrics.disk.value,null);
  assert.equal(out.records[0].metrics.disk.reason,'DISK_READ_FAILED');
  assert.doesNotMatch(JSON.stringify(out),/DO_NOT_EXPORT/);
});
test('HTTP reader rejects oversized or non-JSON responses and redirect attempts',async()=>{
  const model=await import('../public/dashboard-model.mjs');assert.equal(typeof model.requestDashboardJson,'function');
  let options;
  await assert.rejects(model.requestDashboardJson('/api/local-pc',{maxBytes:128,fetchImpl:async(_,opts)=>{
    options=opts;return new Response('x'.repeat(129),{headers:{'content-type':'application/json'}});
  }}),/RESPONSE_TOO_LARGE/);
  assert.equal(options.redirect,'error');assert.equal(options.mode,'same-origin');
  await assert.rejects(model.requestDashboardJson('/api/local-pc',{fetchImpl:async()=>new Response('{}',{headers:{'content-type':'text/html'}})}),/RESPONSE_CONTRACT_INVALID/);
  await assert.rejects(model.requestDashboardJson('https://example.invalid',{fetchImpl:async()=>{throw Error('must not fetch')}}),/PATH_NOT_ALLOWED/);
});
test('HTTP deadline aborts a transport that ignores abort signals',async()=>{
  const model=await import('../public/dashboard-model.mjs');assert.equal(typeof model.requestDashboardJson,'function');
  await assert.rejects(model.requestDashboardJson('/api/local-pc',{timeoutMs:25,fetchImpl:()=>new Promise(()=>{})}),/LOCAL_FETCH_FAILED/);
});
