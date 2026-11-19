import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

test('route scheduling saves mocked provider results once and hides stale results', async()=>{
  const entry=`import { routeApi } from ${JSON.stringify(resolve('lib/cloud-api.ts'))};
import { mutateStore } from ${JSON.stringify(resolve('lib/cloud-store.ts'))};
let calls=0;
globalThis.fetch=async()=>{calls++;return Response.json({code:'Ok',waypoints:[{distance:0},{distance:0}],routes:[{distance:1100,duration:200,legs:[{distance:1100,steps:[{geometry:{coordinates:[[-74,40],[-74,40.01]]}}]}]}]});};
export default {async fetch(req){try{let u=new URL(req.url);if(u.pathname==='/seed'){await mutateStore(s=>{s.trips.push({id:'trip',accountId:'local',title:'Fixture',startDate:null,endDate:null,notes:'',createdAt:'',updatedAt:''});s.photos.push({id:'a',tripId:'trip',accountId:'local',latitude:40,longitude:-74,capturedAt:'2026-01-01T10:00:00Z'},{id:'b',tripId:'trip',accountId:'local',latitude:40.01,longitude:-74,capturedAt:'2026-01-01T11:00:00Z'});});return Response.json({ok:true});}if(u.pathname==='/change'){await mutateStore(s=>{s.photos[0].latitude=41;});return Response.json({ok:true});}if(u.pathname==='/calls')return Response.json({calls});return await routeApi(req,u.pathname.split('/').filter(Boolean));}catch(e){return Response.json({error:e.message},{status:400});}}};`;
  const built=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
  const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB']});
  try{
    const db=await mf.getD1Database('DB');await db.exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)');
    const get=async(path:string,method='GET',body?:unknown)=>mf.dispatchFetch('http://local/'+path,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    await get('seed');assert.equal((await get('trips/trip/route','POST',{})).status,400);
    assert.equal((await (await get('trips/trip/route','POST',{consent:true})).json() as any).scheduled,true);
    let status:any;for(let i=0;i<20;i++){status=await (await get('trips/trip/route')).json();if(status.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(status.status,'done');let ws:any=await (await get('workspace')).json();assert.equal(ws.trips[0].estimatedRoute.segments[0].fromPhotoId,'a');assert.equal(ws.trips[0].estimatedRoute.segments[0].toPhotoId,'b');
    assert.equal((await (await get('trips/trip/route','POST',{consent:true})).json() as any).scheduled,false);assert.equal((await (await get('calls')).json() as any).calls,1);
    await get('change');ws=await (await get('workspace')).json();assert.equal(ws.trips[0].estimatedRoute,null);assert.equal((await (await get('trips/trip/route')).json() as any).status,'unavailable');
  }finally{await mf.dispose();}
});
