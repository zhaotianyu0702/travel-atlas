import { env } from 'cloudflare:workers';
import { readStore, mutateStore, storage, defaultAccountId } from './cloud-store';
import { suggestionSchema, validateSuggestion } from './ai-schema';
import { resolveRecapScope } from './ai-scope';
import { buildModelInput, samplePhotos, targetsFor, timeEvidence } from './ai-input';
import type { AiJob, Photo, Store, Trip } from './types';

const VERSION = 'atlas-cloud-vision-v2';
const provider = 'openai-responses';
type CloudJob = AiJob & { responseId?: string; submissionStartedAt?: string; inputFingerprint?: string };
type ProviderResponse = { id?: string; status?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }>; error?: { message?: string }; incomplete_details?: { reason?: string }; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } };
const settings = () => env as unknown as { OPENAI_API_KEY?: string; ATLAS_MODEL?: string };
const now = () => new Date().toISOString();
const errorResponse = (e: unknown) => { const message = e instanceof Error ? e.message : 'AI request failed'; return Response.json({ error: message }, { status: message === 'Not found' ? 404 : 400 }); };
const sha = async (bytes: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
const bytesToBase64 = (bytes: Uint8Array) => { let result = ''; for (let i = 0; i < bytes.length; i += 0x8000) result += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(result); };

function resolve(store: Store, job: Pick<CloudJob, 'accountId' | 'tripId' | 'scope' | 'targetPhotoIds'>): {trip: Trip; photos: Photo[]} {
  if (job.scope) return resolveRecapScope(store, job.accountId, job.scope);
  const trip = store.trips.find(t => t.id === job.tripId && t.accountId === job.accountId);
  if (!trip) throw new Error('Trip no longer exists');
  const photos = store.photos.filter(p => p.tripId === trip.id && p.accountId === job.accountId && !p.deletedAt);
  if (!photos.length) throw new Error('Add photos to this trip before generating suggestions');
  targetsFor(photos, { targetPhotoIds: job.targetPhotoIds });
  return {trip, photos};
}
function fingerprint(trip: Trip, photos: Photo[], model: string, targets: string[]) {
  return JSON.stringify({version: VERSION, model, provider, targets: [...targets].sort(), trip: {title:trip.title, notes:trip.notes, startDate:trip.startDate, endDate:trip.endDate}, inventory: photos.map(p => ({id:p.id, hash:p.sha256, thumbnailPath:p.thumbnailPath, capturedAt:p.capturedAt, timeSource:p.timeSource ?? null, ...timeEvidence(p), latitude:p.latitude, longitude:p.longitude, placeName:p.placeName, country:p.country, notes:p.notes})).sort((a,b) => a.id.localeCompare(b.id))});
}
async function prepare(trip: Trip, photos: Photo[], model: string, targets: string[]) {
  const selected = samplePhotos(photos, {targetPhotoIds:targets});
  const thumbs = await Promise.all(selected.map(async p => {
    const object = await storage().get(p.thumbnailPath);
    if (!object) throw new Error('A photo thumbnail is unavailable');
    const data = await object.arrayBuffer();
    if (data.byteLength > 8 * 1024 * 1024) throw new Error('A photo thumbnail is too large');
    const bytes = new Uint8Array(data);
    const mime = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg' : [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v) ? 'image/png' : null;
    if (!mime) throw new Error('A photo thumbnail has an unsupported format');
    return { id:p.id, bytes, mime, hash:await sha(data) };
  }));
  const fp = fingerprint(trip, photos, model, targets);
  const hash = await sha(new TextEncoder().encode(JSON.stringify({fp, thumbnails:thumbs.map(({id,hash})=>({id,hash}))})));
  return {fp, hash, selected, thumbs};
}
function responseText(response: ProviderResponse): string {
  return (response.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text' && typeof x.text === 'string').map(x => x.text).join('');
}
async function fail(id: string, message: string) {
  return mutateStore(s => { const job = s.jobs.find(x => x.id === id && x.accountId === defaultAccountId); if (job && (job.status === 'running' || job.status === 'queued')) { job.status='failed'; job.error=message; job.updatedAt=now(); job.durationMs=Date.now()-Date.parse(job.createdAt); } return job; });
}
async function complete(id: string, response: ProviderResponse) {
  const data = await readStore(), job = data.jobs.find(j => j.id === id && j.accountId === defaultAccountId) as CloudJob | undefined;
  if (!job || !['queued','running'].includes(job.status)) return job;
  if (response.status === 'failed' || response.status === 'cancelled' || response.status === 'incomplete') return fail(id, `AI request ${response.status}. Please retry.`);
  if (response.status !== 'completed') return job;
  try {
    const {trip, photos} = resolve(data, job);
    const prepared = await prepare(trip, photos, job.model, job.targetPhotoIds || []);
    if (prepared.hash !== job.inputHash) throw new Error('Photos or trip details changed during analysis. Please retry.');
    const result = validateSuggestion(JSON.parse(responseText(response)), prepared.selected);
    return await mutateStore(s => {
      const current = s.jobs.find(j => j.id === id && j.accountId === defaultAccountId) as CloudJob | undefined;
      if (!current || !['queued','running'].includes(current.status)) return current;
      const latest = resolve(s, current);
      if (fingerprint(latest.trip, latest.photos, current.model, current.targetPhotoIds || []) !== prepared.fp) { current.status='failed'; current.error='Photos or trip details changed during analysis. Please retry.'; }
      else {
        current.status='succeeded'; current.result=result; current.error=null;
        current.analyzedPhotoIds=prepared.selected.map(p=>p.id); current.totalPhotoCount=photos.length;
        if (response.usage && Number.isSafeInteger(response.usage.input_tokens) && Number.isSafeInteger(response.usage.output_tokens)) current.usage={inputTokens:response.usage.input_tokens!, cachedInputTokens:response.usage.input_tokens_details?.cached_tokens || 0, outputTokens:response.usage.output_tokens!};
      }
      current.updatedAt=now(); current.durationMs=Date.now()-Date.parse(current.createdAt); return current;
    });
  } catch { return fail(id, 'AI result was invalid or the photos changed. Please retry.'); }
}
async function requestProvider(path: string, init: RequestInit): Promise<ProviderResponse> {
  const key = settings().OPENAI_API_KEY;
  if (!key) throw new Error('AI is not configured');
  const response = await fetch(`https://api.openai.com/v1/responses${path}`, {...init, headers:{'Authorization':`Bearer ${key}`, 'Content-Type':'application/json', ...init.headers}});
  if (!response.ok) throw new Error(`AI provider request failed (HTTP ${response.status})`);
  return await response.json() as ProviderResponse;
}
async function submit(job: CloudJob, trip: Trip, photos: Photo[], prepared: Awaited<ReturnType<typeof prepare>>) {
  try {
    const {prompt} = buildModelInput(trip, photos, {targetPhotoIds:job.targetPhotoIds});
    const content: Array<Record<string, unknown>> = [{type:'input_text', text:prompt}];
    for (const thumb of prepared.thumbs) content.push({type:'input_image', image_url:`data:${thumb.mime};base64,${bytesToBase64(thumb.bytes)}`, detail:'low'});
    // Claim is persisted before this call. A lost response is never automatically retried, avoiding duplicate paid requests.
    const response = await requestProvider('', {method:'POST', headers:{'Idempotency-Key':job.id}, body:JSON.stringify({model:job.model, reasoning:{effort:'high'}, background:true, store:true, input:[{role:'user',content}], text:{format:{type:'json_schema', name:'travel_atlas_suggestion', strict:true, schema:suggestionSchema}}})});
    if (!response.id) throw new Error('AI provider did not return a response identifier');
    const saved = await mutateStore(s => { const j = s.jobs.find(x=>x.id===job.id && x.accountId===job.accountId) as CloudJob | undefined; if (j && j.status==='running') {j.responseId=response.id; j.updatedAt=now();} return j; });
    if (response.status === 'completed' || response.status === 'failed' || response.status === 'incomplete' || response.status === 'cancelled') return await complete(job.id,response);
    return saved;
  } catch { return fail(job.id, 'AI submission failed or its outcome is unknown. Please retry manually.'); }
}
async function create(request: Request) {
  const body = await request.json() as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request');
  const model = settings().ATLAS_MODEL;
  if (!settings().OPENAI_API_KEY || !model) throw new Error('AI is not configured');
  const store = await readStore();
  let trip: Trip, photos: Photo[], scope: CloudJob['scope'], tripId = '', targets: string[] = [];
  if ('photoIds' in body) {
    if (body.tripId || body.targetPhotoIds) throw new Error('Choose a trip or a recap scope');
    ({scope, trip, photos} = resolveRecapScope(store, defaultAccountId, {photoIds:body.photoIds, title:body.title}));
  } else {
    if (typeof body.tripId !== 'string' || !body.tripId.trim()) throw new Error('tripId is required');
    tripId=body.tripId.trim();
    ({trip, photos} = resolve(store, {accountId:defaultAccountId, tripId, targetPhotoIds:body.targetPhotoIds as string[] | undefined}));
    targets=targetsFor(photos, {targetPhotoIds:body.targetPhotoIds as string[] | undefined});
  }
  const prepared = await prepare(trip, photos, model, targets), createdAt=now(), id=crypto.randomUUID();
  const claim = await mutateStore(s => {
    const latest=resolve(s,{accountId:defaultAccountId,tripId,scope,targetPhotoIds:targets});
    if (fingerprint(latest.trip,latest.photos,model,targets)!==prepared.fp) throw new Error('Photos or trip details changed. Please retry.');
    const existing=s.jobs.find(j=>j.accountId===defaultAccountId && j.inputHash===prepared.hash && ['queued','running','succeeded'].includes(j.status));
    if (existing) return {job:existing as CloudJob, created:false};
    const job:CloudJob={id,accountId:defaultAccountId,tripId,scope,targetPhotoIds:targets,status:'running',model,provider,inputHash:prepared.hash,result:null,error:null,durationMs:null,createdAt,updatedAt:createdAt,submissionStartedAt:createdAt};
    s.jobs.push(job); return {job,created:true};
  });
  return claim.created ? await submit(claim.job,trip,photos,prepared) : claim.job;
}
async function poll(id: string) {
  const job=(await readStore()).jobs.find(j=>j.id===id && j.accountId===defaultAccountId) as CloudJob | undefined;
  if (!job) throw new Error('Not found');
  if (!['queued','running'].includes(job.status)) return job;
  if (!job.responseId) {
    if (Date.now()-Date.parse(job.submissionStartedAt || job.createdAt)>120_000) return fail(id,'AI submission was interrupted and its outcome is unknown. Please retry manually.');
    return job;
  }
  try { return await complete(id,await requestProvider(`/${encodeURIComponent(job.responseId)}`,{method:'GET'})); }
  catch (error) {
    if (error instanceof Error && /HTTP (401|403|404)\b/.test(error.message)) return fail(id, 'AI result is unavailable or access was denied. Please retry.');
    return job; // Transient polling failures are retryable; never submit another paid job automatically.
  }
}
export async function aiRoute(request: Request, path: string[]): Promise<Response> {
  try {
    if (path.length===2 && path[0]==='ai' && path[1]==='jobs' && request.method==='POST') return Response.json(await create(request));
    if (path.length===3 && path[0]==='ai' && path[1]==='jobs' && request.method==='GET') return Response.json(await poll(path[2]));
    return Response.json({error:'Not found'},{status:404});
  } catch(e) { return errorResponse(e); }
}
