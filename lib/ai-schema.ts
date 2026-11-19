import type { AiSuggestion, Photo } from './types';

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const confidence = { type: 'string', enum: ['low', 'medium', 'high'] };
const date = { type: ['string', 'null'] };
export const suggestionSchema = {
  type: 'object', additionalProperties: false,
  required: ['title', 'summary', 'highlights', 'selectedPhotoIds', 'groups', 'placeCandidates', 'timeCandidates', 'issues'],
  properties: {
    title: string, summary: string, highlights: strings, selectedPhotoIds: strings,
    groups: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'photoIds', 'reason'], properties: { name: string, photoIds: strings, reason: string } } },
    placeCandidates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['photoId', 'placeName', 'country', 'latitude', 'longitude', 'confidence', 'reason', 'precision', 'supportingPhotoIds'], properties: { photoId: string, placeName: string, country: string, latitude: { type: ['number', 'null'] }, longitude: { type: ['number', 'null'] }, confidence, reason: string, precision: {type:'string', enum:['country','region','locality','landmark','unknown']}, supportingPhotoIds:strings } } },
    timeCandidates: {type:'array', items:{type:'object', additionalProperties:false, required:['photoId','dateFrom','dateTo','confidence','reason','supportingPhotoIds'], properties:{photoId:string, dateFrom:date, dateTo:date, confidence, reason:string, supportingPhotoIds:strings}}},
    issues: {type:'array', items:{type:'object', additionalProperties:false, required:['photoId','kind','message'], properties:{photoId:string, kind:{type:'string',enum:['no-subject','blurred','missing-location','missing-time','conflicting-context','insufficient-evidence']}, message:string}}}
  }
};
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === 'string' && x.length <= 4000;
const strArray = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 100 && x.every(str);
const validDate = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x;
export function validateSuggestion(input: unknown, photos: Photo[]): AiSuggestion {
  if (!object(input) || !str(input.title) || !str(input.summary) || !strArray(input.highlights) || !strArray(input.selectedPhotoIds) || !Array.isArray(input.groups) || !Array.isArray(input.placeCandidates) || !Array.isArray(input.timeCandidates) || !Array.isArray(input.issues) || input.groups.length > 100 || input.placeCandidates.length > photos.length || input.timeCandidates.length > photos.length || input.issues.length > photos.length * 6) throw new Error('Invalid AI suggestion structure');
  const byId = new Map(photos.map(p => [p.id, p]));
  const ids = (v: unknown): v is string[] => strArray(v) && v.every(id => byId.has(id)) && new Set(v).size === v.length;
  const neighbors = (v:unknown, id:string) => ids(v) && !v.includes(id);
  const validConfidence = (v:unknown) => typeof v === 'string' && ['low','medium','high'].includes(v);
  if (!ids(input.selectedPhotoIds)) throw new Error('AI suggestion references an unknown photo');
  for (const g of input.groups) if (!object(g) || !str(g.name) || !str(g.reason) || !ids(g.photoIds)) throw new Error('Invalid AI group or photo reference');
  const seen = new Set<string>();
  for (const c of input.placeCandidates) {
    if (!object(c) || !str(c.photoId) || !byId.has(c.photoId) || seen.has(c.photoId) || !str(c.placeName) || !str(c.country) || !str(c.reason) || !validConfidence(c.confidence) || !['country','region','locality','landmark','unknown'].includes(String(c.precision)) || !neighbors(c.supportingPhotoIds,c.photoId)) throw new Error('Invalid AI place candidate or supporting photo reference');
    const photo = byId.get(c.photoId)!;
    if (photo.latitude !== null || photo.longitude !== null) throw new Error('Place candidates must refer to photos with unknown GPS');
    if ((photo.placeName && c.placeName !== photo.placeName) || (photo.country && c.country !== photo.country)) throw new Error('Place candidate conflicts with recorded place or country');
    if (!((c.latitude === null && c.longitude === null) || (typeof c.latitude === 'number' && Number.isFinite(c.latitude) && c.latitude >= -90 && c.latitude <= 90 && typeof c.longitude === 'number' && Number.isFinite(c.longitude) && c.longitude >= -180 && c.longitude <= 180))) throw new Error('Invalid AI candidate coordinates');
    if (c.precision === 'unknown' && (c.latitude !== null || c.longitude !== null)) throw new Error('Unknown precision requires null coordinates');
    seen.add(c.photoId);
  }
  seen.clear();
  for (const c of input.timeCandidates) {
    if (!object(c) || !str(c.photoId) || !byId.has(c.photoId) || seen.has(c.photoId) || !str(c.reason) || !validConfidence(c.confidence) || !neighbors(c.supportingPhotoIds,c.photoId)) throw new Error('Invalid AI time candidate or supporting photo reference');
    if (byId.get(c.photoId)!.capturedAt != null) throw new Error('Time candidates require a missing recorded time');
    if (!((c.dateFrom === null && c.dateTo === null) || (validDate(c.dateFrom) && validDate(c.dateTo) && c.dateFrom <= c.dateTo))) throw new Error('Invalid AI date interval');
    seen.add(c.photoId);
  }
  for (const issue of input.issues) if (!object(issue) || !str(issue.photoId) || !byId.has(issue.photoId) || !str(issue.message) || !['no-subject','blurred','missing-location','missing-time','conflicting-context','insufficient-evidence'].includes(String(issue.kind))) throw new Error('Invalid AI issue or photo reference');
  const result = input as unknown as AiSuggestion;
  const unresolved = new Set((result.issues ?? []).filter(i => i.kind === 'insufficient-evidence').map(i => i.photoId));
  const placeCandidates = result.placeCandidates.map(candidate => {
    const photo = byId.get(candidate.photoId)!;
    if (candidate.precision === 'unknown' || unresolved.has(candidate.photoId)) {
      return { ...candidate, placeName: photo.placeName, country: photo.country, latitude: null, longitude: null, precision: 'unknown' as const, confidence: 'low' as const, reason: unresolved.has(candidate.photoId) ? 'The available evidence cannot establish a reliable location.' : candidate.reason };
    }
    if (candidate.confidence === 'low' || candidate.precision === 'country' || candidate.precision === 'region') {
      if (!candidate.placeName.trim() && !candidate.country.trim()) {
        return { ...candidate, latitude: null, longitude: null, precision: 'unknown' as const, confidence: 'low' as const };
      }
      return { ...candidate, latitude: null, longitude: null };
    }
    return candidate;
  });
  for (const id of unresolved) {
    const photo = byId.get(id)!;
    if (photo.latitude === null && photo.longitude === null && !placeCandidates.some(c => c.photoId === id)) {
      placeCandidates.push({photoId:id, placeName:photo.placeName, country:photo.country, latitude:null, longitude:null, precision:'unknown', confidence:'low', reason:'The available evidence cannot establish a reliable location.', supportingPhotoIds:[]});
    }
  }
  return { ...result, placeCandidates };
}
