import {createResponseLifetime} from '../on-client/public/http-response.mjs';
// Optional read-only production drift check. This is NOT an official ALEPH test.
// Never send credentials, follow redirects, or read private endpoints.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readCurrentCommit} from './bundle-commit-metadata.mjs';
import {compareDeploymentIdentity} from '../src/deployment-evidence.mjs';

const root=resolve(import.meta.dirname,'..');
const checkedConfig=JSON.parse(readFileSync(resolve(root,'aleph.config.json'),'utf8'));
const unavailable=(reason,expectedCommit=null)=>({status:'unverifiable',reason,expectedCommit});
const SHA=/^[a-f0-9]{40}$/u;
function publicOrigin(value){
  if(typeof value!=='string')return null;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.origin!==value||url.username||url.password
      ||url.port||url.pathname!=='/'||url.search||url.hash
      ||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/iu.test(url.hostname))return null;
    return url.origin;
  }catch{return null;}
}
async function readLimitedJson(response,lifetime,check){
  const reader=response?.body?.getReader ? lifetime.reader(response.body.getReader()) : null;
  if(!reader)throw Error('RESPONSE_UNREADABLE');
  let size=0;const chunks=[];
  try{
    while(true){
      check();const part=await reader.read();check();
      if(part.done)break;
      size+=part.value.byteLength;
      if(size>8192)throw Error('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(part.value));
    }
  }finally{lifetime.close();}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
export async function checkLiveIdentity({
  config=checkedConfig,expectedCommit,fetchImpl=globalThis.fetch,timeoutMs=8000
}={}){
  const origin=publicOrigin(config?.publicAppUrl);
  if(!origin || config.step!==12 || !SHA.test(expectedCommit??'')){
    return unavailable('LOCAL_IDENTITY_INVALID',expectedCommit??null);
  }
  if(typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>15000){
    return unavailable('CHECK_CONFIGURATION_INVALID',expectedCommit);
  }
  const controller=new AbortController(),lifetime=createResponseLifetime(controller.signal);
  const deadline=performance.now()+timeoutMs;
  let timer;
  const check=()=>{if(controller.signal.aborted||performance.now()>=deadline)throw Error('CHECK_TIMEOUT');};
  const stopped=new Promise(resolveStop=>{timer=setTimeout(()=>{controller.abort();resolveStop(unavailable('PUBLIC_MANIFEST_UNAVAILABLE',expectedCommit));},timeoutMs);});
  const work=async()=>{
    try {
      const response=lifetime.response(await fetchImpl(origin+'/aleph.json',{
        method:'GET',redirect:'error',cache:'no-store',credentials:'omit',
        headers:{Accept:'application/json'},signal:controller.signal
      }));
      check();
      const type=response.headers.get('content-type')??'';
      const cache=response.headers.get('cache-control')??'';
      const length=response.headers.get('content-length');
      if(response.status!==200||response.redirected||!/^application\/json(?:;|$)/iu.test(type)
        ||!/\bno-store\b/iu.test(cache)||length!==null&&(!/^\d+$/u.test(length)||Number(length)>8192)){
        return unavailable('PUBLIC_MANIFEST_UNAVAILABLE',expectedCommit);
      }
      const body=await readLimitedJson(response,lifetime,check);check();
      const result=compareDeploymentIdentity(body,config,expectedCommit);check();
      const deployedCommit=typeof body?.commit==='string'&&SHA.test(body.commit)?body.commit:null;
      return {status:result.outcome==='verified'?'verified':result.reason==='COMMIT_MISMATCH'?'stale':
        result.outcome==='inconclusive'?'unverifiable':'mismatch',reason:result.reason,expectedCommit,deployedCommit,
        repoUrl:config.repoUrl,publicAppUrl:origin};
    } catch {return unavailable('PUBLIC_MANIFEST_UNAVAILABLE',expectedCommit);}
    finally {lifetime.close();}
  };
  try {const result=await Promise.race([work(),stopped]);return controller.signal.aborted||performance.now()>=deadline?unavailable('PUBLIC_MANIFEST_UNAVAILABLE',expectedCommit):result;}
  finally {clearTimeout(timer);controller.abort();lifetime.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let commit;
  try{commit=readCurrentCommit(root);}catch{
    console.log(JSON.stringify(unavailable('LOCAL_HEAD_UNAVAILABLE')));
    process.exitCode=1;
  }
  if(commit){
    const result=await checkLiveIdentity({expectedCommit:commit});
    console.log(JSON.stringify(result));
    if(result.status!=='verified')process.exitCode=1;
  }
}
