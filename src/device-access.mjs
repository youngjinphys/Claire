import { createHash } from 'node:crypto';

const GRANT=/^[A-Za-z0-9_-]{40,100}$/u;
const ID=/^[A-Za-z0-9_-]{10,1024}$/u;
export const DEVICE_PROOF_HEADER='x-aleph-device-proof';
export const authDigest=value=>createHash('sha256').update(value).digest('hex');

// This guard runs on EVERY protected API request, never in the browser alone.
// A signed official judge JWT is a separate, pre-existing testing principal.
export async function verifyDeviceGrant({
  db, identity, authorization, headers={}, now=new Date().toISOString()
}){
  if(!identity)return false;
  if(identity.kind==='judge')return true;
  if(identity.kind!=='student'||typeof identity.userId!=='string')return false;
  const proof=headers[DEVICE_PROOF_HEADER];
  if(typeof proof!=='string'||!GRANT.test(proof)||typeof authorization!=='string')
    return false;
  try{
    const {data:grant,error}=await db.from('s11_device_challenges')
      .select('user_id,request_path,expires_at')
      .eq('kind','access').eq('user_id',identity.userId)
      .eq('request_method','GRANT')
      .eq('body_digest',authDigest(authorization))
      .eq('challenge',proof).gt('expires_at',now).maybeSingle();
    if(error||grant?.user_id!==identity.userId
      ||typeof grant.request_path!=='string'
      ||!grant.request_path.startsWith('/credential/'))return false;
    const credentialId=grant.request_path.slice('/credential/'.length);
    if(!ID.test(credentialId))return false;
    const {data:cred,error:credError}=await db.from('s11_device_credentials')
      .select('user_id,status')
      .eq('credential_id',credentialId).eq('user_id',identity.userId)
      .maybeSingle();
    return !credError&&cred?.status==='approved'&&cred.user_id===identity.userId;
  }catch{return false;}
}
