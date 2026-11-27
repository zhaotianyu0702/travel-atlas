import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

test('batch import uses one workspace revision, deduplicates, and cleans concurrent uploads', async () => {
  const entry=`import {routeApi} from ${JSON.stringify(resolve('lib/cloud-api.ts'))};
import {mutateStore} from ${JSON.stringify(resolve('lib/cloud-store.ts'))};
export default {async fetch(req){try {const u=new URL(req.url);if(u.pathname==='/seed'){await mutateStore(s=>s.trips.push({id:'trip',accountId:'local',title:'Trip'}));return Response.json({});}return await routeApi(req,u.pathname.split('/').filter(Boolean));}catch(e){return Response.json({error:e.message},{status:400});}}};`;
  const built=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
  const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET']});
  try {
    const db=await mf.getD1Database('DB');await db.exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)');
    await mf.dispatchFetch('http://local/seed');
    const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64'));
    const jpeg=new Uint8Array([255,216,255,217]);
    const source=(i:number)=>({sha256:i.toString(16).padStart(64,'0'),mode:'optimized',time:{capturedAt:null,timezoneKnown:false,offsetMinutes:null,source:'unknown',localDateTime:null},latitude:null,longitude:null});
    const send=async (numbers:number[], bad=false)=>{
      const form=new FormData();form.set('tripId','trip');
      for(const [i,n] of numbers.entries()){form.append('files',new File([bad&&i===numbers.length-1?'broken':jpeg],`${n}.jpg`));form.append('thumbnails',new File([png],'t.png'));}
      form.set('dimensions',JSON.stringify(numbers.map(()=>({width:1,height:1}))));form.set('sources',JSON.stringify(numbers.map(source)));
      const req=new Request('http://local/photos',{method:'POST',body:form});const r=await mf.dispatchFetch(req.url,{method:req.method,headers:{'content-type':req.headers.get('content-type')!},body:await req.arrayBuffer()});assert.equal(r.status,200,await r.clone().text());return await r.json() as {imported:{id:string}[];duplicates:number;errors:unknown[]};
    };
    const version=async()=>Number((await db.prepare('SELECT version FROM workspace WHERE id=1').first<{version:number}>())!.version);
    const bucket=await mf.getR2Bucket('BUCKET');const count=async()=>(await bucket.list()).objects.length;
    const v=await version();const first=await send(Array.from({length:20},(_,i)=>i+1));assert.equal(first.imported.length,20);assert.equal(await version(),v+1);assert.equal(await count(),40);
    const v2=await version();const retry=await send([1,2,1]);assert.equal(retry.duplicates,3);assert.equal(await version(),v2);assert.equal(await count(),40);
    const partial=await send([21,22,23],true);assert.equal(partial.imported.length,2);assert.equal(partial.errors.length,1);assert.equal(await count(),44);
    const race=await Promise.all([send([24]),send([24])]);assert.equal(race.reduce((n,x)=>n+x.imported.length,0),1);assert.equal(race.reduce((n,x)=>n+x.duplicates,0),1);assert.equal(await count(),46);
    await mf.dispatchFetch('http://local/photos/'+first.imported[0].id,{method:'DELETE'});
    const hashes=await (await mf.dispatchFetch('http://local/trips/trip/photo-hashes')).json() as {hashes:string[]};assert.equal(hashes.hashes.length,23);assert.equal((await mf.dispatchFetch('http://local/trips/nope/photo-hashes')).status,400);
    const inBatch=await send([25,25]);assert.equal(inBatch.imported.length,1);assert.equal(inBatch.duplicates,1);assert.equal(await count(),48);
  } finally {await mf.dispose();}
});

test('failed object writes and workspace commits clean uploaded objects', async () => {
  const entry=`import {importPhotosBatch} from ${JSON.stringify(resolve('lib/cloud-import.ts'))};
import {setMode,objects} from 'mock-store';
export default {async fetch(req){const mode=new URL(req.url).pathname.slice(1);setMode(mode);const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);const jpeg=new Uint8Array([255,216,255,217]);const time={capturedAt:null,timezoneKnown:false,offsetMinutes:null,source:'unknown',localDateTime:null};const make=(hash)=>({file:new File([jpeg],hash+'.jpg'),thumbnail:new File([png],'t.png'),size:{width:1,height:1},source:{sha256:hash.repeat(64),mode:'optimized',time,latitude:null,longitude:null}});const result=await importPhotosBatch('local','trip',[make('a'),make('b')]);return Response.json({result,objects:objects()});}};`;
  const mock=`let mode='',keys=new Set();const state={trips:[{id:'trip',accountId:'local'}],photos:[]};export function setMode(m){mode=m;keys=new Set();state.photos=[];}export function objects(){return [...keys];}export async function readStore(){return state;}export async function mutateStore(fn){if(mode==='cas')throw new Error('Workspace busy');return fn(state);}export function storage(){return {async put(key){if(mode==='r2'&&key.startsWith('thumbnails/'))throw new Error('R2 failed');keys.add(key);},async delete(key){keys.delete(key);}};}`;
  const built=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers'],plugins:[{name:'store-fixture',setup(build){build.onResolve({filter:/^(mock-store|\.\/cloud-store)$/},()=>({path:'store',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:mock,loader:'js'}));}}]});
  const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat']});
  try {
    for(const mode of ['r2','cas']){const r=await mf.dispatchFetch('http://local/'+mode);const value=await r.json() as {result:{imported:unknown[];errors:unknown[]};objects:string[]};assert.equal(value.result.imported.length,0);assert.equal(value.result.errors.length,2);assert.deepEqual(value.objects,[]);}
  } finally {await mf.dispose();}
});
