import { editRecapCut } from './recap-cut';
import type { Store } from './types';

// Called inside mutateStore: the callback may be retried after a revision conflict.
export function removeTrip(store: Store, accountId: string, tripId: string): void {
  if (!store.trips.some(trip => trip.id === tripId && trip.accountId === accountId)) throw new Error('Not found');
  const removed = store.photos.filter(photo => photo.accountId === accountId && photo.tripId === tripId);
  const ids = new Set(removed.map(photo => photo.id));
  const foreignTrip = store.trips.some(trip => trip.id === tripId && trip.accountId !== accountId);
  store.trips = store.trips.filter(trip => !(trip.id === tripId && trip.accountId === accountId));
  store.photos = store.photos.filter(photo => !(photo.tripId === tripId && photo.accountId === accountId));
  store.recaps = store.recaps.filter(recap => {
    if (recap.accountId !== accountId) return true;
    const touched = recap.tripIds.includes(tripId) || recap.photoIds.some(id => ids.has(id));
    if (!touched) return true;
    recap.tripIds = recap.tripIds.filter(id => id !== tripId);
    recap.photoIds = recap.photoIds.filter(id => !ids.has(id));
    if (!recap.tripIds.length && !recap.photoIds.length) return false;
    recap.cut = editRecapCut(recap.cut, recap.photoIds);
    recap.updatedAt = new Date().toISOString();
    return true;
  });
  store.jobs = store.jobs.filter(job => job.accountId !== accountId || (job.tripId !== tripId && !job.scope?.photoIds.some(id => ids.has(id)) && !job.targetPhotoIds?.some(id => ids.has(id)) && !job.analyzedPhotoIds?.some(id => ids.has(id))));
  if (store.recapCutJobs) store.recapCutJobs = store.recapCutJobs.filter(job => job.accountId !== accountId || (job.tripId !== tripId && !job.photoIds.some(id => ids.has(id))));
  // Legacy jobs have no account field. A colliding foreign trip makes ownership ambiguous.
  if (!foreignTrip) {
    if (store.locationJobs) store.locationJobs = store.locationJobs.filter(job => job.tripId !== tripId && !ids.has(job.photoId));
    if (store.highlightJobs) store.highlightJobs = store.highlightJobs.filter(job => job.tripId !== tripId);
    if (store.routeRequests) store.routeRequests = store.routeRequests.filter(job => job.tripId !== tripId);
  }
  const referenced = new Set(store.photos.flatMap(photo => [photo.originalPath, photo.thumbnailPath]));
  const candidates = removed.flatMap(photo => [photo.originalPath, photo.thumbnailPath]).filter(path => path && !referenced.has(path));
  store.pendingMediaDeletes = [...new Set([...(store.pendingMediaDeletes ?? []), ...candidates])];
}
