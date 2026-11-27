import { env } from 'cloudflare:workers';
import { defaultAccountId, mutateStore, readStore, storage } from './cloud-store';
import { importPhotosBatch } from './cloud-import';
import { removeTrip } from './trip-delete';
import { applyPhotoPatch, nullableIsoDate, restorePhoto, setTripCover, softDeletePhoto, updatePhotoBatch } from './photo-update';
import { cutPhotoIds, editRecapCut, validateRecapCut } from './recap-cut';
import { photoCaptureDate } from './photo-time';
import { roadRouteStatus, scheduleRoadRoute } from './cloud-road-route';
import { roadRouteKey, routePoints } from './road-route';
import type { Photo, Recap, Store, Trip } from './types';
import { recapVisualEvidence } from './recap-visual-evidence';

const accountId=defaultAccountId;
const cleanPhoto=(photo:Photo) => { const {originalPath: _originalPath, thumbnailPath: _thumbnailPath, recapVisualDescription: _recapVisualDescription, ...clean}=photo; return clean; };
const json=(data:unknown, status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
function str(value:unknown, field:string):string {if(typeof value!=='string'||!value.trim()) throw new Error(`${field} is required`);return value.trim();}
async function body(req:Request):Promise<Record<string,unknown>> {const b=await req.json();if(!b||typeof b!=='object'||Array.isArray(b)) throw new Error('Invalid request');return b as Record<string,unknown>;}
function workspaceTrips(trips: Trip[], photos: Photo[], requests: Store['routeRequests']) {
  const ranges = new Map<string, [string, string]>();
  for (const photo of photos) {
    const date = photoCaptureDate(photo);
    if (!date) continue;
    const range = ranges.get(photo.tripId);
    if (!range) ranges.set(photo.tripId, [date, date]);
    else {
      if (date < range[0]) range[0] = date;
      if (date > range[1]) range[1] = date;
    }
  }
  return trips.map(original => {
    const request=requests?.find(r=>r.tripId===original.id);
    const trip=original.estimatedRoute && (!request || request.status!=='done' || request.sourceKey!==roadRouteKey(routePoints(photos,original.accountId,original.id))) ? {...original,estimatedRoute:null} : original;
    const range = ranges.get(trip.id);
    if (!range || trip.startDate || trip.endDate) return trip;
    return { ...trip, startDate: `${range[0]}T00:00:00.000Z`, endDate: `${range[1]}T00:00:00.000Z` };
  });
}
function updateRecap(s:Store, r:Recap, b:Record<string,unknown>, recalculate:boolean) {
  if ('title' in b) r.title=str(b.title,'title');
  if ('summary' in b) {if(typeof b.summary!=='string')throw new Error('Invalid summary');r.summary=b.summary;}
  if ('highlights' in b) {if(!Array.isArray(b.highlights)||!b.highlights.every(x=>typeof x==='string'))throw new Error('Invalid highlights');r.highlights=b.highlights;}
  if ('tripIds' in b) {if(!Array.isArray(b.tripIds)||!b.tripIds.every(x=>typeof x==='string'&&s.trips.some(t=>t.id===x&&t.accountId===accountId)))throw new Error('Invalid trips');r.tripIds=[...new Set(b.tripIds as string[])];}
  if ('startDate' in b)r.startDate=nullableIsoDate(b.startDate);if ('endDate' in b)r.endDate=nullableIsoDate(b.endDate);
  if(r.startDate&&r.endDate&&r.startDate>r.endDate)throw new Error('Start date must be before end date');
  if('place' in b){if(typeof b.place!=='string')throw new Error('Invalid place');r.place=b.place.trim();}
  if('theme' in b){if(b.theme!=='mixed'&&b.theme!=='data'&&b.theme!=='story')throw new Error('Invalid theme');r.theme=b.theme;}
  const matches=s.photos.filter(p=>p.accountId===accountId&&!p.deletedAt&&(!r.tripIds.length||r.tripIds.includes(p.tripId))&&(!r.startDate||!!p.capturedAt&&photoCaptureDate(p)>=r.startDate.slice(0,10))&&(!r.endDate||!!p.capturedAt&&photoCaptureDate(p)<=r.endDate.slice(0,10))&&(!r.place||`${p.placeName} ${p.country}`.toLowerCase().includes(r.place.toLowerCase())));
  if('photoIds' in b){if(!Array.isArray(b.photoIds)||!b.photoIds.every(x=>typeof x==='string'&&matches.some(p=>p.id===x)))throw new Error('Photos must match the selected filters');r.photoIds=[...new Set(b.photoIds as string[])];}
  else if(recalculate)r.photoIds=matches.map(p=>p.id);else if(!r.photoIds.every(id=>s.photos.some(p=>p.id===id&&p.accountId===accountId&&!!p.deletedAt)||matches.some(p=>p.id===id)))throw new Error('Existing photos do not match the selected filters');
  if ('cut' in b) r.cut = b.cut === null ? null : validateRecapCut(b.cut, r.photoIds);
  else if ('photoIds' in b && r.cut) r.cut = editRecapCut(r.cut, r.photoIds);
  if (r.cut && (cutPhotoIds(r.cut).join('|') !== r.photoIds.join('|'))) {
    throw new Error('The recap cut must match the selected photo order');
  }
  r.updatedAt=new Date().toISOString();return r;
}

// Record keys before touching R2 so a transient failure can be retried on workspace load.
async function cleanupDeletedMedia(): Promise<boolean> {
  const snapshot = await readStore();
  const referenced = new Set(snapshot.photos.flatMap(photo => [photo.originalPath, photo.thumbnailPath]));
  const pending = snapshot.pendingMediaDeletes ?? [];
  const safe = pending.filter(path => !referenced.has(path));
  if (!safe.length) return pending.length > 0;
  const deleted = new Set<string>();
  for (let start = 0; start < safe.length; start += 1000) {
    const batch = safe.slice(start, start + 1000);
    try { await storage().delete(batch); }
    catch { break; }
    for (const key of batch) deleted.add(key);
  }
  if (deleted.size) await mutateStore(s => { s.pendingMediaDeletes = (s.pendingMediaDeletes ?? []).filter(path => !deleted.has(path)); });
  return deleted.size !== pending.length;
}
export async function routeApi(req:Request,path:string[]):Promise<Response> {
  const [resource,id,action]=path, method=req.method;
  if(resource==='workspace'&&method==='GET'){
    const s=await readStore();
    if (s.pendingMediaDeletes?.length) await cleanupDeletedMedia().catch(() => true);
    const photos=s.photos.filter(photo=>photo.accountId===accountId&&!photo.deletedAt);
    const evidence=recapVisualEvidence(photos,s.recapCutJobs??[],accountId);
    return json({account:s.accounts.find(a=>a.id===accountId),accounts:s.accounts.filter(a=>a.id===accountId),trips:workspaceTrips(s.trips.filter(x=>x.accountId===accountId),photos,s.routeRequests),photos:photos.map(photo=>{const description=evidence.get(photo.id);return description?{...cleanPhoto(photo),recapVisualDescription:description}:cleanPhoto(photo);}),recaps:s.recaps.filter(x=>x.accountId===accountId),jobs:s.jobs.filter(x=>x.accountId===accountId),model:(env as unknown as {ATLAS_MODEL?:string}).ATLAS_MODEL||'gpt-6.1-terra',provider:'openai'});
  }
  if(resource==='accounts'){if(method==='GET')return json((await readStore()).accounts.filter(a=>a.id===accountId));if(method==='PATCH'&&id===accountId){const b=await body(req);return json(await mutateStore(s=>{const a=s.accounts.find(x=>x.id===accountId);if(!a)throw new Error('Not found');a.name=str(b.name,'name');return a;}));}throw new Error('Only the owner profile is supported');}
  if(resource==='trips'&&!id&&method==='POST'){
    const b=await body(req), now=new Date().toISOString();
    const creationId=b.creationId ?? crypto.randomUUID();
    if(typeof creationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(creationId))throw new Error('Invalid trip creation ID');
    const trip:Trip={id:creationId.toLowerCase(),accountId,title:str(b.title,'title'),startDate:nullableIsoDate(b.startDate),endDate:nullableIsoDate(b.endDate),notes:typeof b.notes==='string'?b.notes:'',createdAt:now,updatedAt:now};
    if(trip.startDate&&trip.endDate&&trip.startDate>trip.endDate)throw new Error('Start date must be before end date');
    return json(await mutateStore(s=>{
      const existing=s.trips.find(t=>t.id===trip.id&&t.accountId===accountId);
      if(existing)return existing;
      s.trips.push(trip);
      return trip;
    }));
  }
  if(resource==='trips'&&id&&action==='photo-hashes'&&method==='GET'){const s=await readStore();if(!s.trips.some(t=>t.id===id&&t.accountId===accountId))throw new Error('Not found');return json({hashes:[...new Set(s.photos.filter(p=>p.accountId===accountId&&p.tripId===id).map(p=>p.sha256))]});}
  if(resource==='trips'&&id&&action==='route'&&method==='GET')return json(await roadRouteStatus(accountId,id));
  if(resource==='trips'&&id&&action==='route'&&method==='POST'){const b=await body(req);if(b.consent!==true)throw new Error('Route sharing consent required');return json(await scheduleRoadRoute(accountId,id));}
  if(resource==='trips'&&id&&!action&&method==='PATCH'){const b=await body(req);return json(await mutateStore(s=>{const t=s.trips.find(x=>x.id===id&&x.accountId===accountId);if(!t)throw new Error('Not found');if('coverPhotoId'in b)setTripCover(s,accountId,id,b.coverPhotoId);if('title'in b)t.title=str(b.title,'title');if('notes'in b){if(typeof b.notes!=='string')throw new Error('Invalid notes');t.notes=b.notes;}if('startDate'in b)t.startDate=nullableIsoDate(b.startDate);if('endDate'in b)t.endDate=nullableIsoDate(b.endDate);if(t.startDate&&t.endDate&&t.startDate>t.endDate)throw new Error('Start date must be before end date');t.updatedAt=new Date().toISOString();return t;}));}
  if(resource==='trips'&&id&&!action&&method==='DELETE'){await mutateStore(s=>removeTrip(s,accountId,id));const cleanupPending=await cleanupDeletedMedia().catch(()=>true);return json({ok:true,cleanupPending});}
  if(resource==='photos'&&!id&&method==='POST'){
    const form=await req.formData(),tripId=form.get('tripId'),files=form.getAll('files'),thumbs=form.getAll('thumbnails');
    const snapshot=await readStore();
    if(typeof tripId!=='string'||!snapshot.trips.some(t=>t.id===tripId&&t.accountId===accountId))throw new Error('Trip not found');
    if(!files.length||files.some(f=>typeof f==='string')||thumbs.length!==files.length||thumbs.some(f=>typeof f==='string'))throw new Error('Select files with matching thumbnails');
    let sizes:unknown;try{sizes=JSON.parse(String(form.get('dimensions')));}catch{throw new Error('Invalid dimensions');}
    if(!Array.isArray(sizes)||sizes.length!==files.length)throw new Error('Invalid dimensions');
    let sources:unknown=null;if(form.has('sources')){try{sources=JSON.parse(String(form.get('sources')));}catch{throw new Error('Invalid source metadata');}if(!Array.isArray(sources)||sources.length!==files.length)throw new Error('Invalid source metadata');}
    const result=await importPhotosBatch(accountId,tripId,files.map((file,i)=>({file:file as File,thumbnail:thumbs[i] as File,size:sizes[i],source:Array.isArray(sources)?sources[i]:undefined})),snapshot);
    return json({...result,imported:result.imported.map(cleanPhoto)});
  }
  if(resource==='photos'&&id==='trash'&&method==='GET')return json((await readStore()).photos.filter(p=>p.accountId===accountId&&!!p.deletedAt).map(cleanPhoto));
  if(resource==='photos'&&id==='batch'&&method==='POST'){const b=await body(req);if(Object.keys(b).some(k=>!['photoIds','patch'].includes(k)))throw new Error('Invalid request');return json({updated:(await mutateStore(s=>updatePhotoBatch(s,accountId,b.photoIds,b.patch))).map(cleanPhoto)});}
  if(resource==='photos'&&id&&action==='restore'&&method==='POST')return json(cleanPhoto(await mutateStore(s=>restorePhoto(s,accountId,id))));
  if(resource==='photos'&&id&&!action&&method==='PATCH'){const b=await body(req);return json(cleanPhoto(await mutateStore(s=>{const p=s.photos.find(x=>x.id===id&&x.accountId===accountId&&!x.deletedAt);if(!p)throw new Error('Not found');return applyPhotoPatch(p,b);})));}
  if(resource==='photos'&&id&&!action&&method==='DELETE'){await mutateStore(s=>softDeletePhoto(s,accountId,id));return json({ok:true});}
  if(resource==='media'&&id&&method==='GET'){const url=new URL(req.url),variant=url.searchParams.get('variant')||'thumb',trash=url.searchParams.get('trash')==='1';if(variant!=='thumb'&&variant!=='original')throw new Error('Invalid variant');const p=(await readStore()).photos.find(x=>x.id===id&&x.accountId===accountId&&(x.deletedAt?trash&&variant==='thumb':!trash));if(!p)throw new Error('Not found');const obj=await storage().get(variant==='thumb'?p.thumbnailPath:p.originalPath);if(!obj)throw new Error('Not found');const headers:Record<string,string>={'Content-Type':variant==='thumb'?(obj.httpMetadata?.contentType||'image/jpeg'):p.mimeType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};if(variant==='original'&&url.searchParams.get('download')==='1'){const name=(p.storageMode==='optimized' ? `${p.fileName.replace(/\.[^.]*$/, '')}.jpg` : p.fileName).replace(/[\r\n]/g,'_');headers['Content-Disposition']=`attachment; filename="photo"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;}return new Response(obj.body as ReadableStream,{headers});}
  if(resource==='recaps'&&!id&&method==='POST'){const b=await body(req),now=new Date().toISOString();return json(await mutateStore(s=>{const r:Recap={id:crypto.randomUUID(),accountId,title:'',summary:'',highlights:[],photoIds:[],tripIds:[],startDate:null,endDate:null,place:'',theme:'mixed',createdAt:now,updatedAt:now};updateRecap(s,r,b,true);if(!r.title)throw new Error('title is required');s.recaps.push(r);return r;}));}
  if(resource==='recaps'&&id&&method==='PATCH'){const b=await body(req);return json(await mutateStore(s=>{const r=s.recaps.find(x=>x.id===id&&x.accountId===accountId);if(!r)throw new Error('Not found');return updateRecap(s,r,b,false);}));}
  if(resource==='recaps'&&id&&method==='DELETE'){await mutateStore(s=>{if(!s.recaps.some(r=>r.id===id&&r.accountId===accountId))throw new Error('Not found');s.recaps=s.recaps.filter(r=>!(r.id===id&&r.accountId===accountId));});return json({ok:true});}
  return json({error:'Not found'},404);
}
