// Real Chromium SVG hit-testing against a loopback-only, synthetic API fixture.
// This does not contact the deployed app, Supabase, the judge, or student data.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {once} from 'node:events';

const root=resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label,timeout=15000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await predicate())return;await sleep(50);}
  throw Error('Chart browser QA timeout: '+label);
}
const fixture=(records,summary)=>({
  schema:'aleph.operations.snapshot.v1',target:null,deployCommit:null,
  policy:{rules:[]},detection:{condition:'fixture'},revocation:{},recovery:{},
  verdict:{attackTypesRequired:41,stagesRequired:12,attackTypesVerified:0,stagesVerified:0},
  records,summary,
});
const initial=fixture([],{verified:0,failed:0,inconclusive:0,unrun:0,httpCount:0});
const refreshed=fixture([
  {id:'static_redaction',outcome:'verified',httpStatus:200,method:'GET',path:'/data.json'},
  {id:'anonymous_notes',outcome:'failed',httpStatus:403,method:'GET',path:'/api/notes'},
  {id:'anonymous_restore',outcome:'inconclusive',httpStatus:503,method:'GET',path:'/api/restore/notes/fixture'},
],{verified:1,failed:1,inconclusive:1,unrun:0,httpCount:3});
const assets=new Map([
  ['/','public/index.html'],['/operations.mjs','public/operations.mjs'],
  ['/operations.css','public/operations.css'],['/observatory-theme.css','public/observatory-theme.css'],
  ['/device.mjs','public/device.mjs'],['/icon-192.png','public/icon-192.png'],
  ['/manifest.webmanifest','public/manifest.webmanifest'],
  ['/vendor/simplewebauthn.umd.min.js','node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'],
]);
const mime=path=>path.endsWith('.mjs')||path.endsWith('.js')?'text/javascript':
  path.endsWith('.css')?'text/css':path.endsWith('.png')?'image/png':
  path.endsWith('.webmanifest')?'application/manifest+json':'text/html';

async function main(){
  let current=initial;
  const unexpected=[];
  const server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    res.setHeader('Cache-Control','no-store');
    if(path==='/api/ops'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(current));return;
    }
    if(path==='/api/auth/session'&&req.method==='POST'){
      res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"UNAUTHORIZED"}');return;
    }
    if(path==='/sw.js'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/javascript'});res.end('// inert test service worker');return;
    }
    const asset=assets.get(path);
    if(req.method!=='GET'||!asset){unexpected.push(path);res.writeHead(404);res.end();return;}
    try{const data=await readFile(resolve(root,asset));res.writeHead(200,{'Content-Type':mime(asset)});res.end(data);}
    catch{unexpected.push('fixture_asset_missing');res.writeHead(404);res.end();}
  });
  let chrome,socket,dir;const pending=new Map(),errors=[];let nextId=0,blocked=0;
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    const origin='http://127.0.0.1:'+server.address().port;
    dir=await mkdtemp(join(tmpdir(),'claire-chart-qa-'));
    chrome=spawn(process.env.CLAIRE_CHROME_BIN||'google-chrome',[
      '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-extensions',
      '--disable-background-networking','--disable-component-update','--disable-sync','--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--no-first-run','--remote-debugging-port=0','--user-data-dir='+dir,'about:blank',
    ],{stdio:'ignore'});
    let port;
    await until(async()=>{if(chrome.exitCode!==null)throw Error('Chrome exited before startup');
      try{port=Number((await readFile(join(dir,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{}
      return Number.isInteger(port)&&port>0;},'Chrome ready');
    const tabs=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
    const tab=tabs.find(item=>item.type==='page');assert.ok(tab?.webSocketDebuggerUrl);
    socket=new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
    async function cmd(method,params={}){
      const id=++nextId;
      const data=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);
        pending.set(id,result=>{clearTimeout(timer);resolve(result)});
        socket.send(JSON.stringify({id,method,params}));
      });
      if(data.error)throw Error('CDP '+method+': '+data.error.message);
      return data.result;
    }
    socket.onmessage=event=>{
      const msg=JSON.parse(event.data);
      if(msg.method==='Runtime.exceptionThrown')errors.push('page exception');
      if(msg.method==='Fetch.requestPaused'){
        const {requestId,request}=msg.params;
        let local=false;try{local=new URL(request.url).origin===origin;}catch{}
        if(!local)blocked++;
        void cmd(local?'Fetch.continueRequest':'Fetch.failRequest',
          local?{requestId}:{requestId,errorReason:'BlockedByClient'}).catch(()=>errors.push('request interception failed'));
      }
      if(pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}
    };
    const evaluate=async expression=>{const data=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(data.exceptionDetails)throw Error('Chart browser evaluation failed');return data.result?.value;};
    const observed=(expr,label)=>until(async()=>Boolean(await evaluate(expr)),label);
    await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Network.enable');
    await cmd('Network.setBypassServiceWorker',{bypass:true});
    await cmd('Fetch.enable',{patterns:[{urlPattern:'*'}]});
    await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const names=['verified','failed','inconclusive','unrun'];let pointerChecks=0,keyboardChecks=0;
    for(const width of [320,1440]){
      current=initial;
      await cmd('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await cmd('Page.navigate',{url:origin+'/'});
      await observed("document.readyState==='complete' && document.querySelectorAll('#outcomes-chart .bar-column').length===4 && document.querySelector('#ops-state').textContent.includes('실측 관측 완료')",'fixture snapshot');
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),true,'document overflow');
      assert.deepEqual(await evaluate("[...document.querySelectorAll('#outcomes-chart .bar-column')].map(x=>x.getAttribute('aria-label').match(/\\d+/)[0])"),['0','0','0','22']);
      async function position(x,y){
        return evaluate(`(()=>{const f=document.getElementById('filter-state');f.value='all';f.dispatchEvent(new Event('change'));const s=document.getElementById('outcomes-chart');s.scrollIntoView({block:'center',behavior:'instant'});const p=new DOMPoint(${x},${y}).matrixTransform(s.getScreenCTM());return {x:p.x,y:p.y};})()`);
      }
      async function click(x,y,expected,touch){
        const p=await position(x,y);
        if(touch){
          await cmd('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});
          await cmd('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        }else{
          await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});
          await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});
          await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});
        }
        const actual=await evaluate("document.getElementById('filter-state').value");
        assert.equal(actual,expected,`${width}px ${touch?'touch':'mouse'} at ${x},${y}`);pointerChecks++;
      }
      for(const touch of [false,true]){
        await cmd('Emulation.setTouchEmulationEnabled',{enabled:touch,maxTouchPoints:1});
        for(let i=0;i<4;i++){
          const left=53+125*i;
          for(const [x,y] of [[left+4,100],[left+108,100],[left+56,34],[left+56,100],[left+56,226]])
            await click(x,y,names[i],touch);
        }
        // Exact outside boundaries are asserted with a mouse: browsers may
        // intentionally retarget a touch near a neighboring interactive area.
        const outside=touch?[[10,100]]:
          [[10,100],[49,100],[169,100],[294,100],[419,100],[544,100],[109,26],[109,234]];
        for(const [x,y] of outside)await click(x,y,'all',touch);
      }
      await cmd('Emulation.setTouchEmulationEnabled',{enabled:false});
      for(let i=0;i<4;i++){
        await evaluate(`(()=>{const f=document.getElementById('filter-state');f.value='all';f.dispatchEvent(new Event('change'));document.querySelectorAll('#outcomes-chart .bar-column')[${i}].focus();})()`);
        const key=i%2?' ':'Enter',code=i%2?'Space':'Enter',vk=i%2?32:13;
        await cmd('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
        await cmd('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
        assert.equal(await evaluate("document.getElementById('filter-state').value"),names[i]);keyboardChecks++;
      }
      // A response updates the same controls; exercise a formerly-zero bar again.
      await evaluate("window.__chartQaFirst=document.querySelector('#outcomes-chart .bar-column');window.__chartQaFirst.focus()");
      current=refreshed;await evaluate("document.getElementById('ops-refresh').click()");
      await observed("document.querySelector('#outcomes-chart .bar-column').getAttribute('aria-label').includes('1건')",'refreshed snapshot');
      assert.equal(await evaluate("document.activeElement===window.__chartQaFirst && document.querySelector('#outcomes-chart .bar-column')===window.__chartQaFirst"),true,'focus retained');
      await click(109,100,'verified',false);
    }
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(blocked,0,'unexpected external request blocked');
    console.log(`PASS chart browser: ${pointerChecks} synthetic mouse/touch positions, ${keyboardChecks} keyboard activations, 320/1440px, refresh and focus.`);
  }finally{
    socket?.close();
    if(chrome){chrome.kill();if(chrome.exitCode===null)await Promise.race([once(chrome,'exit').catch(()=>{}),sleep(3000)]);}
    server.closeIdleConnections?.();await new Promise(resolve=>server.close(resolve));
    if(dir)await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}
await main();
