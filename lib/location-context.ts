import type { AiSuggestion, Photo } from './types';

type PlaceCandidate = AiSuggestion['placeCandidates'][number];
type Coordinate = { latitude: number; longitude: number };
export interface LocationContextMetadata {
  id: string;
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  locationSource: Photo['locationSource'];
  confirmed: boolean;
}
export interface LocationContext {
  targetPhotoId: string;
  photos: Photo[];
  metadata: LocationContextMetadata[];
  anchors: { before: Coordinate & { photoId: string }; after: Coordinate & { photoId: string } } | null;
}
export interface LocationEvidence { distinctiveVisualVerified: boolean }
export interface GatedLocationCandidate {
  candidate: PlaceCandidate;
  provenance: 'verified-visual' | 'bracketing-context' | 'unresolved';
  approximate: boolean;
}

const WINDOW_MS = 25 * 60_000;
const MAX_DISTANCE_M = 1000;
function coordinate(p: Photo): Coordinate | null {
  const {latitude, longitude} = p;
  if (!(p.confirmed || p.locationSource === 'exif' || p.locationSource === 'photos')) return null;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return {latitude, longitude};
}
function instant(p: Photo): number | null {
  const value = p.capturedAt;
  if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(value.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))) return null;
  if (p.timeSource !== 'user' && p.timeMetadata?.capturedAt === value && !p.timeMetadata.timezoneKnown) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
export function locationDistanceMeters(a: Coordinate, b: Coordinate): number {
  const radians = Math.PI / 180;
  const dLat = (b.latitude-a.latitude)*radians, dLon = (b.longitude-a.longitude)*radians;
  const h = Math.sin(dLat/2)**2 + Math.cos(a.latitude*radians)*Math.cos(b.latitude*radians)*Math.sin(dLon/2)**2;
  return 2*6371000*Math.asin(Math.min(1,Math.sqrt(h)));
}
/** Only compare explicit instants: floating wall times do not establish elapsed time. */
export function buildLocationContext(target: Photo, photos: Photo[]): LocationContext {
  const t = instant(target);
  const seen = new Set<string>([target.id]);
  const eligible = photos.filter(p => {
    if (p.id === target.id || p.tripId !== target.tripId || p.accountId !== target.accountId || p.deletedAt || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  }).map(p => ({photo:p, time:instant(p)})).filter((p): p is {photo:Photo;time:number} => t !== null && p.time !== null && Math.abs(p.time-t) <= WINDOW_MS && p.time !== t);
  const before = eligible.filter(p=>p.time<t!).sort((a,b)=>b.time-a.time || a.photo.id.localeCompare(b.photo.id));
  const after = eligible.filter(p=>p.time>t!).sort((a,b)=>a.time-b.time || a.photo.id.localeCompare(b.photo.id));
  // Reserve up to two per side, then fill remaining slots with the closest other images.
  const chooseSide = (side:typeof before) => {
    const observed=side.find(value=>coordinate(value.photo));
    return observed ? [observed,...side.filter(value=>value!==observed).slice(0,1)] : side.slice(0,2);
  };
  const chosen = [...chooseSide(before),...chooseSide(after)];
  if (chosen.length < 4) for (const p of [...eligible].sort((a,b)=>Math.abs(a.time-t!)-Math.abs(b.time-t!) || a.photo.id.localeCompare(b.photo.id))) {
    if (!chosen.includes(p)) chosen.push(p);
    if (chosen.length === 4) break;
  }
  const sampled = [target,...chosen.sort((a,b)=>a.time-b.time || a.photo.id.localeCompare(b.photo.id)).map(p=>p.photo)];
  const metadata = sampled.map(p => { const c=coordinate(p); return {id:p.id,capturedAt:p.capturedAt,latitude:c?.latitude ?? null,longitude:c?.longitude ?? null,locationSource:p.locationSource,confirmed:p.confirmed}; });
  // Anchor selection is confined to attached images; any conflicting located image blocks support.
  const selectedBefore=before.filter(p=>sampled.includes(p.photo));
  const selectedAfter=after.filter(p=>sampled.includes(p.photo));
  const b=selectedBefore.find(p=>coordinate(p.photo));
  const a=selectedAfter.find(p=>coordinate(p.photo));
  const bc=b && coordinate(b.photo), ac=a && coordinate(a.photo);
  const located=eligible.map(p=>coordinate(p.photo)).filter((c): c is Coordinate=>c!==null);
  const anchors = b && a && bc && ac && locationDistanceMeters(bc,ac)<=MAX_DISTANCE_M && located.every(c=>locationDistanceMeters(c,bc)<=MAX_DISTANCE_M && locationDistanceMeters(c,ac)<=MAX_DISTANCE_M)
    ? {before:{photoId:b.photo.id,...bc},after:{photoId:a.photo.id,...ac}} : null;
  return {targetPhotoId:target.id,photos:sampled,metadata,anchors};
}

/** The caller must independently verify visual evidence; model self-classification is not verification. */
export function gateLocationCandidate(candidate: PlaceCandidate, target: Photo, context: LocationContext, evidence: LocationEvidence): GatedLocationCandidate {
  const validCoordinates = typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number' && Number.isFinite(candidate.latitude) && Number.isFinite(candidate.longitude) && Math.abs(candidate.latitude)<=90 && Math.abs(candidate.longitude)<=180;
  const proposed = validCoordinates ? {latitude:candidate.latitude!,longitude:candidate.longitude!} : null;
  const mediumOrHigher = candidate.confidence === 'medium' || candidate.confidence === 'high';
  const precise = candidate.precision === 'locality' || candidate.precision === 'landmark';
  const corroborated = !!(proposed && context.anchors && locationDistanceMeters(proposed,context.anchors.before)<=MAX_DISTANCE_M && locationDistanceMeters(proposed,context.anchors.after)<=MAX_DISTANCE_M);
  const eligible = candidate.photoId === target.id && context.targetPhotoId === target.id && mediumOrHigher && precise && proposed && (evidence.distinctiveVisualVerified || corroborated);
  if (!eligible) return {candidate:{...candidate,photoId:target.id,placeName:target.placeName,country:target.country,latitude:null,longitude:null,confidence:'low',precision:'unknown',supportingPhotoIds:[],reason:'Insufficient independently verified evidence to identify this location.'},provenance:'unresolved',approximate:true};
  const visual=evidence.distinctiveVisualVerified;
  return {candidate:{...candidate,placeName:target.placeName || candidate.placeName,country:target.country || candidate.country,precision:visual ? candidate.precision : 'locality',supportingPhotoIds:visual ? [] : [context.anchors!.before.photoId,context.anchors!.after.photoId]},provenance:visual?'verified-visual':'bracketing-context',approximate:true};
}
