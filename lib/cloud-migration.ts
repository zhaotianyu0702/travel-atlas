import { env } from 'cloudflare:workers';
import { database, defaultAccountId, mutateStore, readStore, storage } from './cloud-store';
import type { Store } from './types';
import { aiRoute } from './cloud-ai';

async function matches(a:string,b:string){const enc=new TextEncoder();const digests=await Promise.all([a,b].map(x=>crypto.subtle.digest('SHA-256',enc.encode(x))));const x=new Uint8Array(digests[0]),y=new Uint8Array(digests[1]);let result=0;for(let i=0;i<x.length;i++)result|=x[i]^y[i];return result===0;}
export async function migrationRoute(request:Request):Promise<Response> {
  const closed=await database().prepare('SELECT closed FROM migration_state WHERE id=1').first<{closed:number}>();
  const secret=env.ATLAS_MIGRATION_SECRET,provided=request.headers.get('x-atlas-migration-key');
  if(closed?.closed||!secret||!provided||!await matches(secret,provided))return Response.json({error:'Not found'},{status:404,headers:{'Cache-Control':'private, no-store'}});
  const url=new URL(request.url);
  if(request.method==='PUT'){
    const id=url.searchParams.get('id')||'',kind=url.searchParams.get('kind');
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||!['original','thumb'].includes(kind||''))throw new Error('Invalid migration object');
    const bytes=await request.arrayBuffer();if(!bytes.byteLength||bytes.byteLength>25*1024*1024)throw new Error('Invalid migration size');
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==request.headers.get('x-content-sha256'))throw new Error('Migration file integrity check failed');
    const key=`${kind==='original'?'originals':'thumbnails'}/${id}`;
    await storage().put(key,bytes,{httpMetadata:{contentType:request.headers.get('content-type')||'application/octet-stream'},customMetadata:{sha256:hash}});
    return Response.json({key,bytes:bytes.byteLength,sha256:hash});
  }
  if(request.method==='POST'){
    const input=await request.json() as {operation?:string;store?:Store;tripId?:string;jobId?:string};
    // One-time verification shares the owner-private migration boundary and is disabled on close.
    if(input.operation==='ai-check'&&typeof input.tripId==='string')return aiRoute(new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tripId:input.tripId})}),['ai','jobs']);
    if(input.operation==='ai-poll'&&typeof input.jobId==='string')return aiRoute(new Request(request.url),['ai','jobs',input.jobId]);
    if(input.operation==='close'){await database().prepare('INSERT INTO migration_state(id,closed) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET closed=1').run();return Response.json({closed:true});}
    if(input.operation!=='workspace'||!input.store)throw new Error('Invalid migration operation');
    const incoming=input.store;
    if(!Array.isArray(incoming.accounts)||incoming.accounts.length!==1||incoming.accounts[0].id!==defaultAccountId||!['trips','photos','recaps','jobs'].every(k=>Array.isArray(incoming[k as keyof Store])))throw new Error('Invalid migration workspace');
    for(const list of [incoming.trips,incoming.photos,incoming.recaps,incoming.jobs]){if(list.some(x=>x.accountId!==defaultAccountId)||new Set(list.map(x=>x.id)).size!==list.length)throw new Error('Invalid migration ownership');}
    for(const photo of incoming.photos){if(!incoming.trips.some(t=>t.id===photo.tripId)||photo.originalPath!==`originals/${photo.id}`||photo.thumbnailPath!==`thumbnails/${photo.id}`)throw new Error('Invalid migration photo');const objects=await Promise.all([storage().head(photo.originalPath),storage().head(photo.thumbnailPath)]);if(objects.some(x=>!x)||objects[0]?.customMetadata?.sha256!==photo.sha256)throw new Error('A photo has not been migrated intact');}
    await mutateStore(current=>{if(current.photos.length||current.trips.length||current.recaps.length)throw new Error('The online workspace already contains records; migration will not overwrite them');Object.assign(current,incoming);});
  }
  const store=await readStore();
  return Response.json({trips:store.trips.length,photos:store.photos.length,recaps:store.recaps.length,jobs:store.jobs.length,aiConfigured:!!env.OPENAI_API_KEY,model:env.ATLAS_MODEL},{headers:{'Cache-Control':'private, no-store'}});
}
