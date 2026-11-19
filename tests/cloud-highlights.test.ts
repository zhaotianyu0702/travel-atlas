import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';
test('background highlight batches persist only valid selections and do not launch a duplicate on reuse', async()=>{
  const entry=`
import {highlightsRoute} from ${JSON.stringify(resolve('lib/cloud-highlights.ts'))};
import {mutateStore,readStore,storage} from ${JSON.stringify(resolve('lib/cloud-store.ts'))};
let spent=0;
globalThis.fetch=async (url,init)=>{
  if(!String(url).endsWith('/v1/responses'))throw Error('Unexpected network call');
  spent++;
  const b=JSON.parse(init.body), content=b.input[0].content;
  const list=content[0].text.split('Photo IDs: ')[1];
  const ids=JSON.parse(list.slice(0,list.lastIndexOf(']')+1));
  if(content.length>9)throw Error('Too many previews');
  return Response.json({id:'test-'+spent,status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({selectedPhotoIds:[ids[0]]})}]}]} );
};
export default {async fetch(req){
 const route=new URL(req.url).pathname;
 if(route==='/seed'){
  const ids=Array.from({length:10},(_,i)=>'p'+i);
  await Promise.all(ids.map(id=>storage().put(id,new Uint8Array([255,216,255,217]))));
  await mutateStore(s=>{s.trips.push({id:'t',accountId:'local'});s.photos.push(...ids.map(id=>({id,tripId:'t',accountId:'local',sha256:id,capturedAt:null,thumbnailPath:id})));});
  return Response.json({ok:true});
 }
 if(route==='/observe'){const s=await readStore();return Response.json({spent,ids:s.trips[0].highlightPhotoIds});}
 return await highlightsRoute(req,['ai','highlights']);
}};`;
  const built=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
  const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{OPENAI_API_KEY:'test-only',ATLAS_MODEL:'existing-model'}});
  try {
    await (await mf.getD1Database('DB')).exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);');
    assert.equal((await mf.dispatchFetch('http://local/seed')).status,200);
    const start=()=>mf.dispatchFetch('http://local/api/ai/highlights',{method:'POST',headers:{'content-type':'application/json'},body:'{"tripId":"t"}'});
    assert.equal((await start()).status,202);
    let observed:{spent:number;ids?:string[]}={spent:0};
    for(let i=0;i<30&&!observed.ids;i++){
      observed=await (await mf.dispatchFetch('http://local/observe')).json() as typeof observed;
      if(!observed.ids)await new Promise(r=>setTimeout(r,15));
    }
    assert.deepEqual(observed,{spent:2,ids:['p0','p8']});
    assert.equal((await start()).status,202);
    assert.deepEqual(await (await mf.dispatchFetch('http://local/observe')).json(),observed);
  } finally {await mf.dispose();}
});

test('concurrent trips and a changed trip scope remain queued and complete under a bounded provider load', async()=>{
  const entry=`
import {highlightsRoute} from ${JSON.stringify(resolve('lib/cloud-highlights.ts'))};
import {mutateStore,readStore,storage} from ${JSON.stringify(resolve('lib/cloud-store.ts'))};
let spent=0, release=false, active=0, peak=0; const pending=new Map();
globalThis.fetch=async (url,init)=>{
 if(init?.method==='POST'){
  const content=JSON.parse(init.body).input[0].content, text=content[0].text;
  const list=text.split('Photo IDs: ')[1]; const ids=JSON.parse(list.slice(0,list.lastIndexOf(']')+1)); const id='r'+(++spent);
  pending.set(id,ids); active++;peak=Math.max(peak,active);
  return Response.json({id,status:'in_progress'});
 }
 const id=String(url).split('/').pop(), ids=pending.get(id);
 if(!release)return Response.json({id,status:'in_progress'});
 if(ids){pending.delete(id);active--;}
 return Response.json({id,status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({selectedPhotoIds:[ids[0]]})}]}]});
};
export default {async fetch(req){
 const path=new URL(req.url).pathname;
 if(path==='/seed'){
  const ids=Array.from({length:27},(_,i)=>'p'+i);
  await Promise.all(ids.map(id=>storage().put(id,new Uint8Array([255,216,255,217]))));
  await mutateStore(s=>{s.trips.push({id:'a',accountId:'local'},{id:'b',accountId:'local'});s.photos.push(...ids.slice(0,26).map((id,i)=>({id,tripId:i<25?'a':'b',accountId:'local',sha256:id,capturedAt:null,thumbnailPath:id})));});
  return Response.json({});
 }
 if(path==='/add'){await mutateStore(s=>s.photos.push({id:'p26',tripId:'b',accountId:'local',sha256:'p26',capturedAt:null,thumbnailPath:'p26'}));return Response.json({});}
 if(path==='/release'){release=true;return Response.json({});}
 if(path==='/expire'){await mutateStore(s=>{const j=s.highlightJobs.find(j=>j.tripId==='b'&&!j.superseded);j.status='running';j.analyzedCount=0;j.batches[0].status='running';j.batches[0].claimedAt=Date.now()-100000;delete j.batches[0].responseId;});return Response.json({});}
 if(path==='/observe'){const s=await readStore();return Response.json({spent,peak,jobs:s.highlightJobs,trips:s.trips});}
 return highlightsRoute(req,['ai','highlights']);
}};`;
  const built=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
  const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{OPENAI_API_KEY:'test-only',ATLAS_MODEL:'existing-model'}});
  try {
    await (await mf.getD1Database('DB')).exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);');
    await mf.dispatchFetch('http://local/seed');
    const start=(tripId:string)=>mf.dispatchFetch('http://local/api/ai/highlights',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tripId})});
    const [a,b]=await Promise.all([start('a'),start('b')]);
    assert.equal(a.status,202);assert.equal(b.status,202);
    await mf.dispatchFetch('http://local/add');
    const replacement=await (await start('b')).json() as {job:{totalCount:number}};
    assert.equal(replacement.job.totalCount,2);
    await mf.dispatchFetch('http://local/release');
    let observed:any;
    for(let i=0;i<100;i++){
      await mf.dispatchFetch('http://local/api/ai/highlights');
      observed=await (await mf.dispatchFetch('http://local/observe')).json();
      const current=observed.jobs.filter((j:any)=>!j.superseded);
      if(current.length===2&&current.every((j:any)=>j.status==='succeeded'))break;
      await new Promise(r=>setTimeout(r,20));
    }
    const current=observed.jobs.filter((j:any)=>!j.superseded);
    assert.equal(current.length,2);
    assert.ok(current.every((j:any)=>j.status==='succeeded'),JSON.stringify(observed));
    assert.equal(current.find((j:any)=>j.tripId==='b').analyzedCount,2);
    assert.ok(observed.peak<=3,`peak provider requests: ${observed.peak}`);
    assert.equal(observed.trips.find((t:any)=>t.id==='b').highlightAnalyzedCount,2);
    await mf.dispatchFetch('http://local/expire');
    for(let i=0;i<50;i++){
      await mf.dispatchFetch('http://local/api/ai/highlights');
      observed=await (await mf.dispatchFetch('http://local/observe')).json();
      if(observed.jobs.find((j:any)=>j.tripId==='b'&&!j.superseded).status==='succeeded')break;
      await new Promise(r=>setTimeout(r,20));
    }
    assert.equal(observed.jobs.find((j:any)=>j.tripId==='b'&&!j.superseded).status,'succeeded');
  } finally {await mf.dispose();}
});
