import type { Photo } from './types';

export function nullableIsoDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) throw new Error('Invalid date');
  const date = value.slice(0, 10);
  if (!Number.isFinite(Date.parse(value)) || new Date(date + 'T00:00:00Z').toISOString().slice(0,10) !== date) throw new Error('Invalid date');
  return value;
}

export function applyPhotoPatch(photo: Photo, body: Record<string, unknown>): Photo {
  const updated = { ...photo };
  if ('favorite' in body) { if (typeof body.favorite !== 'boolean') throw new Error('Invalid favorite'); updated.favorite = body.favorite; }
  if ('capturedAt' in body) {
    const date = nullableIsoDate(body.capturedAt);
    if (date !== photo.capturedAt) { updated.capturedAt = date; updated.timeSource = date === null ? 'unknown' : 'user'; }
  }
  for (const key of ['placeName','country','notes'] as const) if (key in body) {
    if (typeof body[key] !== 'string') throw new Error(`Invalid ${key}`);
    updated[key] = body[key];
  }
  if ('latitude' in body || 'longitude' in body) {
    const latitude = 'latitude' in body ? body.latitude : photo.latitude;
    const longitude = 'longitude' in body ? body.longitude : photo.longitude;
    if (!((latitude === null && longitude === null) || (typeof latitude === 'number' && Number.isFinite(latitude) && Math.abs(latitude) <= 90 && typeof longitude === 'number' && Number.isFinite(longitude) && Math.abs(longitude) <= 180))) throw new Error('Latitude and longitude must be a valid pair');
    if (latitude !== photo.latitude || longitude !== photo.longitude) { updated.latitude = latitude; updated.longitude = longitude; updated.locationSource = latitude === null ? 'unknown' : 'user'; }
  }
  if (updated.placeName !== photo.placeName || updated.country !== photo.country) updated.locationSource = 'user';
  if ('confirmed' in body) { if (typeof body.confirmed !== 'boolean') throw new Error('Invalid confirmed value'); updated.confirmed = body.confirmed; }
  Object.assign(photo, updated);
  return photo;
}

import type { Store } from './types';
export function updatePhotoBatch(store: Store, accountId: string, photoIds: unknown, patch: unknown): Photo[] {
  if (!Array.isArray(photoIds) || !photoIds.length || photoIds.length > 500 || !photoIds.every(x => typeof x === 'string' && x.length > 0) || new Set(photoIds).size !== photoIds.length) throw new Error('Invalid photo IDs');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid patch');
  const input = patch as Record<string, unknown>, keys = Object.keys(input), allowed = ['favorite','tripId','placeName','country','capturedAt'];
  if (!keys.length || keys.some(k => !allowed.includes(k))) throw new Error('Invalid batch fields');
  const photos = photoIds.map(id => store.photos.find(p => p.id === id && p.accountId === accountId && !p.deletedAt));
  if (photos.some(p => !p)) throw new Error('Not found');
  if ('tripId' in input && (typeof input.tripId !== 'string' || !store.trips.some(t => t.id === input.tripId && t.accountId === accountId))) throw new Error('Invalid destination trip');
  // Validate every proposed change before mutating any shared record.
  const edits = (photos as Photo[]).map(photo => { const clone = {...photo}; applyPhotoPatch(clone, input); if ('tripId' in input) clone.tripId = input.tripId as string; return clone; });
  for (let i=0;i<edits.length;i++) {
    const original = photos[i]!; const edited = edits[i];
    if (original.tripId !== edited.tripId) { const old = store.trips.find(t => t.id === original.tripId && t.accountId === accountId); if (old?.coverPhotoId === original.id) old.coverPhotoId = null; }
    Object.assign(original, edited);
  }
  return photos as Photo[];
}
export function softDeletePhoto(store: Store, accountId: string, id: string): Photo {
 const p=store.photos.find(x=>x.id===id && x.accountId===accountId && !x.deletedAt); if(!p) throw new Error('Not found');
 p.deletedAt=new Date().toISOString(); const trip=store.trips.find(t=>t.id===p.tripId && t.accountId===accountId); if(trip?.coverPhotoId===p.id) trip.coverPhotoId=null; return p;
}
export function restorePhoto(store: Store, accountId: string, id: string): Photo {
 const p=store.photos.find(x=>x.id===id && x.accountId===accountId && !!x.deletedAt); if(!p) throw new Error('Not found');
 if (!store.trips.some(t=>t.id===p.tripId && t.accountId===accountId)) throw new Error('Original trip no longer exists'); p.deletedAt=null; return p;
}
export function setTripCover(store: Store, accountId: string, tripId: string, photoId: unknown): void {
 const trip=store.trips.find(t=>t.id===tripId && t.accountId===accountId); if(!trip) throw new Error('Not found');
 if(photoId!==null && (typeof photoId!=='string' || !store.photos.some(p=>p.id===photoId && p.accountId===accountId && p.tripId===tripId && !p.deletedAt))) throw new Error('Cover must be an active photo in this trip'); trip.coverPhotoId=photoId as string|null;
}
