// Real Chromium SVG hit-testing against a loopback-only, synthetic API fixture.
// This does not contact the deployed app, Supabase, the judge, or student data.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {once} from 'node:events';
import {OPS_TRACE_BINDING,OPS_TRACE_HEADER,OPS_TRACE_STATE,operationsRequestTraceSource,
  isOperationsRequestTrace,isKnownCancelledInterception} from './browser-request-trace.mjs';

const root=resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label,timeout=15000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await predicate())return;await sleep(50);}
  throw Error('Chart browser QA timeout: '+label);
}
function recoverySnapshotReady(state){
  return state?.statusText==='기기 검증 화면 로드 실패'&&state.operationsUsable===true
    &&state.operationsActive===0&&state.operationsState?.includes('실측 관측 완료')===true;
}
async function waitForRecoverySnapshot(readState,wait,label){
  let state=null;
  try{
    await wait(async()=>{state=await readState();return recoverySnapshotReady(state);},label);
  }catch(error){
    console.error('Chart browser recovery readiness:',JSON.stringify({
      active:state?.operationsActive??null,started:state?.operationsStarted??null,
      disabled:state?.operationsDisabled??null,ariaDisabled:state?.operationsAriaDisabled??null,
      visible:state?.operationsVisible??null,
    }));
    throw error;
  }
  return state;
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
const incomplete={...refreshed,target:'https://incomplete-fixture.vercel.app',policy:null};
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
  let pendingResponse=null;
  let deviceModuleFixture=null,releaseDeviceModule=null;
  const unexpected=[];
  const server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    res.setHeader('Cache-Control','no-store');
    if(path==='/api/ops'&&req.method==='GET'){
      if(pendingResponse)await pendingResponse;
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(current));return;
    }
    if(path==='/api/auth/session'&&req.method==='POST'){
      res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"UNAUTHORIZED"}');return;
    }
    if(path==='/sw.js'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/javascript'});res.end('// inert test service worker');return;
    }
    if(path==='/device.mjs'&&req.method==='GET'&&deviceModuleFixture){
      const controlled=deviceModuleFixture;controlled.requests++;
      if(controlled.pending)await controlled.pending;
      if(res.destroyed)return;
      res.writeHead(200,{'Content-Type':'text/javascript'});res.end(controlled.source);return;
    }
    const asset=assets.get(path);
    if(req.method!=='GET'||!asset){unexpected.push(path);res.writeHead(404);res.end();return;}
    try{const data=await readFile(resolve(root,asset));res.writeHead(200,{'Content-Type':mime(asset)});res.end(data);}
    catch{unexpected.push('fixture_asset_missing');res.writeHead(404);res.end();}
  });
  let chrome,socket,dir;const pending=new Map(),errors=[],interceptionFailures=[],interceptions=new Set(),networkFailures=new Map(),requestTraces=new Map();let nextId=0,blocked=0;
  let armCancellation=false,heldCancellation=null,controlledCancellations=0,pageLifecycleChecks=0,moduleRecoveryChecks=0;
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
      if(data.error)throw Object.assign(Error('CDP '+method+': '+data.error.message),{cdpCode:data.error.code});
      return data.result;
    }
    function resumeIntercepted(details){
      const {local,requestId,...diagnostics}=details;
      const method=local?'Fetch.continueRequest':'Fetch.failRequest';
      const completion=cmd(method,local?{requestId}:{requestId,errorReason:'BlockedByClient'})
        .catch(error=>interceptionFailures.push({method,requestId,...diagnostics,
          cdpCode:error.cdpCode??null,error:String(error.message).slice(0,500)}))
        .finally(()=>interceptions.delete(completion));
      interceptions.add(completion);
      return completion;
    }
    socket.onmessage=event=>{
      const msg=JSON.parse(event.data);
      if(msg.method==='Runtime.exceptionThrown')errors.push('page exception');
      if(msg.method==='Runtime.consoleAPICalled'&&['warning','error','assert'].includes(msg.params.type)){
        errors.push('console '+msg.params.type);
      }
      if(msg.method==='Log.entryAdded'&&['warning','error'].includes(msg.params.entry.level)){
        const entry=msg.params.entry;
        const expectedAnonymousRejection=entry.source==='network'
          && entry.url===origin+'/api/auth/session' && entry.text.includes('401');
        if(!expectedAnonymousRejection)errors.push(entry.source+' '+entry.level+': '+entry.text);
      }
      if(msg.method==='Network.loadingFailed'){
        const {requestId,canceled,errorText}=msg.params;
        networkFailures.set(requestId,{canceled:canceled===true,errorText:String(errorText).slice(0,200)});
      }
      if(msg.method==='Runtime.bindingCalled'&&msg.params.name===OPS_TRACE_BINDING){
        try{
          const trace=JSON.parse(msg.params.payload);
          if(!isOperationsRequestTrace(trace,origin)||requestTraces.has(trace.id)||requestTraces.size>=256)throw Error('invalid trace');
          requestTraces.set(trace.id,trace);
        }catch{errors.push('invalid operations request trace');}
      }
      if(msg.method==='Fetch.requestPaused'){
        const {requestId,request,networkId,resourceType,responseErrorReason,responseStatusCode}=msg.params;
        let local=false,url='invalid URL';
        try{const parsed=new URL(request.url);local=parsed.origin===origin;
          url=(/^https?:$/u.test(parsed.protocol)?parsed.origin+parsed.pathname:parsed.protocol).slice(0,300);
        }catch{}
        if(!local)blocked++;
        const qaRequestId=Object.entries(request.headers??{}).find(([name])=>name.toLowerCase()===OPS_TRACE_HEADER)?.[1]??null;
        const cancellationProbe=Object.entries(request.headers??{}).find(([name])=>name.toLowerCase()==='x-claire-qa-cancel')?.[1]==='1';
        const details={local,requestId,networkId:networkId??null,url,resourceType,qaRequestId,
          responseErrorReason:responseErrorReason??null,responseStatusCode:responseStatusCode??null};
        if(armCancellation&&cancellationProbe&&local&&url===origin+'/api/ops'&&typeof qaRequestId==='string'){
          armCancellation=false;heldCancellation=details;
        }else resumeIntercepted(details);
      }
      if(pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}
    };
    const evaluate=async expression=>{const data=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(data.exceptionDetails)throw Error('Chart browser evaluation failed');return data.result?.value;};
    const observed=(expr,label)=>until(async()=>Boolean(await evaluate(expr)),label);
    async function activate(useSpace){
      const key=useSpace?' ':'Enter',code=useSpace?'Space':'Enter',vk=useSpace?32:13;
      const text=useSpace?' ':'\r';
      const params={key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk};
      await cmd('Input.dispatchKeyEvent',{type:'keyDown',...params,text,unmodifiedText:text});
      await cmd('Input.dispatchKeyEvent',{type:'keyUp',...params});
    }
    await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Network.enable');await cmd('Log.enable');
    await cmd('Runtime.addBinding',{name:OPS_TRACE_BINDING});
    await cmd('Page.addScriptToEvaluateOnNewDocument',{source:operationsRequestTraceSource(origin)});
    await cmd('Network.setBypassServiceWorker',{bypass:true});
    await cmd('Fetch.enable',{patterns:[{urlPattern:'*'}]});
    const names=['verified','failed','inconclusive','unrun'];let pointerChecks=0,keyboardChecks=0,tabFrames=0;
    for(const width of [320,1440]){
      current=initial;
      await cmd('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await cmd('Page.navigate',{url:origin+'/'});
      await observed("document.readyState==='complete' && document.querySelectorAll('#outcomes-chart .bar-column').length===4 && document.querySelector('#ops-state').textContent.includes('실측 관측 완료')",'fixture snapshot');
      // Check native Tab scrolling with the user's ordinary motion setting.
      // Sampling in focusin catches the first painted frame even if CDP is slow.
      await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      const stops=await evaluate(`(()=>{
        document.querySelector('.skip').focus();
        const targets=[...document.querySelectorAll('.brand,.mainnav a,#ops-refresh,#ops-export,.metric-help summary,.bar-column,.table-bar select,#ops-reset,#evidence-scroll')];
        document.addEventListener('focusin',event=>{
          const el=event.target;
          window.__qaTabFrame=new Promise(resolve=>requestAnimationFrame(()=>{
            const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
            const ring=style.outlineStyle==='none'?0:Math.max(0,parseFloat(style.outlineWidth)+parseFloat(style.outlineOffset));
            const header=document.querySelector('.topbar');
            const inset=el.id==='evidence-scroll' && getComputedStyle(header).position==='sticky' ? header.getBoundingClientRect().bottom : 0;
            resolve({index:targets.indexOf(el),label:el.id||el.getAttribute('aria-label')||el.textContent,
              visible:document.activeElement===el && rect.width>0 && rect.height>0
                && rect.left-ring>=0 && rect.top-ring>=inset && rect.right+ring<=innerWidth && rect.bottom+ring<=innerHeight});
          }));
        },{signal:(window.__qaTabListener=new AbortController()).signal});
        return targets.length;
      })()`);
      for(let index=0;index<stops;index++){
        const tab={key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9};
        await cmd('Input.dispatchKeyEvent',{type:'rawKeyDown',...tab});
        await cmd('Input.dispatchKeyEvent',{type:'keyUp',...tab});
        const frame=await evaluate('window.__qaTabFrame');
        assert.equal(frame?.index,index,`${width}px native tab order at stop ${index+1}`);
        assert.ok(frame.visible,`${width}px focus outside the first frame: ${frame.label}`);
        tabFrames++;
      }
      await evaluate('window.__qaTabListener.abort()');
      await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      if(width===320){
        // Hold exactly one tagged native request, then cancel its original
        // signal. This proves the trace without weakening unrelated failures.
        armCancellation=true;
        await evaluate(`(()=>{window.__qaOpsCancel=new AbortController();
          window.__qaOpsCancelResult=fetch('/api/ops',{signal:window.__qaOpsCancel.signal,headers:{'x-claire-qa-cancel':'1'}})
            .then(()=>false,error=>error.name==='AbortError');return true;})()`);
        await until(()=>heldCancellation!==null,'controlled request intercepted');
        const held=heldCancellation;heldCancellation=null;
        await evaluate('window.__qaOpsCancel.abort(); true');
        await until(()=>requestTraces.has(held.qaRequestId),'native pre-header abort observed');
        const trace=requestTraces.get(held.qaRequestId);
        assert.equal(trace.abortedBeforeHeaders,true);assert.equal(trace.headersReceived,false);
        assert.equal(trace.errorName,'AbortError');
        assert.equal(await evaluate('window.__qaOpsCancelResult'),true);
        await resumeIntercepted(held);
        controlledCancellations++;
      }
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),true,'document overflow');
      assert.deepEqual(await evaluate("[...document.querySelectorAll('#outcomes-chart .bar-column')].map(x=>x.getAttribute('aria-label').match(/\\d+/)[0])"),['0','0','0','22']);
      for(let i=0;i<4;i++){
        await evaluate(`document.querySelectorAll('.metric-help summary')[${i}].focus()`);
        await activate(i%2);
        assert.equal(await evaluate(`(()=>{
          const details=document.querySelectorAll('.metric-help')[${i}];
          const card=details.closest('.metric').getBoundingClientRect();
          const text=details.querySelector('p').getBoundingClientRect();
          return details.open&&text.left>=card.left&&text.right<=card.right&&text.bottom<=card.bottom;
        })()`),true,'opened help fits within its metric');
        await activate(i%2);
        assert.equal(await evaluate("!document.activeElement.parentElement.open"),true,'keyboard closes help and retains focus');
      }
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
        await activate(i%2);
        assert.equal(await evaluate("document.getElementById('filter-state').value"),names[i]);keyboardChecks++;
        const frames=await evaluate(`(async()=>{
          const samples=[];
          for(let i=0;i<6;i++){
            await new Promise(requestAnimationFrame);
            const active=document.activeElement, rect=active.getBoundingClientRect();
            samples.push(active.id==='evidence-title'&&rect.top>=0&&rect.bottom<=innerHeight);
          }
          return samples;
        })()`);
        assert.ok(frames.every(Boolean),'each frame exposes the new keyboard focus');
      }
      await evaluate("document.querySelector('#filter-state').value='failed';document.querySelector('#filter-state').dispatchEvent(new Event('change'))");
      assert.match(await evaluate("document.querySelector('#evidence-body').textContent"),/조건에 맞는 항목이 없습니다/);
      await observed("document.getElementById('evidence-scroll').tabIndex===-1",'empty ledger has no unnecessary tab stop');
      if(width===320){
        await cmd('Emulation.setDeviceMetricsOverride',{width:768,height:900,deviceScaleFactor:1,mobile:false});
        await observed("document.getElementById('evidence-scroll').tabIndex===0",'tablet ledger can scroll with the keyboard');
        const emptyVisible=await evaluate(`(async()=>{
          const wrap=document.getElementById('evidence-scroll');
          document.getElementById('ops-reset').click();
          wrap.scrollLeft=wrap.scrollWidth;
          const filter=document.getElementById('filter-state');
          filter.value='failed';filter.dispatchEvent(new Event('change'));
          await new Promise(requestAnimationFrame);
          const area=wrap.getBoundingClientRect();
          const hint=document.querySelector('.table-empty > span').getBoundingClientRect();
          return wrap.scrollLeft>0 && hint.width>0 && hint.left>=area.left && hint.right<=area.right;
        })()`);
        assert.ok(emptyVisible,'empty result remains readable at the far edge of a scrolled table');
        await cmd('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      }
      // A response updates the same controls; exercise a formerly-zero bar again.
      await evaluate("window.__chartQaFirst=document.querySelector('#outcomes-chart .bar-column');window.__chartQaFirst.focus()");
      current=refreshed;await evaluate("document.getElementById('ops-refresh').click()");
      await observed("document.querySelector('#outcomes-chart .bar-column').getAttribute('aria-label').includes('1건')",'refreshed snapshot');
      assert.equal(await evaluate("document.activeElement===window.__chartQaFirst && document.querySelector('#outcomes-chart .bar-column')===window.__chartQaFirst"),true,'focus retained');
      await click(109,100,'verified',false);
      if(width===320){
        const ledger=await evaluate(`(()=>{
          const wrap=document.getElementById('evidence-scroll'),area=wrap.getBoundingClientRect();
          const row=document.querySelector('#evidence-body tr'),cells=[...row.cells];
          return {width:wrap.clientWidth,scrollWidth:wrap.scrollWidth,columns:cells.length,
            visible:cells.every(cell=>{
              const bounds=cell.getBoundingClientRect();
              return bounds.width>0 && bounds.left>=area.left && bounds.right<=area.right;
            }),observation:cells[4].innerText};
        })()`);
        assert.equal(ledger.scrollWidth,ledger.width,'phone ledger needs no sideways scrolling');
        assert.equal(ledger.columns,8);assert.ok(ledger.visible,'all observation fields fit the phone ledger');
        assert.match(ledger.observation,/HTTP 200/u);
      }
      current=incomplete;
      let releaseResponse;
      pendingResponse=new Promise(resolve=>{releaseResponse=resolve;});
      try{
        await evaluate("document.getElementById('ops-refresh').focus();document.getElementById('ops-refresh').click()");
        const pendingFrames=await evaluate(`(async()=>{
          const samples=[];
          for(let i=0;i<6;i++){
            await new Promise(requestAnimationFrame);
            samples.push(document.activeElement.id==='ops-refresh'&&document.activeElement.getAttribute('aria-disabled')==='true');
          }
          return samples;
        })()`);
        assert.ok(pendingFrames.every(Boolean),'refresh retains keyboard focus while pending');
      }finally{
        pendingResponse=null;
        releaseResponse();
      }
      await observed("document.querySelector('#ops-state').textContent.includes('조회 실패')",'rejected refresh');
      assert.equal(await evaluate("document.querySelector('#ops-target').textContent"),'미확인','invalid response did not change rendered data');
      assert.equal(await evaluate("document.querySelector('#metric-observed').textContent"),'3');
      assert.equal(await evaluate(`(async()=>{
        let blob;
        const make=URL.createObjectURL, click=HTMLAnchorElement.prototype.click;
        try{
          URL.createObjectURL=(value)=>{blob=value;return make(value);};
          HTMLAnchorElement.prototype.click=()=>{};
          document.querySelector('#ops-export').click();
          return JSON.parse(await blob.text()).target;
        }finally{
          URL.createObjectURL=make; HTMLAnchorElement.prototype.click=click;
        }
      })()`),null,'export still uses the last valid snapshot');
      current=initial;
      await evaluate("document.getElementById('ops-refresh').click()");
      await observed("document.querySelector('#ops-state').textContent.includes('실측 관측 완료') && document.querySelector('#metric-observed').textContent==='0'",'successful retry');
      await observed(`window.${OPS_TRACE_STATE}.active===0`,'native request trace cleanup');
      assert.equal(await evaluate(`window.${OPS_TRACE_STATE}.failures`),0,'trace callback failures');
      if(width===320){
        // Real DOM event ordering with synthetic BFCache transition events.
        // Device locking publishes a session change during pagehide as well.
        const lifecycle=await evaluate(`(()=>{
          const read=()=>({started:window.${OPS_TRACE_STATE}.started,active:window.${OPS_TRACE_STATE}.active,
            target:document.querySelector('#ops-target').textContent,observed:document.querySelector('#metric-observed').textContent});
          const before=read();window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
          window.dispatchEvent(new Event('aleph:session'));document.querySelector('#ops-refresh').click();
          return {before,hidden:read()};
        })()`);
        assert.deepEqual(lifecycle.hidden,lifecycle.before,'hidden page neither sends a new request nor replaces the last observation');
        assert.equal(lifecycle.hidden.active,0);
        await evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})); true");
        await observed(`window.${OPS_TRACE_STATE}.started>${lifecycle.before.started}
          && window.${OPS_TRACE_STATE}.active===0
          && document.querySelector('#ops-state').textContent.includes('실측 관측 완료')
          && document.querySelector('#metric-observed').textContent==='0'`,'page restoration recovers observations');
        assert.equal(await evaluate(`window.${OPS_TRACE_STATE}.failures`),0);
        pageLifecycleChecks++;
      }
    }
    const recoveryState=(activateOperations=false)=>evaluate(`(()=>{
      const visible=node=>{
        if(!node)return false;
        for(let current=node;current;current=current.parentElement){
          const style=getComputedStyle(current);
          if(current.hidden||current.inert||current.getAttribute('aria-hidden')==='true'
            ||style.display==='none'||['hidden','collapse'].includes(style.visibility)||Number(style.opacity)===0)return false;
        }
        return [...node.getClientRects()].some(rect=>rect.width>0&&rect.height>0);
      };
      const byId=id=>document.getElementById(id),status=byId('device-state'),detail=byId('device-detail');
      const loginControls=[byId('email'),byId('password'),document.querySelector('#login-form button[type="submit"]')];
      const refresh=byId('ops-refresh'),workspace=byId('workspace');
      const operationsVisible=visible(refresh),operationsDisabled=refresh.disabled,
        operationsAriaDisabled=refresh.getAttribute('aria-disabled'),trace=window.${OPS_TRACE_STATE};
      const state={
        recoveryVisible:[byId('device-panel'),status,detail].every(visible),
        statusRole:status.getAttribute('role'),statusLive:status.getAttribute('aria-live'),
        statusText:status.textContent,detailText:detail.textContent,
        disabledActions:['device-enroll','device-unlock','device-refresh'].map(id=>byId(id).disabled),
        vaultLocked:workspace.hidden&&workspace.getClientRects().length===0,
        loginUsable:visible(byId('signed-out'))&&loginControls.every(node=>visible(node)&&!node.disabled&&!node.readOnly&&node.getAttribute('aria-disabled')!=='true'),
        operationsUsable:operationsVisible&&!operationsDisabled&&operationsAriaDisabled!=='true',
        operationsVisible,operationsDisabled,operationsAriaDisabled,
        operationsState:byId('ops-state').textContent,operationsActive:trace.active,operationsStarted:trace.started,
        module:window.__qaDeviceModule??null,elapsed:performance.now()
      };
      // Check and activate in the same browser evaluation. Return the captured
      // pre-click count so a later completed request must prove this action ran.
      if(${activateOperations}&&(${recoverySnapshotReady.toString()})(state))refresh.click();
      return state;
    })()`);
    const assertRecovery=state=>{
      assert.equal(state.recoveryVisible,true,'module recovery is rendered through every ancestor');
      assert.equal(state.statusRole,'status');assert.equal(state.statusLive,'polite');
      assert.equal(state.statusText,'기기 검증 화면 로드 실패');
      assert.match(state.detailText,/브라우저 새로고침으로 다시 시도/);
      assert.deepEqual(state.disabledActions,[true,true,true],'unavailable device actions remain disabled');
      assert.equal(state.vaultLocked,true,'module failure never opens the vault');
      assert.equal(state.loginUsable,true,'independent login controls remain visible and enabled');
      assert.equal(state.operationsUsable,true,'independent operations control remains usable');
    };
    for(const mode of ['evaluation-failure','deadline']){
      // Finish the prior document's native reads before replacing its context.
      await observed(`window.${OPS_TRACE_STATE}.active===0`,'idle operations before module fixture navigation');
      current=initial;
      let release;
      const controlled={requests:0,pending:mode==='deadline'?new Promise(resolve=>{release=resolve;}):null,
        source:`window.__qaDeviceModule={evaluated:1,initializations:0};
          ${mode==='evaluation-failure'?"throw Error('QA_DEVICE_MODULE_EVALUATION_FAILED');":''}
          export function initDeviceAccess(){window.__qaDeviceModule.initializations++;return {};}`};
      deviceModuleFixture=controlled;releaseDeviceModule=release;
      try{
        await cmd('Page.navigate',{url:origin+'/'});
        await until(()=>controlled.requests===1,'controlled device module requested');
        const beforeRelease=await waitForRecoverySnapshot(recoveryState,until,'visible device module '+mode+' recovery');
        assertRecovery(beforeRelease);
        if(mode==='deadline'){
          assert.ok(beforeRelease.elapsed>=10000,'the real 10 second loader deadline elapsed');
          assert.equal(beforeRelease.module,null,'held module has not evaluated before recovery');
        }else assert.deepEqual(beforeRelease.module,{evaluated:1,initializations:0},'evaluation rejection was caught without mounting');

        // Exercise native keyboard navigation and empty-field validation;
        // no account or authentication mutation is involved in this fixture.
        await evaluate("document.getElementById('email').focus()");
        assert.equal(await evaluate("document.activeElement.id"),'email');
        for(const selector of ['#password','#login-form button[type="submit"]']){
          const tab={key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9};
          await cmd('Input.dispatchKeyEvent',{type:'keyDown',...tab});
          await cmd('Input.dispatchKeyEvent',{type:'keyUp',...tab});
          assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),true,'login keyboard navigation');
        }
        await activate(false);
        assert.equal(await evaluate("document.activeElement.id==='email' && document.getElementById('email').validity.valueMissing && document.getElementById('password').validity.valueMissing"),true,'native login validation remains available');
        current=refreshed;
        const activated=await waitForRecoverySnapshot(()=>recoveryState(true),until,'usable operations refresh after device module failure');
        const priorStarted=activated.operationsStarted;
        await observed(`window.${OPS_TRACE_STATE}.started>${priorStarted} && window.${OPS_TRACE_STATE}.active===0
          && document.querySelector('#ops-state').textContent.includes('실측 관측 완료')
          && document.querySelector('#metric-observed').textContent==='3'`,'operations refresh after device module failure');
        if(release){
          release();releaseDeviceModule=null;
        }
        await observed("document.readyState==='complete' && window.__qaDeviceModule?.evaluated===1",'device fixture load and top-level evaluation');
        // Let the import completion and its microtasks run before checking
        // that an already-expired loader did not call the late module's init.
        await evaluate('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return true;})()');
        const settled=await waitForRecoverySnapshot(recoveryState,until,'settled device module '+mode+' recovery');
        assertRecovery(settled);
        assert.deepEqual(settled.module,{evaluated:1,initializations:0},'failed or late modules never initialize');
        assert.equal(await evaluate(`window.${OPS_TRACE_STATE}.failures`),0,'module recovery trace callback failures');
        assert.equal(controlled.requests,1,'one controlled module response per document');
        moduleRecoveryChecks++;
      }finally{
        release?.();releaseDeviceModule=null;deviceModuleFixture=null;
      }
    }
    while(interceptions.size)await Promise.all([...interceptions]);
    const knownCancellations=interceptionFailures.filter(failure=>isKnownCancelledInterception(failure,requestTraces.get(failure.qaRequestId),origin));
    const unexpectedInterceptions=interceptionFailures.filter(failure=>!isKnownCancelledInterception(failure,requestTraces.get(failure.qaRequestId),origin));
    assert.deepEqual(unexpectedInterceptions.map(failure=>({...failure,networkFailure:networkFailures.get(failure.networkId)??null,
      requestTrace:requestTraces.get(failure.qaRequestId)??null})),[],
    'Only an exactly correlated native pre-header cancellation may explain an expired interception ID.');
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(blocked,0,'unexpected external request blocked');
    assert.equal(controlledCancellations,1,'controlled native cancellation exercised');
    assert.equal(pageLifecycleChecks,1,'browser pagehide and restored pageshow exercised');
    assert.equal(moduleRecoveryChecks,2,'module evaluation rejection and real loader deadline exercised');
    console.log(`PASS chart browser: ${pointerChecks} synthetic mouse/touch positions, ${keyboardChecks} chart activations, 16 help toggles, 60 focus frames, 320/1440px, invalid response, previous export and retry.`);
    console.log(`PASS portal keyboard navigation: ${tabFrames} first-frame focus outlines across navigation, metric help, chart and filters.`);
    console.log(`PASS request lifecycle: ${controlledCancellations} controlled native pre-header abort, ${knownCancellations.length} exactly correlated cancelled interceptions, ${pageLifecycleChecks} pagehide/restore check, 0 unexpected interception errors.`);
    console.log(`PASS device module recovery: ${moduleRecoveryChecks} visible accessible fallbacks, disabled device actions, locked vault, usable login/operations, actual 10 second deadline and late evaluation without initialization.`);
  }finally{
    releaseDeviceModule?.();
    socket?.close();
    if(chrome){chrome.kill();if(chrome.exitCode===null)await Promise.race([once(chrome,'exit').catch(()=>{}),sleep(3000)]);}
    server.closeIdleConnections?.();await new Promise(resolve=>server.close(resolve));
    if(dir)await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}
await main();
