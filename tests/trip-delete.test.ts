import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

test('trip deletion updates related records atomically and removes unshared media', async () => {
  const entry = `import {routeApi} from ${JSON.stringify(resolve('lib/cloud-api.ts'))};
import {mutateStore, readStore} from ${JSON.stringify(resolve('lib/cloud-store.ts'))};
export default {async fetch(req){try {const u=new URL(req.url);if(u.pathname==='/seed'){const data=await req.json();await mutateStore(s=>Object.assign(s,data));return Response.json({ok:true});}if(u.pathname==='/state')return Response.json(await readStore());return await routeApi(req,u.pathname.split('/').filter(Boolean));}catch(e){return Response.json({error:e.message},{status:400});}}}`;
  const built = await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
  const mf = new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET']});
  try {
    const db=await mf.getD1Database('DB');
    await db.exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)');
    const bucket=await mf.getR2Bucket('BUCKET');
    for (const key of ['a','at','b','bt','c','ct']) await bucket.put(key, key);
    const trip=(id:string,accountId='local')=>({id,accountId,title:id});
    const photo=(id:string,tripId:string,originalPath:string,thumbnailPath:string,accountId='local',deletedAt:string|null=null)=>({id,tripId,accountId,originalPath,thumbnailPath,deletedAt});
    const recap=(id:string,tripIds:string[],photoIds:string[],accountId='local')=>({id,accountId,tripIds,photoIds,updatedAt:'old',cut:{kind:'moments',title:'test',beats:[{photoIds:[...photoIds],caption:'old caption',seconds:3}]}});
    const seed={accounts:[],trips:[trip('a'),trip('b'),trip('foreign','other')],photos:[photo('1','a','a','at'),photo('2','a','b','bt','local','2026-01-01'),photo('3','b','c','ct'),photo('4','foreign','a','at','other')],recaps:[recap('one',['a'],['1','2']),recap('two',['a','b'],['1','3']),recap('other',['foreign'],['4'],'other')],jobs:[{id:'j1',accountId:'local',tripId:'a'},{id:'j2',accountId:'local',tripId:'b',scope:{photoIds:['1','3']}},{id:'j3',accountId:'other',tripId:'foreign'}],locationJobs:[{tripId:'a',photoId:'2'}],highlightJobs:[{tripId:'a'}],recapCutJobs:[{tripId:'a',accountId:'local',photoIds:['1']}],routeRequests:[{tripId:'a'}]};
    const request=(path:string,method='GET',value?:unknown)=>mf.dispatchFetch('http://local/'+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});
    await request('seed','POST',seed);
    const [response, parallel]=await Promise.all([request('trips/a','DELETE'), request('trips/b','PATCH',{title:'Updated concurrently'})]);assert.equal(parallel.status,200);assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await response.json(),{ok:true,cleanupPending:false});
    const state:any=await (await request('state')).json();
    assert.deepEqual(state.trips.map((x:any)=>x.id),['b','foreign']);assert.equal(state.trips[0].title,'Updated concurrently');
    assert.deepEqual(state.photos.map((x:any)=>x.id),['3','4']);
    assert.deepEqual(state.recaps.map((x:any)=>x.id),['two','other']);
    assert.deepEqual(state.recaps[0].tripIds,['b']);assert.deepEqual(state.recaps[0].photoIds,['3']);
    assert.deepEqual(state.recaps[0].cut.beats,[{photoIds:['3'],caption:'',seconds:3}]);
    assert.deepEqual(state.jobs.map((x:any)=>x.id),['j3']);
    assert.deepEqual(state.locationJobs,[]);assert.deepEqual(state.highlightJobs,[]);assert.deepEqual(state.recapCutJobs,[]);assert.deepEqual(state.routeRequests,[]);
    assert.ok(await bucket.head('a'));assert.ok(await bucket.head('at'));assert.equal(await bucket.head('b'),null);assert.equal(await bucket.head('bt'),null);assert.ok(await bucket.head('c'));
    assert.equal((await request('trips/foreign','DELETE')).status,400);
    assert.equal((await request('trips/a','DELETE')).status,400);
  } finally { await mf.dispose(); }
});
