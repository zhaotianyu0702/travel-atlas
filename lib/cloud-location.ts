import { waitUntil } from 'cloudflare:workers';
import { readStore, mutateStore, defaultAccountId, storage } from './cloud-store';
import { buildLocationContext, gateLocationCandidate, type LocationContext } from './location-context';
import { startLocationResponse, getLocationResponse, parseLocationResponse, imageDataUrl, locationModel, lightLocationModel, startSceneVerification, parseSceneVerification, needsStrongCheck, sceneSuggestion, type LocationResponse } from './location-provider';
import { estimateLocation } from './location-estimate';
import { applyPhotoPatch } from './photo-update';
import type { LocationJob, LocationSuggestion, Photo, Store, StoredLocationJob } from './types';

const READY = 'completed', waiting = (s: string | undefined) => s==='queued'||s==='in_progress';
const pending = (job: LocationJob) => job.status==='running'||job.status==='queued';
const missing = (p: Photo) => p.accountId===defaultAccountId && !p.deletedAt && !p.confirmed && (p.latitude===null||p.longitude===null);
const json = (data:unknown, status=200) => Response.json(data,{status});
const clean = ({sourceHash:_, responseId:__, createdAt:___, pipeline:____, ...job}:StoredLocationJob):LocationJob => job;
const onlyStrings = (a:unknown):a is string[] => Array.isArray(a) && a.length<=6 && new Set(a).size===a.length && a.every(x=>typeof x==='string' && x.length<=128);
const present = (s:Store,j:LocationJob) => s.photos.find(p=>p.id===j.photoId && p.tripId===j.tripId && missing(p));
const active = (s:Store) => s.locationJobs ||= [];
const scope = (s:Store,p:Photo) => buildLocationContext(p,s.photos);
const hash = async (s:string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const source = (c:LocationContext, pipeline:'cascade-v2'|'cascade-v3'|'cascade-v4'|'legacy'='cascade-v4') => JSON.stringify([pipeline==='legacy' ? 'location-v1' : `location-${pipeline.slice(-2)}:${lightLocationModel}`,locationModel(),c.metadata,c.anchors,c.photos.map(p=>[p.id,p.sha256,p.thumbnailPath,p.placeName,p.country])]);
const sourceForJob=(c:LocationContext,j:StoredLocationJob)=>source(c,j.pipeline??'legacy');

function gated(response:LocationResponse, p:Photo, context:LocationContext) {
  const raw = parseLocationResponse(response,context.photos.map(v=>v.id).filter(id=>id!==p.id));
  const {placeName,country,latitude,longitude,confidence,precision,evidence}=raw;
  const summary={placeName,country,latitude,longitude,confidence,precision,evidence};
  if (evidence!=='time-series' || !context.anchors ||
      ![context.anchors.before.photoId,context.anchors.after.photoId].every(id=>raw.supportingPhotoIds.includes(id))) return {raw:summary,candidate:null};
  const result=gateLocationCandidate({...raw,photoId:p.id},p,context,{distinctiveVisualVerified:false});
  const c=result.candidate;
  if (result.provenance!=='bracketing-context' || (c.confidence!=='medium' && c.confidence!=='high')) return {raw:summary,candidate:null};
  // The anchor positions justify an approximate pin, not an invented street/place name.
  const candidate:LocationSuggestion={placeName:p.placeName,country:p.country,latitude:c.latitude,longitude:c.longitude,confidence:c.confidence,precision:'locality',reason:c.reason,supportingPhotoIds:c.supportingPhotoIds??[],evidence:'time-series'};
  return {raw:summary,candidate};
}
async function finish(job:StoredLocationJob, status:'succeeded'|'failed', candidate:LocationSuggestion|null, expected?:string) {
  await mutateStore(s=>{
    const j=active(s).find(x=>x.id===job.id);
    if (!j || !pending(j)) return;
    const target=present(s,j);
    const same=expected===undefined || target && sourceForJob(scope(s,target),j)===expected;
    j.status=same ? status : 'failed';
    j.candidate=same ? candidate : null;
    j.durationMs=Date.now()-j.createdAt;
  });
}
async function complete(job:StoredLocationJob,response:LocationResponse) {
  const s=await readStore();
  const p=present(s,job);
  if (!p) return finish(job,'failed',null);
  const context=scope(s,p), fingerprint=sourceForJob(context,job);
  if (await hash(fingerprint)!==job.sourceHash || response.status!==READY) return finish(job,'failed',null);
  try {
    const candidate=job.pipeline
      ? sceneSuggestion(context,p,parseSceneVerification(response,context,'strong'),'strong')
      : gated(response,p,context).candidate;
    await finish(job,'succeeded',candidate,fingerprint);
  } catch {await finish(job,'failed',null);}
}
const hasAnchorEstimate=(context:LocationContext)=>!!estimateLocation(context);

async function submit(job:StoredLocationJob,context:LocationContext) {
  const fingerprint=sourceForJob(context,job), target=context.photos.find(p=>p.id===context.targetPhotoId);
  try {
    if (!target || !hasAnchorEstimate(context)) return await finish(job,'succeeded',null,fingerprint);
    const images=await Promise.all(context.photos.map(async p=>{
      const object=await storage().get(p.thumbnailPath);
      if (!object) throw new Error('Location preview is unavailable.');
      return imageDataUrl(new Uint8Array(await object.arrayBuffer()));
    }));
    const light=await startSceneVerification(context,images,job.id+'-light','light');
    if(light.status!==READY) return await finish(job,'failed',null);
    const decision=parseSceneVerification(light,context);
    if(!needsStrongCheck(decision,context)) return await finish(job,'succeeded',sceneSuggestion(context,target,decision,'light'),fingerprint);
    const strong=await startSceneVerification(context,images,job.id+'-strong','strong');
    if(strong.status===READY) return await complete(job,strong);
    if(!strong.id||!waiting(strong.status)) return await finish(job,'failed',null);
    await mutateStore(s=>{const j=active(s).find(x=>x.id===job.id);if(j&&pending(j))j.responseId=strong.id;});
  } catch {await finish(job,'failed',null);}
}
async function poll(job:StoredLocationJob) {
  if (!job.responseId) {if (Date.now()-job.createdAt>90_000) await finish(job,'failed',null);return;}
  try {
    const response=await getLocationResponse(job.responseId);
    if (!waiting(response.status)) await complete(job,response);
    else if (Date.now()-job.createdAt>20*60_000) await finish(job,'failed',null);
  } catch (e) {
    if (/HTTP (400|401|403|404)\b/.test(String(e)) || Date.now()-job.createdAt>20*60_000) await finish(job,'failed',null);
  }
}
async function create(request:Request) {
  const value=await request.json() as {tripId?:string;targetPhotoIds?:string[]};
  if (!value || typeof value.tripId!=='string' || !value.tripId) throw new Error('Choose a trip.');
  if (value.targetPhotoIds!==undefined && !onlyStrings(value.targetPhotoIds)) throw new Error('Choose up to six distinct photos.');
  const snapshot=await readStore();
  if (!snapshot.trips.some(t=>t.id===value.tripId&&t.accountId===defaultAccountId)) throw new Error('Trip not found.');
  const photos=snapshot.photos.filter(p=>p.tripId===value.tripId&&missing(p));
  if (value.targetPhotoIds?.some(id=>!photos.some(p=>p.id===id))) throw new Error('Target photo not found.');
  const scopedPhotos=value.targetPhotoIds ? photos.filter(p=>value.targetPhotoIds!.includes(p.id)) : photos;
  const queue:{job:StoredLocationJob;context:LocationContext;fingerprint:string}[]=[];
  // Select context-supported photos first. Skip unresolvable cases silently without a paid call.
  for (const p of scopedPhotos) {
    const ctx=scope(snapshot,p);
    const fingerprint=source(ctx), sourceHash=await hash(fingerprint);
    const existing=snapshot.locationJobs?.find(j=>j.photoId===p.id && (pending(j)||j.sourceHash===sourceHash && j.status==='succeeded'));
    if (existing) continue;
    queue.push({context:ctx,fingerprint,job:{id:crypto.randomUUID(),tripId:p.tripId,photoId:p.id,status:'queued',candidate:null,durationMs:null,createdAt:Date.now(),sourceHash,pipeline:'cascade-v4'}});
  }
  queue.sort((a,b)=>Number(hasAnchorEstimate(b.context))-Number(hasAnchorEstimate(a.context)));
  const items=queue.slice(0,6);
  const claimed=await mutateStore(s=>items.filter(item=>{
    const {job,context,fingerprint}=item;
    const p=present(s,job), jobs=active(s);
    if (!p || source(scope(s,p))!==fingerprint || jobs.some(j=>j.photoId===p.id&&(pending(j)||j.sourceHash===job.sourceHash&&j.status==='succeeded')) || hasAnchorEstimate(context) && jobs.filter(pending).length>=6) return false;
    s.locationJobs=jobs.filter(j=>j.photoId!==p.id || pending(j));
    if (!hasAnchorEstimate(context)) {job.status='succeeded';job.durationMs=0;}
    active(s).push(job);
    return true;
  }));
  waitUntil(Promise.allSettled(claimed.filter(x=>pending(x.job)).map(({job,context})=>submit(job,context))));
  return json({jobs:claimed.map(x=>clean(x.job))},202);
}
async function review(request:Request) {
  const {jobId,action,patch}=await request.json() as {jobId?:string;action?:string;patch?:Record<string,unknown>};
  if (typeof jobId!=='string' || !['save','dismiss'].includes(action??'')) throw new Error('Choose a review action.');
  const before=await readStore(), job=before.locationJobs?.find(j=>j.id===jobId);
  const p=job && present(before,job);
  if (!job || !p || job.status!=='succeeded' || !job.candidate || job.reviewed) throw new Error('Suggestion is no longer available.');
  const fingerprint=sourceForJob(scope(before,p),job);
  if (action==='save' && await hash(fingerprint)!==job.sourceHash) throw new Error('The location evidence changed; run Find locations again.');
  const saved=await mutateStore(s=>{
    const j=active(s).find(x=>x.id===jobId);
    const target=j&&present(s,j);
    if (!j||!target||!j.candidate||j.status!=='succeeded'||j.reviewed) throw new Error('Suggestion is no longer available.');
    if (action==='save') {
      if (sourceForJob(scope(s,target),j)!==fingerprint) throw new Error('The location evidence changed; run Find locations again.');
      if (!patch || Object.keys(patch).some(k=>!['placeName','country','latitude','longitude'].includes(k))) throw new Error('Invalid location edits.');
      applyPhotoPatch(target,{...patch,confirmed:true});
    }
    j.reviewed=action==='save'?'saved':'dismissed';
    return clean(j);
  });
  return json({job:saved});
}

export async function locationRoute(request:Request,path:string[]) {
  if (path.length===2&&request.method==='POST') return create(request);
  if (path.length===2&&request.method==='GET') {
    const snapshot=await readStore();
    const running=(snapshot.locationJobs??[]).filter(pending);
    await Promise.allSettled(running.map(poll));
    const state=running.length?await readStore():snapshot;
    return json({jobs:(state.locationJobs??[]).filter(j=>state.photos.some(p=>p.id===j.photoId&&p.tripId===j.tripId&&!p.deletedAt)).map(clean)});
  }
  if (path.length===3&&path[2]==='review'&&request.method==='POST') return review(request);
  return json({error:'Not found'},404);
}

type ProbeInput={id:string;capturedAt:string|null;preview:string;latitude?:number;longitude?:number};
function maskedPreview(data:string) {
  if (typeof data!=='string'||data.length>700_000||!data.startsWith('data:image/jpeg;base64,')) throw new Error('Use a small masked JPEG.');
  const bytes=Uint8Array.from(atob(data.slice(23)),c=>c.charCodeAt(0));
  if(bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217) throw new Error('Invalid JPEG.');
  let pos=2, sawScan=false;
  while(pos+4<bytes.length){
    if(bytes[pos++]!==255) throw new Error('Invalid JPEG markers.');
    const marker=bytes[pos++], len=(bytes[pos]<<8)+bytes[pos+1];
    if(marker===218){sawScan=true;break;}
    if(len<2||pos+len>bytes.length) throw new Error('Invalid JPEG length.');
    if((marker>=224&&marker<=239&&!(marker===224&&len===16&&String.fromCharCode(...bytes.subarray(pos+2,pos+7))==='JFIF\x00'))||marker===254)
      throw new Error('Strip image metadata before sending.');
    pos+=len;
  }
  if(!sawScan) throw new Error('Invalid JPEG scan.');
  return data;
}
export async function locationProbeRoute(request:Request) {
  if(request.method!=='POST') return json({error:'Not found'},404);
  const {target,neighbors,mode}=await request.json() as {target:ProbeInput;neighbors:ProbeInput[];mode:'context'|'image-only'|'cascade'};
  if (!target||!Array.isArray(neighbors)||neighbors.length>4||!['context','image-only','cascade'].includes(mode)) throw new Error('Invalid probe.');
  const images=new Map<string,string>();
  const input=[target,...(mode!=='image-only'?neighbors:[])];
  const photos=input.map((v,i):Photo=>{
    if(!v||typeof v.id!=='string'||!(/^[a-zA-Z0-9_-]{1,32}$/).test(v.id)||images.has(v.id)) throw new Error('Invalid opaque ID.');
    for(const k of Object.keys(v)) if(!['id','capturedAt','preview',...(i?['latitude','longitude']:[])].includes(k)) throw new Error('Unexpected metadata in probe input.');
    if(v.capturedAt!==null&&(typeof v.capturedAt!=='string'||v.capturedAt.length>35||!Number.isFinite(Date.parse(v.capturedAt)))) throw new Error('Invalid date.');
    const lat=i ? v.latitude : null,lon=i ? v.longitude : null;
    if(i&&(typeof lat!=='number'||typeof lon!=='number'||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)) throw new Error('Invalid neighbor coordinates.');
    images.set(v.id,maskedPreview(v.preview));
    return {id:v.id,accountId:defaultAccountId,tripId:'probe',fileName:'',mimeType:'image/jpeg',width:0,height:0,sha256:'',capturedAt:mode!=='image-only'?v.capturedAt:null,latitude:lat??null,longitude:lon??null,notes:'',placeName:'',country:'',locationSource:i?'exif':'unknown',confirmed:false,originalPath:'',thumbnailPath:'',metadata:{capturedAt:null,latitude:null,longitude:null},createdAt:''};
  });
  const photo=photos[0],context=buildLocationContext(photo,photos);
  if(mode==='cascade') {
    if (!hasAnchorEstimate(context)) return json({candidate:null,raw:null,providerSeconds:0,model:lightLocationModel,anchorCount:0,stages:[],outcome:'skipped'});
    const start=performance.now(), inputImages=context.photos.map(p=>images.get(p.id)!);
    const stage=(model:string,tier:'light'|'strong',started:number,result:LocationResponse)=>({
      model,stage:tier,seconds:(performance.now()-started)/1000,inputTokens:result.usage?.input_tokens,outputTokens:result.usage?.output_tokens,
    });
    const light=await startSceneVerification(context,inputImages,crypto.randomUUID(),'light');
    if(light.status!==READY) return json({error:'The lightweight verifier did not complete.'},502);
    const stages=[stage(lightLocationModel,'light',start,light)];
    let decision=parseSceneVerification(light,context), tier:'light'|'strong'='light';
    if(needsStrongCheck(decision,context)) {
      const strongStart=performance.now();
      let stronger=await startSceneVerification(context,inputImages,crypto.randomUUID(),'strong');
      const id=stronger.id;
      while(waiting(stronger.status)&&id&&performance.now()-strongStart<80_000){
        await new Promise(resolve=>setTimeout(resolve,1250));stronger=await getLocationResponse(id);
      }
      stages.push(stage(locationModel(),'strong',strongStart,stronger));
      if(stronger.status!==READY) return json({candidate:null,raw:null,providerSeconds:(performance.now()-start)/1000,model:locationModel(),anchorCount:2,stages,outcome:'unavailable'});
      tier='strong';
      decision=parseSceneVerification(stronger,context,tier);
    }
    const candidate=sceneSuggestion(context,photo,decision,tier);
    return json({candidate,raw:null,providerSeconds:(performance.now()-start)/1000,model:stages.at(-1)!.model,anchorCount:2,stages,outcome:candidate?'accepted':decision.verdict==='different'?'different':'uncertain'});
  }
  if(mode==='context'&&!context.anchors) return json({candidate:null,raw:null,providerSeconds:0,model:locationModel(),anchorCount:0,stages:[],outcome:'skipped'});
  const start=performance.now();
  let response=await startLocationResponse(context,context.photos.map(p=>images.get(p.id)!),crypto.randomUUID(),mode);
  const id=response.id;
  while(waiting(response.status)&&id&&performance.now()-start<85_000) {
    await new Promise(resolve=>setTimeout(resolve,1250)); response=await getLocationResponse(id);
  }
  if(response.status!==READY) return json({candidate:null,raw:null,providerSeconds:(performance.now()-start)/1000,model:locationModel(),anchorCount:context.anchors?2:0,
    stages:[{model:locationModel(),stage:'strong',seconds:(performance.now()-start)/1000,inputTokens:response.usage?.input_tokens,outputTokens:response.usage?.output_tokens}],outcome:'unavailable'});
  const result=gated(response,photo,context), seconds=(performance.now()-start)/1000;
  return json({...result,providerSeconds:seconds,model:locationModel(),anchorCount:context.anchors?2:0,
    stages:[{model:locationModel(),stage:'strong',seconds,inputTokens:response.usage?.input_tokens,outputTokens:response.usage?.output_tokens}],
    outcome:result.candidate?'accepted':'uncertain'});
}
