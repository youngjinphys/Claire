// This module displays SERVER decisions; it never grants access on install or click.
export function initDeviceAccess({getAccessToken,onAuthorized,onLocked,requestTimeoutMs=10000}){
  if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>60000)throw Error('DEVICE_REQUEST_LIMIT_INVALID');
  const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const validStatus=value=>record(value)&&value.schema==='aleph.device.status.v1'
    &&['approved','pending','not_registered'].includes(value.registration)
    &&typeof value.verified==='boolean'&&typeof value.canOpenVault==='boolean'
    &&value.verified===value.canOpenVault&&(!value.verified||value.registration==='approved')
    &&value.installIsApproval===false;
  const validRegistration=value=>record(value)&&value.schema==='aleph.device.registration.v1'
    &&value.registration==='approved'&&value.verifiedDeviceProof===false&&value.next==='assertion_required';
  // Match the existing server grant consumer, not only the generator's current length.
  const validProof=value=>record(value)&&value.schema==='aleph.device.proof.v1'&&value.approved===true
    &&typeof value.proof==='string'&&/^[A-Za-z0-9_-]{40,100}$/u.test(value.proof)
    &&Number.isFinite(value.expiresInSeconds)&&value.expiresInSeconds>0;
  const node=id=>document.getElementById(id);
  const display=(label,text)=>{node('device-state').textContent=label;node('device-detail').textContent=text;};
  const register=node('device-enroll'),unlock=node('device-unlock'),refresh=node('device-refresh');
  let busy=false,epoch=0,statusGeneration=0,installedPrompt=null,activePrompt=null,disposed=false;
  const activeRequests=new Set();

  function controls(approved=false,verified=false,checking=false){
    const loggedIn=Boolean(getAccessToken());
    node('device-panel').hidden=!loggedIn;
    register.hidden=!loggedIn||approved||verified||checking;
    unlock.hidden=!loggedIn||!approved||verified||checking;
    refresh.hidden=!loggedIn;
    for(const control of [register,unlock,refresh])control.disabled=busy;
  }
  function lock(){
    epoch++;statusGeneration++;busy=false;
    for(const controller of activeRequests)controller.abort();
    if(activePrompt){
      activePrompt=null;
      try{window.SimpleWebAuthnBrowser?.WebAuthnAbortService?.cancelCeremony?.();}catch{}
    }
    onLocked();controls(false,false,true);
  }

  async function authenticatorPrompt(start){
    const prompt={};activePrompt=prompt;
    try{return await start();}
    finally{if(activePrompt===prompt)activePrompt=null;}
  }

  async function deviceRequest(action,body,proof){
    const token=getAccessToken();
    if(!token)throw Error('LOGIN_REQUIRED');
    if(disposed)throw Error('DEVICE_REQUEST_CANCELLED');
    const savedEpoch=epoch,controller=new AbortController(),deadline=performance.now()+requestTimeoutMs;
    activeRequests.add(controller);
    const headers={Authorization:'Bearer '+token,Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(proof)headers['x-aleph-device-proof']=proof;
    let responseBody,reader,timedOut=false,onAbort;
    const discarded=new WeakSet();
    // Disposal must not replace the outcome or wait on an uncooperative stream.
    const discard=()=>{
      const stream=reader||responseBody;
      if(!stream||(typeof stream!=='object'&&typeof stream!=='function')||discarded.has(stream))return;
      discarded.add(stream);
      const release=()=>{try{stream.releaseLock?.();}catch{}};
      try{const pending=stream.cancel();release();void Promise.resolve(pending).then(release,release);}
      catch{release();}
    };
    const check=()=>{
      if(performance.now()>=deadline){timedOut=true;controller.abort();}
      if(timedOut)throw Error('DEVICE_REQUEST_TIMEOUT');
      if(controller.signal.aborted||disposed||savedEpoch!==epoch||token!==getAccessToken())throw Error('DEVICE_REQUEST_CANCELLED');
    };
    const stopped=new Promise((_,reject)=>{
      onAbort=()=>reject(Error(timedOut?'DEVICE_REQUEST_TIMEOUT':'DEVICE_REQUEST_CANCELLED'));
      controller.signal.addEventListener('abort',onAbort,{once:true});
    });
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},requestTimeoutMs);
    const work=async()=>{
      check();
      const path='/api/device?action='+encodeURIComponent(action),init={
        method:action==='status'?'GET':'POST',headers,credentials:'omit',
        cache:'no-store',redirect:'error',signal:controller.signal,
        body:body===undefined?undefined:JSON.stringify(body)
      };
      check();
      const r=await fetch(path,init);
      responseBody=r?.body;
      try{
        check();
        if(r.redirected||!/^application\/json(?:;|$)/iu.test(r.headers?.get('content-type')||'')
          ||typeof responseBody?.getReader!=='function')throw Error('DEVICE_RESPONSE_INVALID');
        const length=r.headers.get('content-length');
        if(length!==null&&(!/^\d+$/u.test(length)||Number(length)>65536))throw Error('DEVICE_RESPONSE_INVALID');
        reader=responseBody.getReader();
        const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
        while(true){
          const part=await reader.read();check();if(part.done)break;
          size+=part.value.byteLength;if(size>65536)throw Error('DEVICE_RESPONSE_INVALID');
          text+=decoder.decode(part.value,{stream:true});
        }
        const data=JSON.parse(text+decoder.decode());check();
        if(!r.ok)throw Error('DEVICE_HTTP_'+r.status);
        return data;
      }finally{discard();}
    };
    try{const result=await Promise.race([work(),stopped]);check();return result;}
    catch(error){check();throw error;}
    finally{
      clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);
      activeRequests.delete(controller);controller.abort();discard();
    }
  }
  async function status({notice='',focusFrom=null}={}){
    if(disposed)return;
    const saved=epoch,generation=++statusGeneration,token=getAccessToken();
    if(busy)return;
    if(!token){
      controls();display('로그인 전','먼저 로그인하면 서버에서 기기 상태를 조회합니다.');return;
    }
    function current(){
      if(saved!==epoch||generation!==statusGeneration||busy)return false;
      if(token!==getAccessToken()){void status();return false;}
      return true;
    }
    controls(false,false,true);
    display('기기 확인 중',(notice?notice+' ':'')+'등록·승인 여부를 서버에서 다시 확인합니다.');
    try{
      const response=await deviceRequest('status');
      if(!current())return;
      if(!validStatus(response))throw Error('INVALID_DEVICE_STATUS');
      const approved=response?.registration==='approved';
      const verified=response?.verified===true&&response?.canOpenVault===true;
      if(verified)display('기기 확인 완료','서버가 유효한 기기 증명을 확인했습니다.');
      else if(approved)display('등록 기기 · 재인증 필요',
        '등록된 기기입니다. 인증기의 새 서명을 제출해야 기존 자료실이 열립니다.');
      else if(response?.registration==='pending')display('승인 대기',
        '서버의 승인 결과가 아직 확인되지 않았습니다. 보호 자료는 잠겨 있습니다.');
      else display('기기 미승인','이 기기에서 WebAuthn 등록을 요청해야 합니다. 설치 여부는 무관합니다.');
      controls(approved,verified);
      if(notice)node('device-detail').textContent=notice+' '+node('device-detail').textContent;
      if(focusFrom&&document.activeElement===focusFrom&&document.hasFocus?.()!==false)
        (verified?refresh:approved?unlock:register).focus?.();
    }catch(error){
      if(!current())return;
      onLocked();controls(false,false,true);
      display('서버 확인 실패',(notice?notice+' ':'')+'기기 상태 확인이 불가능하여 자료실을 잠갔습니다. 서버 승인 다시 확인 버튼으로 재시도하세요.');
      if(focusFrom&&document.activeElement===focusFrom&&document.hasFocus?.()!==false)refresh.focus?.();
    }
  }
  async function ceremony(kind){
    if(busy||disposed)return;
    if(!window.PublicKeyCredential||!window.SimpleWebAuthnBrowser){
      display('WebAuthn 지원 불가','HTTPS와 보안키 또는 플랫폼 인증기가 필요합니다.');
      return;
    }
    busy=true;
    statusGeneration++;
    const oldEpoch=epoch,token=getAccessToken();
    const current=()=>epoch===oldEpoch&&token===getAccessToken();
    const source=kind==='register'?register:unlock;
    const focusFrom=document.activeElement===source?node('device-heading'):null;
    if(focusFrom&&document.hasFocus?.()!==false)focusFrom.focus?.();
    let opened=false,notice='';
    controls(true,false);
    display('기기 검증 중','브라우저의 PIN 또는 생체인증 안내를 완료하세요. 버튼만으로 승인되지 않습니다.');
    try{
      if(kind==='register'){
        const opts=await deviceRequest('registration-options',{});
        if(!current())return;
        const credential=await authenticatorPrompt(()=>window.SimpleWebAuthnBrowser.startRegistration({optionsJSON:opts}));
        if(!current())return;
        const registration=await deviceRequest('registration-verify',{credential});
        if(!current())return;
        if(!validRegistration(registration))throw Error('INVALID_DEVICE_REGISTRATION');
      }
      const options=await deviceRequest('assertion-options',{});
      if(!current())return;
      const signed=await authenticatorPrompt(()=>window.SimpleWebAuthnBrowser.startAuthentication({optionsJSON:options}));
      if(!current())return;
      const result=await deviceRequest('assertion-verify',{credential:signed});
      if(!current())return;
      if(!validProof(result))throw Error('INVALID_DEVICE_PROOF');
      opened=true;
      onAuthorized(result.proof,result.expiresInSeconds);
      display('인증기 확인 완료','서버가 기기 서명을 검증했으며 기존 자료실이 열렸습니다.');
      controls(true,true);
      if(focusFrom&&document.activeElement===focusFrom&&document.hasFocus?.()!==false)
        node('workspace-title')?.focus?.();
    }catch(error){
      if(!current())return;
      onLocked();
      notice=error?.message==='DEVICE_REQUEST_TIMEOUT'
        ?'서버 확인 시간이 초과됐습니다. 확인되지 않은 기기 승인을 적용하지 않습니다. 상태를 다시 확인한 뒤 직접 재시도하세요.'
        :error?.name==='NotAllowedError'
        ?'인증이 취소되었습니다. 승인된 기기에서 다시 시도할 수 있습니다.'
        :'기기 승인 또는 서명 확인에 실패했습니다. 보호 자료는 표시하지 않습니다.';
      display('자료실 잠김',notice);
    }finally{
      if(epoch!==oldEpoch)return;
      busy=false;
      if(token!==getAccessToken()){
        controls();void status();return;
      }
      if(getAccessToken()){
        for(const b of [register,unlock,refresh])b.disabled=false;
        if(!opened)void status({notice,focusFrom}); // rediscover approved status from server, never from badge
      }
    }
  }
  const enrollClick=()=>ceremony('register'),unlockClick=()=>ceremony('unlock');
  const refreshClick=()=>{lock();void status();},identityChanged=()=>{lock();void status();};
  const pageHidden=()=>lock(),pageShown=event=>{if(event.persisted)void status();};
  register.addEventListener('click',enrollClick);
  unlock.addEventListener('click',unlockClick);
  refresh.addEventListener('click',refreshClick);
  window.addEventListener('aleph:identity',identityChanged);
  window.addEventListener('pagehide',pageHidden);
  window.addEventListener('pageshow',pageShown);

  // PWA installation is informational only and cannot write a device approval.
  const standalone=()=>window.matchMedia?.('(display-mode: standalone)').matches===true;
  let installNotice='',installGeneration=0;
  node('pwa-state').setAttribute?.('role','status');
  node('pwa-state').setAttribute?.('aria-live','polite');
  function pwa(){
    node('pwa-state').textContent=standalone()?'앱 설치형 실행 중 · 기기 승인은 별도입니다'
      :installNotice?installNotice
      :installedPrompt?'설치 가능 · 기기 승인은 별도입니다'
        :'일반 브라우저 · 설치 표시로 기기를 인증할 수 없음';
    node('pwa-install').hidden=!installedPrompt||standalone();
  }
  const offerInstall=event=>{
    event.preventDefault();installGeneration++;installedPrompt=event;installNotice='';pwa();
  };
  const installed=()=>{installGeneration++;installedPrompt=null;installNotice='설치 완료 이벤트를 받았습니다. 기기 승인은 별도입니다.';pwa();};
  const installClick=async()=>{
    if(!installedPrompt)return;
    const prompt=installedPrompt,g=++installGeneration;installedPrompt=null;pwa();
    try{
      const [,choice]=await Promise.all([prompt.prompt(),prompt.userChoice]);
      if(disposed||g!==installGeneration)return;
      installNotice=choice?.outcome==='dismissed'
        ?'설치를 취소했습니다. 필요하면 브라우저 메뉴에서 다시 설치하세요. 기기 승인은 별도입니다.'
        :'설치 요청을 보냈습니다. 브라우저의 설치 결과를 확인하세요. 기기 승인은 별도입니다.';
    }catch{
      if(disposed||g!==installGeneration)return;
      installNotice='설치 화면을 열지 못했습니다. 브라우저 메뉴에서 설치하거나 페이지를 새로고침하세요. 기기 승인은 별도입니다.';
    }
    pwa();
  };
  window.addEventListener('beforeinstallprompt',offerInstall);
  window.addEventListener('appinstalled',installed);
  node('pwa-install').addEventListener('click',installClick);
  pwa();
  if('serviceWorker' in navigator){
    const enable=()=>navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{});
    if(document.readyState==='complete')void enable();
    else window.addEventListener('load',enable,{once:true});
  }
  void status();
  function dispose(){
    if(disposed)return;
    disposed=true;lock();
    register.removeEventListener('click',enrollClick);unlock.removeEventListener('click',unlockClick);
    refresh.removeEventListener('click',refreshClick);window.removeEventListener('aleph:identity',identityChanged);
    window.removeEventListener('pagehide',pageHidden);window.removeEventListener('pageshow',pageShown);
    window.removeEventListener('beforeinstallprompt',offerInstall);window.removeEventListener('appinstalled',installed);
    node('pwa-install').removeEventListener('click',installClick);
  }
  return {status,lock,dispose};
}
