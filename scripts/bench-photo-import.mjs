// Isolated routeApi import benchmark. Usage: node scripts/bench-photo-import.mjs /path/to/checkout
// No hosted services, real photos, browser preparation, network RTT, or models are involved.
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = resolve(process.argv[2] || '.');
const entry = `import {routeApi} from ${JSON.stringify(resolve(root, 'lib/cloud-api.ts'))};
export default {async fetch(req){try{return await routeApi(req,new URL(req.url).pathname.split('/').filter(Boolean));}catch(e){return Response.json({error:e.message},{status:400});}}}`;
const built = await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
const mf = new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET']});
try {
  const db = await mf.getD1Database('DB');
  await db.exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0); CREATE TABLE owner_identity (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL);');
  const tripResponse = await mf.dispatchFetch('http://local/trips',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Synthetic benchmark'})});
  if (!tripResponse.ok) throw new Error(await tripResponse.text());
  const trip = await tripResponse.json();
  const fixtures=[];
  for(let i=0;i<410;i++) {
    // Distinct rendered pixels, not merely changed filenames/metadata.
    const raw=Buffer.alloc(256*192*3);
    for(let y=0;y<192;y++) for(let x=0;x<256;x++) {const p=(y*256+x)*3; raw[p]=(x+i*7)%256;raw[p+1]=(y+i*13)%256;raw[p+2]=((x^y)+i*17+Math.floor(i/256)*23)%256;}
    const image=await sharp(raw,{raw:{width:256,height:192,channels:3}}).jpeg({quality:72}).toBuffer();
    const thumb=await sharp(image).resize(128,96).jpeg({quality:69}).toBuffer();
    fixtures.push({image,thumb,name:`fixture-${i}.jpg`,hash:createHash('sha256').update(image).digest('hex')});
  }
  if(new Set(fixtures.map(f=>f.hash)).size!==fixtures.length) throw Error('JPEG fixture hashes must be distinct');
  await Promise.all([sharp(fixtures[0].image).metadata(),sharp(fixtures[409].image).metadata()]);
  const before = await db.prepare('SELECT version FROM workspace WHERE id=1').first();
  const batches = [fixtures.slice(0,2)];
  for(let i=2;i<400;i+=20)batches.push(fixtures.slice(i,Math.min(i+20,400)));
  batches.push(fixtures.slice(0,20));
  batches.push([...fixtures.slice(20,30),...fixtures.slice(400,410),{image:Buffer.from('not an image'),thumb:fixtures[0].thumb,name:'invalid.jpg'}]);
  let imported=0,duplicates=0,errors=0, firstBatchMs, requestErrors=[];const start=performance.now();
  for(const [index,batch] of batches.entries()) {
    const form=new FormData();form.set('tripId',trip.id);
    for(const f of batch){form.append('files',new File([f.image],f.name,{type:'image/jpeg'}));form.append('thumbnails',new File([f.thumb],'thumb.jpg',{type:'image/jpeg'}));}
    form.set('dimensions',JSON.stringify(batch.map(()=>({width:256,height:192}))));
    const request=new Request('http://local/photos',{method:'POST',body:form});const t=performance.now();
    const response=await mf.dispatchFetch('http://local/photos',{method:'POST',headers:{'content-type':request.headers.get('content-type')},body:await request.arrayBuffer()});
    const body=await response.json();if(index===0)firstBatchMs=performance.now()-t;
    if(!response.ok){requestErrors.push({status:response.status,body});continue;}
    imported+=body.imported.length;duplicates+=body.duplicates;errors+=body.errors.length;
  }
  const elapsed=performance.now()-start;const after=await db.prepare('SELECT version,json FROM workspace WHERE id=1').first();
  const bucket=await mf.getR2Bucket('BUCKET');let cursor,objects=[];do {const page=await bucket.list({limit:1000,...(cursor?{cursor}:{})});objects.push(...page.objects);cursor=page.truncated?page.cursor:undefined;}while(cursor);
  const result={source:root,firstBatchMs,elapsedMs:elapsed,requests:batches.length,imported,duplicates,errors,requestErrors,revisionBefore:before.version,revisionAfter:after.version,revisionDelta:after.version-before.version,workspacePhotos:JSON.parse(after.json).photos.length,r2Objects:objects.length,r2Bytes:objects.reduce((n,o)=>n+o.size,0),fixtureBytes:fixtures.reduce((n,f)=>n+f.image.length+f.thumb.length,0),fixtureDimensions:'256x192',fixtureCount:fixtures.length};
  console.log(JSON.stringify(result,null,2));
  if(imported!==410||duplicates!==30||errors!==1||requestErrors.length||result.workspacePhotos!==410||result.r2Objects!==820)process.exitCode=1;
} finally {await mf.dispose();}
