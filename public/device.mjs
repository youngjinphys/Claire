// This module displays SERVER decisions; it never grants access on install or click.
export function initDeviceAccess({getAccessToken,onAuthorized,onLocked}){
  const node=id=>document.getElementById(id);
  const display=(label,text)=>{node('device-state').textContent=label;node('device-detail').textContent=text;};
  const register=node('device-enroll'),unlock=node('device-unlock'),refresh=node('device-refresh');
  let busy=false,epoch=0,installedPrompt=null;

  function controls(approved=false,verified=false){
    const loggedIn=Boolean(getAccessToken());
    node('device-panel').hidden=!loggedIn;
    register.hidden=!loggedIn||approved||verified;
    unlock.hidden=!loggedIn||!approved||verified;
    refresh.hidden=!loggedIn;
    for(const control of [register,unlock,refresh])control.disabled=busy;
  }
  function lock(){epoch++;onLocked();controls();}

  async function deviceRequest(action,body,proof){
    const token=getAccessToken();
    if(!token)throw Error('LOGIN_REQUIRED');
    const headers={Authorization:'Bearer '+token,Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(proof)headers['x-aleph-device-proof']=proof;
    const r=await fetch('/api/device?action='+encodeURIComponent(action),{
      method:action==='status'?'GET':'POST',headers,credentials:'omit',
      cache:'no-store',redirect:'error',
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const data=await r.json().catch(()=>null);
    if(!r.ok)throw Error(data?.error||'DEVICE_HTTP_'+r.status);
    return data;
  }
  async function status(){
    const saved=epoch;
    if(!getAccessToken()){
      controls();display('로그인 전','먼저 로그인하면 서버에서 기기 상태를 조회합니다.');return;
    }
    controls();
    display('기기 확인 중','등록·승인 여부를 서버에서 다시 확인합니다.');
    try{
      const response=await deviceRequest('status');
      if(saved!==epoch)return;
      const approved=response?.registration==='approved';
      const verified=response?.verified===true&&response?.canOpenVault===true;
      if(verified)display('기기 확인 완료','서버가 유효한 기기 증명을 확인했습니다.');
      else if(approved)display('등록 기기 · 재인증 필요',
        '등록된 기기입니다. 인증기의 새 서명을 제출해야 기존 자료실이 열립니다.');
      else if(response?.registration==='pending')display('승인 대기',
        '서버의 승인 결과가 아직 확인되지 않았습니다. 보호 자료는 잠겨 있습니다.');
      else display('기기 미승인','이 기기에서 WebAuthn 등록을 요청해야 합니다. 설치 여부는 무관합니다.');
      controls(approved,verified);
    }catch(error){
      if(saved!==epoch)return;
      onLocked();controls(false,false);
      display('서버 확인 실패','기기 상태 확인이 불가능하여 자료실을 잠갔습니다.');
    }
  }
  async function ceremony(kind){
    if(busy)return;
    if(!window.PublicKeyCredential||!window.SimpleWebAuthnBrowser){
      display('WebAuthn 지원 불가','HTTPS와 보안키 또는 플랫폼 인증기가 필요합니다.');
      return;
    }
    busy=true;
    const oldEpoch=epoch;
    let opened=false;
    controls(true,false);
    display('기기 검증 중','브라우저의 PIN 또는 생체인증 안내를 완료하세요. 버튼만으로 승인되지 않습니다.');
    try{
      if(kind==='register'){
        const opts=await deviceRequest('registration-options',{});
        const credential=await window.SimpleWebAuthnBrowser.startRegistration({optionsJSON:opts});
        if(epoch!==oldEpoch)return;
        const registration=await deviceRequest('registration-verify',{credential});
        if(registration.registration!=='approved')throw Error('DEVICE_NOT_APPROVED');
      }
      const options=await deviceRequest('assertion-options',{});
      const signed=await window.SimpleWebAuthnBrowser.startAuthentication({optionsJSON:options});
      if(epoch!==oldEpoch)return;
      const result=await deviceRequest('assertion-verify',{credential:signed});
      if(result?.schema!=='aleph.device.proof.v1'||result.approved!==true||
         typeof result.proof!=='string'||!result.proof||
         !Number.isFinite(result.expiresInSeconds)||result.expiresInSeconds<=0)
        throw Error('INVALID_DEVICE_PROOF');
      opened=true;
      onAuthorized(result.proof,result.expiresInSeconds);
      display('인증기 확인 완료','서버가 기기 서명을 검증했으며 기존 자료실이 열렸습니다.');
      controls(true,true);
    }catch(error){
      onLocked();
      display('자료실 잠김',error?.name==='NotAllowedError'
        ?'인증이 취소되었습니다. 승인된 기기에서 다시 시도할 수 있습니다.'
        :'기기 승인 또는 서명 확인에 실패했습니다. 보호 자료는 표시하지 않습니다.');
    }finally{
      busy=false;
      if(getAccessToken()){
        for(const b of [register,unlock,refresh])b.disabled=false;
        if(!opened)void status(); // rediscover approved status from server, never from badge
      }
    }
  }
  register.addEventListener('click',()=>ceremony('register'));
  unlock.addEventListener('click',()=>ceremony('unlock'));
  refresh.addEventListener('click',()=>{lock();void status();});
  window.addEventListener('aleph:identity',()=>{lock();void status();});

  // PWA installation is informational only and cannot write a device approval.
  const standalone=()=>window.matchMedia?.('(display-mode: standalone)').matches===true;
  function pwa(){
    node('pwa-state').textContent=standalone()?'앱 설치형 실행 중 · 기기 미검증'
      :installedPrompt?'설치 가능 · 기기 별도 승인 필요'
        :'일반 브라우저 · 설치 표시로 기기를 인증할 수 없음';
    node('pwa-install').hidden=!installedPrompt||standalone();
  }
  window.addEventListener('beforeinstallprompt',event=>{
    event.preventDefault();installedPrompt=event;pwa();
  });
  window.addEventListener('appinstalled',()=>{installedPrompt=null;pwa();});
  node('pwa-install').addEventListener('click',async()=>{
    if(!installedPrompt)return;
    const prompt=installedPrompt;installedPrompt=null;pwa();
    await prompt.prompt();pwa();
  });
  pwa();
  if('serviceWorker' in navigator){
    const enable=()=>navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{});
    if(document.readyState==='complete')void enable();
    else window.addEventListener('load',enable,{once:true});
  }
  void status();
  return {status,lock};
}
