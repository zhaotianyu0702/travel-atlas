import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

test('recap jobs analyze all selected photos in bounded batches and honor required IDs',async()=>{
 const entry=`
import {recapCutsRoute} from ${JSON.stringify(resolve('lib/cloud-recap-cuts.ts'))};
import {mutateStore,storage} from ${JSON.stringify(resolve('lib/cloud-store.ts'))};
let calls=[], pending=new Map();
globalThis.fetch=async(url,init)=>{
 if(!init?.method || init.method==='GET'){const id=String(url).split('/').pop();return Response.json({id,status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(pending.get(id))}]}]});}
 const body=JSON.parse(init.body), c=body.input[0].content, name=body.text.format.name;calls.push({name,images:c.length-1,effort:body.reasoning.effort});
 let data;
 if(name==='recap_themes'||name==='recap_photo_selection'||c[0].text.includes('Assemble exactly one')){
  const input=JSON.parse(c[0].text.split('Inputs: ')[1]);
  if(name==='recap_themes')data={themes:[{title:'Windhoek ridge',photoIds:[input.metadata.find(photo=>photo.visualSample).id]}]};
  else if(name==='recap_photo_selection')data={selectedPhotoIds:input.metadata.filter(photo=>photo.place==='Windhoek').map(photo=>photo.id)};
  else data={cuts:[{kind:'journey',title:'Windhoek ridge',beats:input.metadata.map(photo=>({photoIds:[photo.id],caption:'Visible landscape',seconds:3}))}]};
 }
 else if(name==='recap_observations'){const ids=JSON.parse(c[0].text.split('IDs: ')[1]);data={photos:ids.map(photoId=>({photoId,description:'A landscape'}))};}
 else {const input=JSON.parse(c[0].text.split('Inputs: ')[1]);const ids=[...new Set([input.metadata[0].id,...input.required])];const kinds=JSON.parse(c[0].text.split('cut kinds ')[1].split(', using')[0]);data={cuts:kinds.map(kind=>({kind,title:kind,beats:ids.map(photoId=>({photoIds:[photoId],caption:'Landscape',seconds:3}))}))};}
 const id='response'+calls.length;pending.set(id,data);return Response.json({id,status:'in_progress'});
};
export default {async fetch(req){const path=new URL(req.url).pathname;
 if(path==='/seed'){const ids=Array.from({length:101},(_,i)=>'p'+i);await Promise.all(ids.map(id=>storage().put(id,new Uint8Array([255,216,255,217]))));await mutateStore(s=>{s.trips.push({id:'t',accountId:'local',title:'Trip',notes:'',startDate:null,endDate:null});s.photos.push(...ids.map(id=>({id,accountId:'local',tripId:'t',sha256:id,thumbnailPath:id,capturedAt:null,locationSource:'unknown',placeName:'',country:''})));});return Response.json({});}
 if(path==='/timeout'){await mutateStore(s=>{const original=s.recapCutJobs[0];s.recapCutJobs.push({...original,id:'timeout',status:'running',cuts:null,batches:[{photoIds:['p0'],status:'running',responseId:'missing',claimedAt:Date.now()-301000}],synthesis:{photoIds:[],status:'queued'}});});return Response.json({});}
 if(path==='/v2'){await mutateStore(s=>{s.recapCutJobs[0].generationVersion=2;});return Response.json({});}
 if(path==='/legacy-pending'){let id;await mutateStore(s=>{const original=s.recapCutJobs[0];id='legacy-pending';const v2=new URL(req.url).searchParams.has('v2');id=v2?'v2-pending':'legacy-pending';const cuts=original.cuts.slice(0,v2?3:2);pending.set(id,{cuts});s.recapCutJobs.push({...original,id,status:'running',cuts:null,generationVersion:v2?2:undefined,synthesis:{photoIds:[],status:'running',responseId:id,claimedAt:Date.now()}});});return Response.json({id});}
 if(path==='/legacy'){await mutateStore(s=>{delete s.recapCutJobs[0].generationVersion;s.recapCutJobs[0].cuts=s.recapCutJobs[0].cuts.slice(0,2);});return Response.json({});}
 if(path==='/change'){await mutateStore(s=>{s.photos[0].favorite=true;});return Response.json({});}
 if(path==='/places'){await mutateStore(s=>{for(const [i,p] of s.photos.slice(0,2).entries()){p.locationSource='user';p.placeName='Near Windhoek';p.capturedAt='2026-08-23T09:0'+i+':00';}});return Response.json({});}
 if(path==='/calls')return Response.json(calls);
 const parts=path.split('/').filter(Boolean).slice(1);return recapCutsRoute(req,parts);
}};`;
 const built=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
 const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{OPENAI_API_KEY:'test-only',ATLAS_MODEL:'existing-model'}});
 try{
  await (await mf.getD1Database('DB')).exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);');
  await mf.dispatchFetch('http://local/seed');
  const ids=Array.from({length:10},(_,i)=>'p'+i);
  const start=await mf.dispatchFetch('http://local/api/ai/recap-cuts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tripId:'t',photoIds:ids,requiredPhotoIds:['p9']})});
  assert.equal(start.status,202);const created=await start.json() as {id:string};
  const duplicate=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tripId:'t',photoIds:ids,requiredPhotoIds:['p9']})})).json() as {id:string};assert.equal(duplicate.id,created.id);let job!:{status:string;analyzedCount:number;totalCount:number;cuts:{beats:{photoIds:string[]}[]}[]};
  for(let i=0;i<20;i++){job=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/'+created.id)).json() as typeof job;if(job.status==='succeeded'||job.status==='failed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.status,'succeeded',JSON.stringify(job));assert.equal(job.analyzedCount,10);assert.equal(job.totalCount,10);
  assert.ok(job.cuts.every((c)=>c.beats.some((b)=>b.photoIds.includes('p9'))));
  const calls=await (await mf.dispatchFetch('http://local/calls')).json() as {name:string;images:number}[];
  assert.deepEqual(calls.filter(c=>c.name==='recap_observations').map(c=>c.images).sort((a,b)=>a-b),[2,4,4]);assert.equal(calls.filter(c=>c.name==='recap_cuts').length,1);assert.ok(calls.every(c=>(c as {effort?:string}).effort===(c.name==='recap_cuts'?'high':'low')));
  await mf.dispatchFetch('http://local/timeout');const timeout=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/timeout')).json() as {status:string};assert.equal(timeout.status,'failed');
  const retry=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tripId:'t',photoIds:ids,requiredPhotoIds:['p9']})})).json() as {id:string};assert.equal(retry.id,created.id);
  assert.equal(job.cuts.length,3);
  const legacyPending=await (await mf.dispatchFetch('http://local/legacy-pending')).json() as {id:string};
  const legacyResult=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/'+legacyPending.id)).json() as typeof job;assert.equal(legacyResult.status,'succeeded');assert.equal(legacyResult.cuts.length,2);
  const v2Pending=await (await mf.dispatchFetch('http://local/legacy-pending?v2=1')).json() as {id:string};const v2Result=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/'+v2Pending.id)).json() as typeof job;assert.equal(v2Result.status,'succeeded');assert.equal(v2Result.cuts.length,3);
  await mf.dispatchFetch('http://local/legacy');
  await mf.dispatchFetch('http://local/v2');
  const upgraded=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tripId:'t',photoIds:ids,requiredPhotoIds:['p9']})})).json() as {id:string;analyzedCount:number};
  assert.notEqual(upgraded.id,created.id);assert.equal(upgraded.analyzedCount,10);
  for(let i=0;i<20;i++){job=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/'+upgraded.id)).json() as typeof job;if(job.status==='succeeded'||job.status==='failed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.status,'succeeded');assert.equal(job.cuts.length,3);
  const focused=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tripId:'t',photoIds:ids,requiredPhotoIds:['p9'],focusKind:'focus'})})).json() as {id:string;analyzedCount:number};
  assert.equal(focused.analyzedCount,10);
  for(let i=0;i<20;i++){job=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/'+focused.id)).json() as typeof job;if(job.status==='succeeded'||job.status==='failed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.status,'succeeded');assert.equal(job.cuts.length,1);assert.equal((job.cuts[0] as {kind?:string}).kind,'focus');
  const changedIds=[...ids.slice(0,9),'p10'];
  const regeneration=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tripId:'t',photoIds:changedIds,requiredPhotoIds:['p10']})})).json() as {id:string;analyzedCount:number};
  assert.equal(regeneration.analyzedCount,9);
  for(let i=0;i<20;i++){job=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/'+regeneration.id)).json() as typeof job;if(job.status==='succeeded'||job.status==='failed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.status,'succeeded');assert.equal(job.analyzedCount,10);
  const after=await (await mf.dispatchFetch('http://local/calls')).json() as {name:string;images:number}[];
  assert.deepEqual(after.filter(c=>c.name==='recap_observations').map(c=>c.images).sort((a,b)=>a-b),[1,2,4,4]);
  const single=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tripId:'t',photoIds:['p0'],requiredPhotoIds:['p0']})})).json() as {id:string};
  for(let i=0;i<20;i++){job=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/'+single.id)).json() as typeof job;if(job.status==='succeeded'||job.status==='failed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.status,'succeeded');assert.equal(job.cuts.length,3);
  const pending=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tripId:'t',photoIds:ids,requiredPhotoIds:[]})})).json() as {id:string};
  await mf.dispatchFetch('http://local/change');
  const stale=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/'+pending.id)).json() as {status:string};assert.equal(stale.status,'failed');
  const largeIds = Array.from({length: 100}, (_, i) => 'p'+i);
  const beforeLarge = await (await mf.dispatchFetch('http://local/calls')).json() as typeof calls;
  const large = await (await mf.dispatchFetch('http://local/api/ai/recap-cuts', {
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({tripId:'t',photoIds:largeIds,requiredPhotoIds:['p99']}),
  })).json() as {id:string;analyzedCount:number};
  for(let i=0;i<40;i++) {
    job=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/'+large.id)).json() as typeof job;
    if(job.status==='succeeded'||job.status==='failed') break;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(job.status,'succeeded');
  assert.equal(job.analyzedCount,100);
  assert.ok(job.cuts.every(c=>c.beats.some(b=>b.photoIds.includes('p99'))));
  const largeCalls = (await (await mf.dispatchFetch('http://local/calls')).json() as typeof calls).slice(beforeLarge.length);
  assert.ok(largeCalls.every(c=>c.images<=8));
  assert.equal(largeCalls.reduce((sum,c)=>sum+c.images,0),100-large.analyzedCount);
  const invalid=await mf.dispatchFetch('http://local/api/ai/recap-cuts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tripId:'t',photoIds:['p0'],requiredPhotoIds:['p10']})});assert.equal(invalid.status,400);
  await mf.dispatchFetch('http://local/places');
  const guided=async (options:Record<string,unknown>)=>{
    const started=await mf.dispatchFetch('http://local/api/ai/recap-cuts',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({tripId:'t',direction:'timeline',photoIds:largeIds,...options}),
    });
    assert.ok(started.ok,await started.clone().text());
    const {id}=await started.json() as {id:string};
    type Job=import('../lib/recap-cut').RecapCutJob;
    return await pollGuided(id);
    async function pollGuided(jobId:string):Promise<Job>{
      for(let i=0;i<30;i++){
        const result=await (await mf.dispatchFetch('http://local/api/ai/recap-cuts/'+jobId)).json() as Job;
        if(result.status==='failed')assert.fail(JSON.stringify(result));
        if(result.status==='succeeded')return result;
      }
      throw Error('Guided recap job did not finish.');
    }
  };
  const themes=await guided({stage:'themes'});
  assert.equal(themes.totalCount,32);
  assert.equal(themes.cuts,null);
  assert.equal(themes.themes?.[0].title,'Windhoek ridge');
  const theme=themes.themes![0].title;
  const picks=await guided({stage:'select',theme,count:4});
  assert.deepEqual(picks.selectedPhotoIds,['p0','p1']);
  assert.equal(picks.cuts,null);
  const photoIds=['p1','p0'];
  const composition=await guided({stage:'compose',theme,photoIds,presentation:{style:'cinematic',text:'places'}});
  assert.deepEqual(composition.cuts?.[0].presentation,{style:'cinematic',text:'places'});
  assert.deepEqual(composition.cuts?.[0].beats.map(beat=>[beat.photoIds[0],beat.caption]),[['p0','Windhoek'],['p1','Windhoek']]);
  const silent=await guided({stage:'compose',theme,photoIds,presentation:{style:'cinematic',text:'none'}});
  assert.notEqual(silent.id,composition.id);
  assert.deepEqual(silent.cuts?.[0].beats.map(beat=>beat.caption),['','']);
 }finally{await mf.dispose();}
});
