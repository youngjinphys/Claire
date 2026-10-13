import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNotesHandler } from '../api/notes.js';
import { createAnnouncementsHandler } from '../api/announcements.js';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const I='33333333-3333-4333-8333-333333333333';
const NA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NI='cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function mockDatabase() {
  const tables={
    learning_notes:[
      {id:NA,owner_id:A,title:'A training note',content:'A demo',created_at:'2026-01-01'},
      {id:NB,owner_id:B,title:'B training note',content:'B demo',created_at:'2026-01-02'},
    ],
    learning_announcements:[
      {id:NA,owner_id:A,title:'A announcement',content:'A news'},
      {id:NI,owner_id:I,title:'Instructor announcement',content:'Class announcement'},
    ],
  };
  const calls=[];
  const db={
    tables,calls,
    auth:{admin:{getUserById:async id=>({data:{user:{id,app_metadata:
      id===I?{role:'instructor'}:{role:'student'}}},error:null})}},
    from(name) {
      if(!Object.hasOwn(tables,name))throw Error('Unknown table');
      const filters=[],record={table:name,filters,op:'select'};
      calls.push(record);
      const builder={
        select(){return this;},
        eq(key,val){filters.push([key,val]);return this;},
        order(){return this;},
        update(value){record.op='update';record.updateValue=value;return this;},
        delete(){record.op='delete';return this;},
        insert(value){record.op='insert';record.updateValue=value;return this;},
        maybeSingle(){return Promise.resolve(this.execute(true));},
        then(resolve,reject){return Promise.resolve(this.execute(false)).then(resolve,reject);},
        execute(single){
          let matches=tables[name].filter(row=>filters.every(([key,value])=>row[key]===value));
          if(record.op==='insert'){
            if(tables[name].some(x=>x.id===record.updateValue.id))
              return {data:null,error:{code:'23505'}};
            tables[name].push({...record.updateValue});
            matches=[record.updateValue];
          } else if(record.op==='update'){
            for(const item of matches)Object.assign(item,record.updateValue);
          }else if(record.op==='delete'){
            tables[name]=tables[name].filter(x=>!matches.includes(x));
          }
          return {data:single?(matches[0]??null):matches,error:null};
        },
      };
      return builder;
    },
  };
  return db;
}
function serverResponse() {
  return {headers:{},code:200,payload:null,
    setHeader(k,v){this.headers[k]=v;return this;},
    status(code){this.code=code;return this;},
    json(payload){this.payload=payload;return this;}
  };
}
const users={
  'Bearer A':{kind:'student',userId:A},
  'Bearer B':{kind:'student',userId:B},
  'Bearer I':{kind:'student',userId:I},
  'Bearer J':{kind:'judge',userId:A}
};
function configured(handlerFactory,db) {
  return handlerFactory({
    env:{SUPABASE_URL:'https://fake.supabase.invalid',SUPABASE_SECRET_KEY:'test-server-key'},
    supabaseFactory:()=>db,
    verifierFactory:()=>async header=>users[header]??null,
  });
}
async function call(handler,token,method,id,body) {
  const response=serverResponse();
  const request={method,headers:{authorization:token},query:id==null?{}:{id},body};
  await handler(request,response);
  return response;
}
test('memo: server SQL scopes GET and list by verified DB owner; cross-owner always 404',async()=>{
  const db=mockDatabase(),handle=configured(createNotesHandler,db);
  assert.equal((await call(handle,undefined,'GET',NA)).code,401);
  const own=await call(handle,'Bearer A','GET',NA);
  assert.equal(own.code,200);
  assert.equal(own.payload.body,'A demo');
  assert.equal(own.headers['X-Resource-Id'],'memo:'+NA);
  assert.equal((await call(handle,'Bearer A','GET',NB)).code,404);
  assert.equal((await call(handle,'Bearer B','GET',NA)).code,404);
  const list=await call(handle,'Bearer A','GET',null);
  assert.equal(list.code,200);
  assert.deepEqual(list.payload.map(x=>x.id),[NA]);
  const reads=db.calls.filter(x=>x.table==='learning_notes' && x.filters.some(([k])=>k==='id'));
  assert.ok(reads.every(x=>x.filters.some(([k])=>k==='owner_id')),
    'No cross-owner row may even be fetched into service-role memory');
});
test('memo: POST owner is verified user, role/owner injection fails, foreign PUT/DELETE denied',async()=>{
  const db=mockDatabase(),handle=configured(createNotesHandler,db);
  const forged={title:'changed',body:'new',owner_id:B,role:'instructor'};
  assert.equal((await call(handle,'Bearer A','PUT',NB,forged)).code,400);
  assert.equal((await call(handle,'Bearer A','PUT',NB,{title:'changed',body:'new'})).code,404);
  assert.equal((await call(handle,'Bearer B','DELETE',NA)).code,404);
  assert.equal(db.tables.learning_notes.find(x=>x.id===NA).content,'A demo');
  assert.equal((await call(handle,'Bearer A','POST',null,{title:'fake',body:'value',owner_id:B})).code,400);
  const added=await call(handle,'Bearer A','POST',null,{title:'own',body:'only'});
  assert.equal(added.code,201);
  assert.equal(db.tables.learning_notes.find(x=>x.id===added.payload.id).owner_id,A);
  assert.equal((await call(handle,'Bearer A','GET',[NA,NB])).code,400);
  assert.equal((await call(handle,'Bearer A','PUT',NA,{title:'updated',body:'new'})).code,200);
  assert.equal(db.tables.learning_notes.find(x=>x.id===NA).owner_id,A);
});
test('announcements: student forged role and judge tokens never authorize PUT',async()=>{
  const db=mockDatabase(),handle=configured(createAnnouncementsHandler,db);
  assert.equal((await call(handle,undefined,'GET',NI)).code,401);
  const studentRead=await call(handle,'Bearer A','GET',NI);
  assert.equal(studentRead.code,200);
  assert.equal(studentRead.payload.title,'Instructor announcement');
  const forged=await call(handle,'Bearer A','PUT',NA,{
    title:'fake teacher',body:'not allowed',role:'instructor'
  });
  assert.equal(forged.code,403);
  assert.equal((await call(handle,'Bearer A','PUT',NA,{
    title:'bad',body:'not allowed'
  })).code,403);
  assert.equal((await call(handle,'Bearer J','PUT',NA,{
    title:'forged judge',body:'blocked'
  })).code,403);
  assert.equal(db.tables.learning_announcements.find(x=>x.id===NA).title,'A announcement');
  assert.ok(!db.calls.some(c=>c.table==='learning_announcements'&&c.op==='update'));
});
test('announcements: real server-verified instructor can edit own notice, not another owner',async()=>{
  const db=mockDatabase(),handle=configured(createAnnouncementsHandler,db);
  const body={title:'Updated announcement',body:'Official notice'};
  const allowed=await call(handle,'Bearer I','PUT',NI,body);
  assert.equal(allowed.code,200);
  assert.equal(db.tables.learning_announcements.find(x=>x.id===NI).title,body.title);
  const other=await call(handle,'Bearer I','PUT',NA,body);
  assert.equal(other.code,404);
  assert.equal(db.tables.learning_announcements.find(x=>x.id===NA).title,'A announcement');
  const updateCalls=db.calls.filter(c=>c.table==='learning_announcements'&&c.op==='update');
  assert.equal(updateCalls.length,1);
  assert.ok(updateCalls[0].filters.some(([k,v])=>k==='owner_id'&&v===I));
});
