// Dependency-free Chrome DevTools Protocol smoke test, using synthetic SDP only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createOnServer } from '../src/server.mjs';
import { demoEngine } from '../src/engine.mjs';
import { collectHostObservation } from '../student/collect-host.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, title, maxMs = 15000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(140);
  }
  throw Error('Browser QA timeout: ' + title);
}

async function main() {
  const server = createOnServer({ engine: demoEngine() });
  let chrome, socket, dir;
  const errors = [];
  let nextId = 0;
  const pending = new Map();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    dir = await mkdtemp(join(tmpdir(), 'claire-cdp-'));
    chrome = spawn(process.env.CLAIRE_CHROME_BIN || 'google-chrome', [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-extensions', '--no-first-run', '--remote-debugging-port=0',
      '--user-data-dir=' + dir, 'about:blank',
    ], { stdio: 'ignore' });
    let port = 0;
    await until(async () => {
      if (chrome.exitCode !== null) throw Error('Chrome exited before startup.');
      try {
        port = Number((await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      } catch { /* Chrome still starting. */ }
      return Number.isInteger(port) && port > 0;
    }, 'Chrome ready');
    const tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
    const tab = tabs.find(item => item.type === 'page');
    assert.ok(tab?.webSocketDebuggerUrl);
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
      if (pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    async function cmd(method, params = {}) {
      const id = ++nextId;
      const data = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
        pending.set(id, result => { clearTimeout(timer); resolve(result); });
        socket.send(JSON.stringify({ id, method, params }));
      });
      if (data.error) throw Error('CDP ' + method + ': ' + data.error.message);
      return data.result;
    }
    async function evaluate(expression) {
      const data = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (data.exceptionDetails) throw Error('Browser exception: ' + data.exceptionDetails.text);
      return data.result?.value;
    }
    const observed = async (expression, label, timeout) => until(async () => Boolean(await evaluate(expression)), label, timeout);
    await cmd('Page.enable');
    await cmd('Runtime.enable');
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cmd('Page.navigate', { url: origin + '/dashboard.html' });
    await observed("document.readyState === 'complete' && document.querySelectorAll('[data-host-card]').length === 4 && document.querySelectorAll('.metric-card').length === 3", 'four host cards and three resource cards');
    assert.equal(await evaluate("document.getElementById('cpu-value').textContent"), '확인 불가');
    await observed("document.getElementById('events-origin').textContent.includes('예제 DEMO')", 'DEMO evidence');
    await evaluate("document.getElementById('sample-once').click()");
    await observed("document.getElementById('cpu-time').textContent !== '미측정' && !document.getElementById('sample-once').disabled", 'PC measurement', 20000);
    assert.equal(await evaluate("document.getElementById('disk-unit').textContent"), 'GiB');
    assert.match(await evaluate("document.querySelector('[data-host-card=sdp]').textContent"), /DEMO/);
    // Explicitly selected synthetic file tests the real student file reader,
    // without any system changes, escalation, network probing or exploit tests.
    const sample = await collectHostObservation({
      platform:'linux', clock:()=>Date.now(),
      networkInterfaces:()=>({test0:[{family:'IPv4',address:'127.0.0.1',internal:true}]}),
      dnsServers:()=>['127.0.0.1'],
      run:async()=>{throw Object.assign(new Error('absent'),{code:'ENOENT'});},
    });
    const sampleLiteral=JSON.stringify(JSON.stringify(sample));
    const loaded=await evaluate("(()=>{const input=document.querySelector('#integrated-host-root input[type=file]');"
      +"if(!input)throw Error('No existing student file reader');"
      +"const files=new DataTransfer();files.items.add(new File(["+sampleLiteral+"],'observation.json',{type:'application/json'}));"
      +"input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
    assert.equal(loaded,true);
    await observed("document.querySelector('[data-host-card=network]').textContent.includes('1개 인터페이스')"
      +" && document.querySelector('#host-report-content').textContent.includes('test0')", 'real student UI reused for file input');
    assert.match(await evaluate("document.querySelector('[data-host-card=sdp]').textContent"), /DEMO/);
    assert.match(await evaluate("document.getElementById('host-report-section').textContent"), /Windows|OS 기록/);
    await evaluate("document.getElementById('start').click()");
    await observed("!document.getElementById('stop').disabled", 'start control');
    await observed("Number.parseInt(document.getElementById('sample-count').textContent,10) >= 2", 'sample history', 20000);
    await evaluate("document.getElementById('stop').click()");
    await observed("!document.getElementById('start').disabled && document.getElementById('stop').disabled", 'stop control');
    const captures = process.env.CLAIRE_QA_CAPTURE_DIR || join(tmpdir(), 'claire-observatory-qa');
    await mkdir(captures, { recursive: true });
    const desktop = await evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,rows:new Set([...document.querySelectorAll('#integrated-host-root [data-host-card]')].map(el=>Math.round(el.getBoundingClientRect().top))).size,hostCards:document.querySelectorAll('#integrated-host-root [data-host-card]').length,heading:!!document.getElementById('host-overview-title')})");
    assert.equal(desktop.width, 1440);
    assert.equal(desktop.hostCards, 4);
    assert.equal(desktop.rows, 1);
    assert.equal(desktop.heading, true);
    assert.ok(desktop.scrollWidth <= desktop.width + 4);
    const shot = await cmd('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(captures, 'desktop-demo.png'), Buffer.from(shot.data, 'base64'));
    await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(500);
    const mobile = await evaluate("({viewport:innerWidth, width:document.documentElement.scrollWidth,cards:document.querySelectorAll('[data-host-card]').length,resources:document.querySelectorAll('.metric-card').length,rows:new Set([...document.querySelectorAll('#integrated-host-root [data-host-card]')].map(el=>Math.round(el.getBoundingClientRect().top))).size})");
    assert.equal(mobile.viewport, 390);
    assert.equal(mobile.cards, 4); assert.equal(mobile.resources, 3);
    assert.equal(mobile.rows, 2);
    assert.ok(mobile.width <= mobile.viewport + 4, 'mobile overflow: ' + JSON.stringify(mobile));
    const mobileShot = await cmd('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(captures, 'mobile-demo.png'), Buffer.from(mobileShot.data, 'base64'));
    await cmd('Emulation.clearDeviceMetricsOverride');
    await cmd('Page.navigate', { url: origin + '/' });
    await observed("!!document.querySelector('#student-status a[href=\"/dashboard.html\"]')", 'legacy UI navigation');
    assert.deepEqual(errors, [], 'no browser JS exceptions');
    console.log('PASS browser: four reused host cards, selected synthetic report, DEMO source, PC measurement, trend, stop, mobile layout, zero JS exceptions.');
    console.log('Screenshots (synthetic SDP only; OS figures are from the CI runner): ' + captures);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    if (chrome && chrome.exitCode === null) {
      const stopped = once(chrome, 'exit').catch(() => {});
      chrome.kill('SIGTERM');
      await Promise.race([stopped, sleep(2500)]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
    }
    if (dir) {
      for (let tries = 0; tries < 5; tries++) {
        try { await rm(dir, { recursive: true, force: true }); break; }
        catch (error) {
          if (tries === 4) console.warn('Chrome temporary directory cleanup: ' + error.code);
          await sleep(200);
        }
      }
    }
    if (server.listening) await new Promise(resolve => server.close(resolve));
    server.closeIdleConnections?.();
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
