import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {resolve} from 'node:path';

test('append reuses whole successful batches; edits invalidate and failures retry', async()=>{
 const entry=`
import {highlightsRoute,planHighlightBatches} from ${JSON.stringify(resolve('lib/cloud-highlights.ts'))};
import {mutateStore,readStore,storage} from ${JSON.stringify(resolve('lib/cloud-store.ts'))};
let spent=0, failNext=false;
globalThis.fetch=async (_url,init)=>{
 spent++; const text=JSON.parse(init.body).input[0].content[0].text;
 const tail=text.split('Photo IDs: ')[1], ids=JSON.parse(tail.slice(0,tail.lastIndexOf(']')+1));
 if(failNext){failNext=false;return new Response('',{status:500});}
 return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({selectedPhotoIds:[ids[0]]})}]}]});
};
const photo=i=>({id:String(i).padStart(4,'0'),tripId:'t',accountId:'local',sha256:'hash'+i,capturedAt:null,thumbnailPath:'thumb',latitude:null,longitude:null,placeName:'',country:'',metadata:{},createdAt:new Date(1700000000000+i*1000).toISOString()});
export default {async fetch(req){
 const p=new URL(req.url).pathname;
 if(p==='/seed'){await storage().put('thumb',new Uint8Array([255,216,255,217])); await mutateStore(s=>{s.trips.push({id:'t',accountId:'local',title:'',startDate:null,endDate:null,notes:''});s.photos.push(...Array.from({length:300},(_,i)=>photo(i)));});return Response.json({});}
 if(p==='/append'){await mutateStore(s=>s.photos.push(...Array.from({length:30},(_,i)=>photo(i+300))));return Response.json({});}
 if(p==='/grow'){await mutateStore(s=>s.photos.push(...Array.from({length:2670},(_,i)=>photo(i+330))));return Response.json({});}
 if(p==='/ambiguous'){await mutateStore(s=>{const x=photo(3000);x.createdAt=s.photos[0].createdAt;s.photos.push(x);});return Response.json({});}
 if(p==='/delete'){await mutateStore(s=>{s.photos[10].deletedAt='2026-01-01';});return Response.json({});}
 if(p.startsWith('/edit/')){const field=p.split('/').pop();await mutateStore(s=>{const x=s.photos[0];if(field==='content')x.sha256+='x';if(field==='time')x.capturedAt='2024-01-01';if(field==='place')x.placeName+='x';});return Response.json({});}
 if(p==='/fail'){failNext=true;return Response.json({});}
 if(p==='/state'){const s=await readStore(); const j=s.highlightJobs.find(x=>!x.superseded);return Response.json({spent,job:j,ids:s.trips[0].highlightPhotoIds,modelPlan:planHighlightBatches(s.photos,j,'different-model',true,[]).map(x=>x.status)});}
 return highlightsRoute(req,['ai','highlights']);
}};`;
 const built=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
 const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{OPENAI_API_KEY:'test-only',ATLAS_MODEL:'test-model'}});
 try {
  await (await mf.getD1Database('DB')).exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);');
  const get=(p:string)=>mf.dispatchFetch('http://local'+p);
  const state=async():Promise<any>=>await (await get('/state')).json();
  const start=async()=>{assert.equal((await mf.dispatchFetch('http://local/api/ai/highlights',{method:'POST',headers:{'content-type':'application/json'},body:'{"tripId":"t"}'})).status,202);};
  const finished=async()=>{for(let i=0;i<100;i++){const x=await state();if(x.job?.status!=='running')return x;await new Promise(r=>setTimeout(r,15));}throw Error('job did not finish');};
  await get('/seed');await start();let x=await finished();const size300=JSON.stringify(x.job).length;assert.equal(x.job.sourcePhotos,undefined);assert.ok(!JSON.stringify(x.job).includes('hash100'));assert.equal(x.spent,4);assert.equal(x.job.analyzedCount,32);assert.deepEqual(x.modelPlan,['queued','queued','queued','queued']);
  await start();assert.equal((await state()).spent,4);
  const oldSelections=x.job.batches.map((b:any)=>b.selected[0]);
  await get('/append');await start();x=await finished();assert.equal(x.spent,5);assert.equal(x.job.totalCount,330);assert.equal(x.job.analyzedCount,32);assert.equal(x.job.batches.filter((b:any)=>b.selected&&oldSelections.includes(b.selected[0])).length,3);assert.ok(x.job.batches.at(-1).photoIds.every((id:string)=>Number(id)>=300));
  for(const field of ['time','place','content']){await get('/edit/'+field);const before=x.spent;await start();x=await finished();assert.equal(x.spent-before,4,field);}
  await get('/edit/content');await get('/fail');await start();x=await finished();assert.equal(x.job.failedBatches,1);const before=x.spent;await start();x=await finished();assert.equal(x.spent-before,1);assert.equal(x.job.failedBatches,0);assert.equal(x.job.analyzedCount,32);
  const status=await (await get('/api/ai/highlights')).json() as {jobs:{elapsedMs?:number}[]};assert.equal(typeof status.jobs[0].elapsedMs,'number');
  await get('/grow');await start();x=await finished();assert.equal(x.job.totalCount,3000);assert.equal(x.spent-before,2);assert.equal(x.job.sourcePhotos,undefined);assert.ok(JSON.stringify(x.job).length-size300<500,JSON.stringify({size300,size3000:JSON.stringify(x.job).length}));
  await get('/ambiguous');let spent=x.spent;await start();x=await finished();assert.equal(x.spent-spent,4);
  await get('/delete');spent=x.spent;await start();x=await finished();assert.equal(x.spent-spent,4);
 } finally {await mf.dispose();}
});

test('edits during model execution cannot publish stale highlights',async()=>{
 const entry=`
import {highlightsRoute} from ${JSON.stringify(resolve('lib/cloud-highlights.ts'))};
import {mutateStore,readStore,storage} from ${JSON.stringify(resolve('lib/cloud-store.ts'))};
let release=false;
globalThis.fetch=async (_url,init)=>{
 if(init?.method==='POST')return Response.json({id:'response',status:'in_progress'});
 if(!release)return Response.json({id:'response',status:'in_progress'});
 return Response.json({status:'completed',output:[{content:[{type:'output_text',text:'{"selectedPhotoIds":["p"]}'}]}]});
};
export default {async fetch(req){const p=new URL(req.url).pathname;
 if(p==='/seed'){await storage().put('thumb',new Uint8Array([255,216,255,217]));await mutateStore(s=>{s.trips.push({id:'t',accountId:'local',title:'',notes:'',startDate:null,endDate:null,highlightPhotoIds:['previous']});s.photos.push({id:'p',accountId:'local',tripId:'t',sha256:'a',createdAt:'2024-01-01',capturedAt:null,thumbnailPath:'thumb',metadata:{}});});return Response.json({});}
 if(p==='/edit'){await mutateStore(s=>{s.photos[0].sha256='changed';});release=true;return Response.json({});}
 if(p==='/state'){const s=await readStore();return Response.json({job:s.highlightJobs[0],ids:s.trips[0].highlightPhotoIds});}
 return highlightsRoute(req,['ai','highlights']);
}};`;
 const built=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
 const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{OPENAI_API_KEY:'test-only',ATLAS_MODEL:'test-model'}});
 try{
  await (await mf.getD1Database('DB')).exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);');
  const get=(p:string)=>mf.dispatchFetch('http://local'+p);
  await get('/seed');await mf.dispatchFetch('http://local/api/ai/highlights',{method:'POST',headers:{'content-type':'application/json'},body:'{"tripId":"t"}'});
  let x:any;for(let i=0;i<100;i++){x=await (await get('/state')).json();if(x.job?.batches[0].responseId)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(x.job.batches[0].responseId,'response');await get('/edit');await get('/api/ai/highlights');x=await (await get('/state')).json();
  assert.equal(x.job.status,'failed');assert.deepEqual(x.ids,['previous']);assert.equal(typeof x.job.finishedAt,'number');
 } finally {await mf.dispose();}
});
