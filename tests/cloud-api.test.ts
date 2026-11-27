import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

// An isolated in-memory Worker exercises the real D1/R2 implementation; it never reaches hosted data.
test('cloud storage handles concurrency, ownership, batch edits, trash and downloads', async () => {
  const entry = `import { routeApi } from ${JSON.stringify(resolve('lib/cloud-api.ts'))};
import { mutateStore } from ${JSON.stringify(resolve('lib/cloud-store.ts'))};
import { exportRoute } from ${JSON.stringify(resolve('lib/cloud-export.ts'))};
export default {async fetch(req) {try {const url=new URL(req.url);if(url.pathname==='/seed-evidence'){await mutateStore(s=>{const p=s.photos[0];s.recapCutJobs=[{id:'e',accountId:p.accountId,tripId:p.tripId,model:'fixture',source:'{}',photoIds:[p.id],requiredPhotoIds:[],status:'succeeded',error:null,cuts:null,createdAt:1,batches:[{photoIds:[p.id],status:'succeeded',observations:[{photoId:p.id,description:'Private visual fixture'}],imageKeys:{[p.id]:JSON.stringify(['recap-observation-v1','fixture',p.id,p.sha256,p.thumbnailPath])}}],synthesis:{photoIds:[],status:'succeeded'}}];});return Response.json({ok:true});}if(url.pathname==='/seed-other'){await mutateStore(s=>{s.photos.push({...s.photos[0],id:'other',accountId:'other'});});return Response.json({ok:true});}const parts=url.pathname.split('/').filter(Boolean);return await (parts[0]==='export'?exportRoute(req,parts):routeApi(req,parts));} catch(e) {return Response.json({error:e.message},{status:400});}}};`;
  const built=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
  const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET']});
  try {
    const db=await mf.getD1Database('DB');
    await db.exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0); CREATE TABLE owner_identity (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL);');
    const request=(path:string, method='GET', value?:unknown)=>mf.dispatchFetch('http://local/'+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});
    const decode=async (r:Awaited<ReturnType<typeof mf.dispatchFetch>>)=>{assert.equal(r.status,200,await r.clone().text());return await r.json() as any;};
    const trips=await Promise.all(Array.from({length:8},(_,i)=>request('trips','POST',{title:`Trip ${i}`})));
    assert.ok(trips.every(r=>r.status===200));
    let ws=await decode(await request('workspace'));assert.equal(ws.trips.length,8);
    const creationId=crypto.randomUUID();
    const retried=await Promise.all([request('trips','POST',{title:'Import retry',creationId}),request('trips','POST',{title:'Import retry',creationId})]);
    assert.deepEqual((await Promise.all(retried.map(decode))).map(trip=>trip.id),[creationId,creationId]);
    ws=await decode(await request('workspace'));assert.equal(ws.trips.filter((trip:any)=>trip.id===creationId).length,1);
    const tripId=creationId;
    // A real one-pixel PNG also exercises portable image export validation.
    const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'));
    // JPEG APP1 EXIF with DateTimeOriginal = 2020:01:02 03:04:05.
    const tiff=new Uint8Array(64), tv=new DataView(tiff.buffer);
    tiff.set([0x49,0x49,42,0,8,0,0,0]);tv.setUint16(8,1,true);tv.setUint16(10,0x8769,true);tv.setUint16(12,4,true);tv.setUint32(14,1,true);tv.setUint32(18,26,true);
    tv.setUint16(26,1,true);tv.setUint16(28,0x9003,true);tv.setUint16(30,2,true);tv.setUint32(32,20,true);tv.setUint32(36,44,true);tiff.set(new TextEncoder().encode('2020:01:02 03:04:05\0'),44);
    const jpeg=new Uint8Array(2+4+6+tiff.length+2);jpeg.set([0xff,0xd8,0xff,0xe1,0,72,69,120,105,102,0,0]);jpeg.set(tiff,12);jpeg.set([0xff,0xd9],jpeg.length-2);
    const form=new FormData();form.set('tripId',tripId);form.append('files',new File([jpeg],'你好.jpg',{type:'image/jpeg'}));form.append('thumbnails',new File([png],'thumb.png',{type:'image/png'}));form.set('dimensions',JSON.stringify([{width:1,height:1}]));
    const uploadRequest=new Request('http://local/photos',{method:'POST',body:form}); const uploaded=await decode(await mf.dispatchFetch('http://local/photos',{method:'POST',headers:{'content-type':uploadRequest.headers.get('content-type')!},body:await uploadRequest.arrayBuffer()}));assert.equal(uploaded.imported.length,1);assert.equal(uploaded.imported[0].capturedAt,'2020-01-02T03:04:05');assert.equal(uploaded.imported[0].timeSource,'exif');
    ws=await decode(await request('workspace'));
    const importedTrip=ws.trips.find((trip:any)=>trip.id===tripId);
    assert.equal(importedTrip.startDate.slice(0,10),'2020-01-02');
    assert.equal(importedTrip.endDate.slice(0,10),'2020-01-02');
    const id=uploaded.imported[0].id;assert.equal('originalPath' in uploaded.imported[0],false);
    await decode(await request('seed-evidence','POST'));
    ws=await decode(await request('workspace'));assert.equal(ws.photos.find((p:any)=>p.id===id).recapVisualDescription,'Private visual fixture');
    assert.equal('thumbnailPath' in ws.photos.find((p:any)=>p.id===id),false);
    const download=await request(`media/${id}?variant=original&download=1`);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition')||'',/attachment;.*filename\*=UTF-8''%E4%BD%A0/);assert.equal(download.headers.get('cache-control'),'private, no-store');
    await decode(await request('seed-other','POST'));assert.equal((await request('media/other?variant=original')).status,400);
    const invalid=await request('photos/batch','POST',{photoIds:[id,'other'],patch:{favorite:true}});assert.equal(invalid.status,400);
    ws=await decode(await request('workspace'));assert.equal(ws.photos.find((p:any)=>p.id===id).favorite,undefined);
    await decode(await request(`photos/${id}`,'PATCH',{latitude:20,longitude:30,placeName:'Somewhere'}));
    const recap=await decode(await request('recaps','POST',{title:'Fixture recap',summary:'Only published text',photoIds:[id]}));
    const html=await request(`export/${recap.id}?format=html`);
    assert.equal(html.status,200);assert.match(html.headers.get('content-disposition')||'',/^attachment;/);
    const document=await html.text();
    assert.match(document,/Only published text/);assert.match(document,/data:image\/png;base64,/);
    assert.match(document,/Somewhere/);
    assert.doesNotMatch(document,/2020-01-02T|你好|\/api\/media|Private visual fixture/);
    const scene=await decode(await request(`export/${recap.id}?format=scene`));
    assert.deepEqual(Object.keys(scene.photos[0]).sort(),['date','height','id','label','point','src','width']);
    const preview=await request(`export/${recap.id}?format=html&preview=1`);
    assert.equal(preview.headers.get('content-disposition'),null);
    const snapshot=html.headers.get('x-atlas-snapshot');
    await decode(await request(`recaps/${recap.id}`,'PATCH',{title:recap.title}));
    assert.equal((await request(`export/${recap.id}?format=scene`)).headers.get('x-atlas-snapshot'),snapshot);
    await decode(await request(`photos/${id}`,'PATCH',{placeName:'Somewhere else'}));
    assert.notEqual((await request(`export/${recap.id}?format=scene`)).headers.get('x-atlas-snapshot'),snapshot);

    // Optimized data has no EXIF: source identity and capture metadata travel separately.
    const source={sha256:'a'.repeat(64),mode:'optimized',time:{capturedAt:'2020-01-01T18:04:05.000Z',timezoneKnown:true,offsetMinutes:540,source:'DateTimeOriginal',localDateTime:'2020-01-02T03:04:05'},latitude:35.5,longitude:139.5};
    const uploadOptimized=async (metadata:unknown) => {
      const f=new FormData();f.set('tripId',tripId);f.append('files',new File([jpeg],'original.HEIC',{type:'image/jpeg'}));f.append('thumbnails',new File([png],'thumb.png'));f.set('dimensions',JSON.stringify([{width:1,height:1}]));f.set('sources',JSON.stringify([metadata]));
      const req=new Request('http://local/photos',{method:'POST',body:f});return decode(await mf.dispatchFetch('http://local/photos',{method:'POST',headers:{'content-type':req.headers.get('content-type')!},body:await req.arrayBuffer()}));
    };
    const optimized=await uploadOptimized(source);assert.equal(optimized.imported.length,1);assert.equal(optimized.imported[0].storageMode,'optimized');assert.equal(optimized.imported[0].capturedAt,source.time.capturedAt);assert.equal(optimized.imported[0].timeMetadata.offsetMinutes,540);assert.equal(optimized.imported[0].latitude,35.5);
    const optimizedDownload=await request(`media/${optimized.imported[0].id}?variant=original&download=1`);assert.equal(optimizedDownload.headers.get('content-type'),'image/jpeg');assert.match(optimizedDownload.headers.get('content-disposition')||'',/original.jpg/);
    assert.equal((await uploadOptimized(source)).duplicates,1);
    const bad=await uploadOptimized({...source,sha256:'b'.repeat(64),time:{...source.time,capturedAt:'2020-01-02T03:04:05.000Z'}});assert.equal(bad.imported.length,0);assert.match(bad.errors[0].error,/Invalid source time/);
    const mismatch=await uploadOptimized({...source,sha256:'c'.repeat(64),mode:'original'});assert.match(mismatch.errors[0].error,/hash does not match/);

    const noExif=new FormData();
    noExif.set('tripId',tripId);noExif.append('files',new File([png],'no-exif.png'));noExif.append('files',new File(['not an image'],'broken.jpg'));
    for(let i=0;i<2;i++)noExif.append('thumbnails',new File([png],'thumb.png'));
    noExif.set('dimensions',JSON.stringify([{width:1,height:1},{width:1,height:1}]));
    const noExifRequest=new Request('http://local/photos',{method:'POST',body:noExif});
    const partial=await decode(await mf.dispatchFetch('http://local/photos',{method:'POST',headers:{'content-type':noExifRequest.headers.get('content-type')!},body:await noExifRequest.arrayBuffer()}));
    assert.equal(partial.imported.length,1);assert.equal(partial.imported[0].capturedAt,null);
    assert.equal(partial.imported[0].latitude,null);assert.equal(partial.errors[0].fileName,'broken.jpg');
    await decode(await request(`photos/${id}`,'DELETE'));
    assert.equal((await request(`media/${id}`)).status,400);assert.equal((await request(`media/${id}?trash=1`)).status,200);assert.equal((await request(`media/${id}?trash=1&variant=original`)).status,400);
    let trash=await decode(await request('photos/trash'));assert.equal(trash.length,1);assert.equal('thumbnailPath' in trash[0],false);
    await decode(await request(`photos/${id}/restore`,'POST'));trash=await decode(await request('photos/trash'));assert.equal(trash.length,0);
  } finally { await mf.dispose(); }
});
