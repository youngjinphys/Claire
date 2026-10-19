import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import config from '../aleph.config.json' with { type: 'json' };
import { createLoginVerifier } from '../src/verify-login.mjs';
import { authDigest, verifyDeviceGrant } from '../src/device-access.mjs';

const origin=config.publicAppUrl;
const rpID=new URL(origin).hostname;
const ID=/^[A-Za-z0-9_-]{10,1024}$/u;
const CH=/^[A-Za-z0-9_-]{20,256}$/u;
const CHALLENGE_MS=3*60*1000;
const GRANT_MS=15*60*1000;
const date=ms=>new Date(ms).toISOString();
const transports=x=>Array.isArray(x)&&x.length<=8&&x.every(v=>typeof v==='string'&&/^[a-z]{2,24}$/u.test(v))?x:[];
const handle=id=>new Uint8Array(createHash('sha256').update('s11:'+id).digest());
const noStore=res=>{
  for(const k of ['Cache-Control','CDN-Cache-Control','Vercel-CDN-Cache-Control'])res.setHeader(k,'no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
};
const parseBody=req=>{
  const raw=typeof req.body==='string'?req.body:JSON.stringify(req.body??null);
  if(typeof raw!=='string'||Buffer.byteLength(raw)>24000)return null;
  try{const data=JSON.parse(raw);return data&&!Array.isArray(data)&&typeof data==='object'?data:null;}catch{return null;}
};
function browserChallenge(c,kind){
  if(!c||c.type!=='public-key'||!ID.test(c.id||'')
    ||typeof c.response?.clientDataJSON!=='string'
    ||c.response.clientDataJSON.length>8000)return null;
  try{
    const bytes=Buffer.from(c.response.clientDataJSON,'base64url');
    if(bytes.length>5000)return null;
    const d=JSON.parse(bytes.toString('utf8'));
    return d.type===kind&&typeof d.challenge==='string'&&CH.test(d.challenge)?d.challenge:null;
  }catch{return null;}
}
export function createDeviceHandler({
  env=process.env, supabaseFactory=createClient, verifierFactory=createLoginVerifier,
  webauthn={generateRegistrationOptions,verifyRegistrationResponse,
    generateAuthenticationOptions,verifyAuthenticationResponse},
  clock=Date.now,
}={}){
  let instance;
  function runtime(){
    if(instance)return instance;
    if(!env.SUPABASE_URL||!env.SUPABASE_SECRET_KEY)return null;
    const db=supabaseFactory(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY,{
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}
    });
    instance={db,verify:verifierFactory({config,supabaseClient:db})};
    return instance;
  }
  const now=()=>{const d=clock();return typeof d==='number'?d:Date.parse(d);};
  const credentials=async(db,userId)=>{
    const {data,error}=await db.from('s11_device_credentials')
      .select('credential_id,user_id,public_key,sign_count,transports,device_type,backed_up,status')
      .eq('user_id',userId);
    if(error)throw Error('DEVICE_STORE_UNAVAILABLE');
    return data??[];
  };
  const save=async(db,uid,kind,challenge,authHash)=>{
    const {error}=await db.from('s11_device_challenges').insert({
      id:randomUUID(), user_id:uid, kind, challenge,
      expires_at:date(now()+CHALLENGE_MS),
      ...(kind==='access'?{request_method:'ASSERT',request_path:'/api/device',
        body_digest:authHash}:{})
    });
    if(error)throw Error('DEVICE_STORE_UNAVAILABLE');
  };
  const consume=async(db,uid,kind,challenge,authHash)=>{
    let q=db.from('s11_device_challenges').delete()
      .eq('user_id',uid).eq('kind',kind).eq('challenge',challenge)
      .gt('expires_at',date(now()));
    if(kind==='access')q=q.eq('request_method','ASSERT').eq('request_path','/api/device')
      .eq('body_digest',authHash);
    const {data,error}=await q.select('id').maybeSingle();
    if(error)throw Error('DEVICE_STORE_UNAVAILABLE');
    if(!data)throw Error('DEVICE_CHALLENGE_EXPIRED');
  };
  return async function handler(req,res){
    noStore(res);
    const action=typeof req.query?.action==='string'?req.query.action:null;
    if(!['status','registration-options','registration-verify',
      'assertion-options','assertion-verify'].includes(action))
      return res.status(404).json({error:'DEVICE_ROUTE_NOT_FOUND'});
    const required=action==='status'?'GET':'POST';
    if(req.method!==required){res.setHeader('Allow',required);return res.status(405).json({error:'METHOD_NOT_ALLOWED'});}
    if(required==='POST'&&typeof req.headers?.origin==='string'
      &&req.headers.origin!==origin)
      return res.status(403).json({error:'ORIGIN_DENIED'});
    const ctx=runtime();
    if(!ctx)return res.status(503).json({error:'DEVICE_BACKEND_UNAVAILABLE'});
    const auth=req.headers?.authorization,identity=await ctx.verify(auth);
    if(!identity||identity.kind!=='student'){
      res.setHeader('WWW-Authenticate','Bearer');
      return res.status(401).json({error:'UNAUTHORIZED'});
    }
    const {db}=ctx,uid=identity.userId,bind=authDigest(auth);
    try{
      if(action==='status'){
        const rows=await credentials(db,uid);
        const hasApproved=rows.some(r=>r.status==='approved');
        const pending=rows.some(r=>r.status==='pending');
        const verified=await verifyDeviceGrant({
          db,identity,authorization:auth,headers:req.headers,now:date(now())
        });
        return res.status(200).json({
          schema:'aleph.device.status.v1',
          registration:hasApproved?'approved':pending?'pending':'not_registered',
          verified,canOpenVault:verified,installIsApproval:false
        });
      }
      if(action==='registration-options'){
        const rows=await credentials(db,uid);
        const opts=await webauthn.generateRegistrationOptions({
          rpName:'BYTE BACK',rpID,userName:'learner-'+
            createHash('sha256').update(uid).digest('hex').slice(0,12),
          userDisplayName:'BYTE BACK learner',userID:handle(uid),
          attestationType:'none',supportedAlgorithmIDs:[-7,-257],
          authenticatorSelection:{residentKey:'preferred',userVerification:'required'},
          excludeCredentials:rows.filter(r=>r.status!=='revoked')
            .map(r=>({id:r.credential_id,transports:transports(r.transports)}))
        });
        if(!CH.test(opts.challenge))throw Error('INVALID_OPTIONS');
        await save(db,uid,'registration',opts.challenge,bind);
        return res.status(200).json(opts);
      }
      if(action==='assertion-options'){
        const rows=(await credentials(db,uid)).filter(r=>r.status==='approved'
          &&r.device_type==='singleDevice'&&r.backed_up===false);
        if(!rows.length)return res.status(403).json({error:'DEVICE_NOT_APPROVED'});
        const opts=await webauthn.generateAuthenticationOptions({
          rpID,userVerification:'required',
          allowCredentials:rows.slice(0,40).map(r=>({
            id:r.credential_id,transports:transports(r.transports)
          }))
        });
        if(!CH.test(opts.challenge))throw Error('INVALID_OPTIONS');
        await save(db,uid,'access',opts.challenge,bind);
        return res.status(200).json(opts);
      }
      const body=parseBody(req);
      if(!body||Object.keys(body).length!==1||!body.credential)
        return res.status(400).json({error:'INVALID_DEVICE_REQUEST'});
      const credential=body.credential,isRegistration=action==='registration-verify';
      const challenge=browserChallenge(credential,isRegistration?'webauthn.create':'webauthn.get');
      if(!challenge)return res.status(400).json({error:'INVALID_DEVICE_REQUEST'});
      await consume(db,uid,isRegistration?'registration':'access',challenge,bind);
      if(isRegistration){
        let result;
        try{
          result=await webauthn.verifyRegistrationResponse({
            response:credential,expectedChallenge:challenge,
            expectedOrigin:origin,expectedRPID:rpID,
            requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]
          });
        }catch{return res.status(403).json({error:'DEVICE_NOT_VERIFIED'});}
        const info=result?.registrationInfo;
        if(!result?.verified||info?.userVerified!==true
          ||info.credentialDeviceType!=='singleDevice'||info.credentialBackedUp!==false
          ||info.credential?.id!==credential.id||!ID.test(credential.id))
          return res.status(403).json({error:'DEVICE_NOT_VERIFIED'});
        const pk=Buffer.from(info.credential.publicKey).toString('base64url');
        if(pk.length<20||pk.length>4096||!Number.isSafeInteger(info.credential.counter)
          ||info.credential.counter<0)return res.status(403).json({error:'DEVICE_NOT_VERIFIED'});
        const {error}=await db.from('s11_device_credentials').insert({
          credential_id:credential.id,user_id:uid,public_key:pk,
          sign_count:info.credential.counter,transports:transports(info.credential.transports),
          device_type:'singleDevice',backed_up:false,status:'approved',approved_at:date(now())
        });
        if(error)return res.status(error.code==='23505'?409:503)
          .json({error:error.code==='23505'?'CREDENTIAL_ALREADY_REGISTERED':'DEVICE_STORE_UNAVAILABLE'});
        return res.status(200).json({schema:'aleph.device.registration.v1',
          registration:'approved',verifiedDeviceProof:false,next:'assertion_required'});
      }
      const {data:row,error}=await db.from('s11_device_credentials')
        .select('credential_id,user_id,public_key,sign_count,transports,device_type,backed_up,status')
        .eq('user_id',uid).eq('credential_id',credential.id).maybeSingle();
      if(error)throw Error('DEVICE_STORE_UNAVAILABLE');
      if(row?.status!=='approved'||row.user_id!==uid
        ||row.device_type!=='singleDevice'||row.backed_up!==false)
        return res.status(403).json({error:'DEVICE_NOT_VERIFIED'});
      let result;
      try{
        result=await webauthn.verifyAuthenticationResponse({
          response:credential,expectedChallenge:challenge,
          expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true,
          credential:{id:row.credential_id,publicKey:Buffer.from(row.public_key,'base64url'),
            counter:Number(row.sign_count),transports:transports(row.transports)}
        });
      }catch{return res.status(403).json({error:'DEVICE_NOT_VERIFIED'});}
      const counter=result?.authenticationInfo?.newCounter;
      if(!result?.verified||result.authenticationInfo.credentialDeviceType!=='singleDevice'
        ||result.authenticationInfo.credentialBackedUp!==false
        ||!Number.isSafeInteger(counter)||counter<Number(row.sign_count))
        return res.status(403).json({error:'DEVICE_NOT_VERIFIED'});
      const update=await db.from('s11_device_credentials')
        .update({sign_count:counter,last_used_at:date(now())})
        .eq('user_id',uid).eq('credential_id',credential.id)
        .eq('status','approved').eq('sign_count',row.sign_count)
        .select('credential_id').maybeSingle();
      if(update.error)throw Error('DEVICE_STORE_UNAVAILABLE');
      if(!update.data)return res.status(409).json({error:'DEVICE_STATE_CHANGED'});
      const proof=randomBytes(32).toString('base64url');
      const saved=await db.from('s11_device_challenges').insert({
        id:randomUUID(),user_id:uid,kind:'access',challenge:proof,
        request_method:'GRANT',request_path:'/credential/'+credential.id,
        body_digest:bind,expires_at:date(now()+GRANT_MS)
      });
      if(saved.error)throw Error('DEVICE_STORE_UNAVAILABLE');
      return res.status(200).json({schema:'aleph.device.proof.v1',
        approved:true,proof,expiresInSeconds:GRANT_MS/1000});
    }catch(error){
      if(error?.message==='DEVICE_CHALLENGE_EXPIRED')
        return res.status(409).json({error:'DEVICE_CHALLENGE_EXPIRED'});
      return res.status(503).json({error:'DEVICE_STORE_UNAVAILABLE'});
    }
  };
}
export default createDeviceHandler();
