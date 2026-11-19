import type { Photo, Store, Trip } from './types';

export interface RecapAiScope { photoIds: string[]; title: string }

/** Resolve the requested selection before any thumbnail is read or sent to a model. */
export function resolveRecapScope(store: Store, accountId: string, input: {photoIds: unknown; title?: unknown}): {scope: RecapAiScope; trip: Trip; photos: Photo[]} {
  const ids = input.photoIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Choose between 1 and 1000 distinct photos');
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.trim().length > 200)) throw new Error('Invalid recap title');
  const scope = {photoIds: [...ids].sort() as string[], title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Travel highlights'};
  const photos = scope.photoIds.map(id => store.photos.find(p => p.id === id && p.accountId === accountId && !p.deletedAt));
  if (photos.some(p => !p)) throw new Error('A selected photo is unavailable in this profile');
  const owned = photos as Photo[];
  const trips = [...new Set(owned.map(p => p.tripId))].map(id => store.trips.find(t => t.id === id && t.accountId === accountId));
  if (trips.some(t => !t)) throw new Error('A selected trip is unavailable in this profile');
  const context = (trips as Trip[]).map(t => ({title: t.title, notes: t.notes, startDate: t.startDate, endDate: t.endDate, photoIds: owned.filter(p => p.tripId === t.id).map(p => p.id)}));
  const trip: Trip = {id: 'recap-scope', accountId, title: scope.title, notes: 'This is a selected recap scope, not a single journey. Apply each trip remark only to its listed photo IDs. Do not assume the earliest and latest dated photo bound any undated photo. Per-trip user context: '+JSON.stringify(context), startDate:null, endDate:null, createdAt:'', updatedAt:''};
  return {scope, trip, photos: owned};
}
