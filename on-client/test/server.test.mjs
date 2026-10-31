import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import {test} from 'node:test';
import {createOnServer} from '../src/server.mjs';
import {demoEngine} from '../src/engine.mjs';

async function serve(options,check){
  const server=createOnServer(options);
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;
    await check('http://127.0.0.1:'+port,port);
  }finally{
    await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections?.();});
  }
}
async function request(base,path,init){
  const r=await fetch(base+path,init);return {status:r.status,headers:r.headers,body:await r.json()};
}
test('no configured SDP engine never claims a healthy identity',async()=>{
  await serve({},async base=>{
    const r=await request(base,'/api/me');
    assert.equal(r.status,503);assert.equal(r.body.error.code,'ENGINE_NOT_CONNECTED');
    assert.equal(r.body.meta.mode,'disconnected');
    assert.match(r.headers.get('cache-control'),/no-store/);
  });
});
test('diagnostics use the installed package version; demo is labelled',async()=>{
  const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  await serve({engine:demoEngine()},async base=>{
    const d=await request(base,'/api/diagnostics');
    assert.equal(d.status,200);assert.equal(d.body.data.version,version);
    assert.equal(d.body.data.engine.mode,'demo');
    const me=await request(base,'/api/me');
    assert.equal(me.status,200);assert.equal(me.body.meta.mode,'demo');
    const html=await fetch(base);
    assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.equal(html.headers.get('x-content-type-options'),'nosniff');
    await html.arrayBuffer();
  });
});
test('local host and Origin validations reject rebinding and cross-origin POST',async()=>{
  await serve({engine:demoEngine()},async(base,port)=>{
    const blocked=await new Promise((resolve,reject)=>{
      const req=http.get({host:'127.0.0.1',port,path:'/',headers:{Host:'unexpected.example:'+port}},r=>{
        let body='';r.setEncoding('utf8');r.on('data',part=>body+=part);
        r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(body)}));
      });req.on('error',reject);
    });
    assert.equal(blocked.status,403);assert.equal(blocked.body.error.code,'HOST_REJECTED');
    const cross=await request(base,'/api/access',{
      method:'POST',headers:{'content-type':'application/json',Origin:'https://example.org'},body:'{}'
    });
    assert.equal(cross.status,403);assert.equal(cross.body.error.code,'ORIGIN_REJECTED');
  });
});
test('AI permission denial is terminal while rate limits are retryable',async()=>{
  let code='WB_CLCO_ACCESS_BLOCKED';
  const identity={user:{id:'user-1',label:'Learner'},device:{id:'device-1',label:'PC',status:'compliant'},session:{id:'session-1',status:'active'}};
  const engine={evidenceMode:'connected',projectId:'project-1',readIdentity:async()=>structuredClone(identity)};
  const resolveAiIdentity=async({sourceSubjectId,projectId,sessionId})=>({
    schema:'aleph.on.ai-identity.v1',sourceSubjectId,canonicalStudentId:sourceSubjectId,
    alephUserId:'user-1',siteId:'site-1',identityVersion:1,projectId,sessionId
  });
  const ai={checkConnection:async()=>({ok:false,error:{code}})};
  await serve({engine,resolveAiIdentity,ai},async base=>{
    for(const [expected,retryable] of [['WB_CLCO_ACCESS_BLOCKED',false],['WB_CLCO_RATE_LIMITED',true]]){
      code=expected;
      const r=await request(base,'/api/ai/check',{
        method:'POST',headers:{'content-type':'application/json',Origin:base},body:'{}'
      });
      assert.equal(r.status,503);assert.equal(r.body.error.code,expected);
      assert.equal(r.body.error.retryable,retryable);
    }
  });
});
test('automatic favicon request serves the app icon instead of a 404',async()=>{
  const icon=await readFile(new URL('../public/assets/alekov/alekov-app-icon.webp',import.meta.url));
  await serve({engine:demoEngine()},async base=>{
    for(const path of ['/','/dashboard.html']){
      const page=await fetch(base+path);
      const html=await page.text();
      assert.equal(page.status,200);
      assert.match(html,/rel="icon" href="\/assets\/alekov\/alekov-app-icon\.webp" type="image\/webp"/);
    }
    const favicon=await fetch(base+'/favicon.ico');
    const bytes=Buffer.from(await favicon.arrayBuffer());
    assert.equal(favicon.status,200);
    assert.equal(favicon.headers.get('content-type'),'image/webp');
    assert.equal(favicon.headers.get('x-content-type-options'),'nosniff');
    assert.deepEqual(bytes,icon);
  });
});
