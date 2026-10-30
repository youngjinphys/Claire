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
async function readLimitedJson(response){
  const reader=response?.body?.getReader?.();
  if(!reader)throw Error('RESPONSE_UNREADABLE');
  let size=0;const chunks=[];
  try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      size+=part.value.byteLength;
      if(size>8192)throw Error('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(part.value));
    }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
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
  let response;
  try{
    response=await fetchImpl(origin+'/aleph.json',{
      method:'GET',redirect:'error',cache:'no-store',credentials:'omit',
      headers:{Accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)
    });
    const type=response.headers.get('content-type')??'';
    const cache=response.headers.get('cache-control')??'';
    if(response.status!==200||!/^application\/json(?:;|$)/iu.test(type)
      ||!/\bno-store\b/iu.test(cache)){
      return unavailable('PUBLIC_MANIFEST_UNAVAILABLE',expectedCommit);
    }
    const body=await readLimitedJson(response);
    const result=compareDeploymentIdentity(body,config,expectedCommit);
    const deployedCommit=typeof body?.commit==='string'&&SHA.test(body.commit)
      ?body.commit:null;
    return {status:result.outcome==='verified'?'verified':
      result.reason==='COMMIT_MISMATCH'?'stale':
      result.outcome==='inconclusive'?'unverifiable':'mismatch',
      reason:result.reason,expectedCommit,deployedCommit,
      repoUrl:config.repoUrl,publicAppUrl:origin};
  }catch{return unavailable('PUBLIC_MANIFEST_UNAVAILABLE',expectedCommit);}
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
