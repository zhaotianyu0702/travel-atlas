import type { Photo, Store } from './types';

// The key is shared with recap-cut generation; it binds an observation to the source image.
export const recapImageKey = (photo: Photo, model: string) => JSON.stringify(['recap-observation-v1', model, photo.id, photo.sha256, photo.thumbnailPath]);

/** Return only descriptions backed by a successful batch for the current owner's current image. */
export function recapVisualEvidence(photos: Photo[], jobs: NonNullable<Store['recapCutJobs']>, accountId: string): Map<string, string> {
  const byId = new Map(photos.filter(p => p.accountId === accountId && !p.deletedAt && p.sha256 && p.thumbnailPath).map(p => [p.id, p]));
  const selected = new Map<string, {description:string; createdAt:number}>();
  for (const job of jobs) {
    if (job.accountId !== accountId || job.status !== 'succeeded' || typeof job.model !== 'string' || !job.model || !Array.isArray(job.batches) || !Array.isArray(job.photoIds)) continue;
    // Older jobs have no imageKeys. Their original source fingerprint can still prove identity.
    let legacyPhotos: unknown = null;
    if (job.batches.some(batch => !batch.imageKeys && batch.observations?.length)) {
      try { legacyPhotos = JSON.parse(job.source).photos; } catch { /* No verifiable legacy fingerprint. */ }
    }
    const legacy = new Map<string, unknown[]>();
    if (Array.isArray(legacyPhotos)) for (const row of legacyPhotos) if (Array.isArray(row) && typeof row[0] === 'string') legacy.set(row[0], row);
    const jobIds = new Set(job.photoIds);
    for (const batch of job.batches) {
      if (batch.status !== 'succeeded' || !Array.isArray(batch.photoIds) || !Array.isArray(batch.observations)) continue;
      const batchIds = new Set(batch.photoIds);
      for (const observation of batch.observations) {
        if (!observation || typeof observation.photoId !== 'string' || typeof observation.description !== 'string') continue;
        const photo = byId.get(observation.photoId);
        if (!photo || photo.tripId !== job.tripId || !jobIds.has(photo.id) || !batchIds.has(photo.id)) continue;
        const row = legacy.get(photo.id);
        const verified = batch.imageKeys ? batch.imageKeys[photo.id] === recapImageKey(photo, job.model) : !!row && row[1] === photo.sha256 && row[2] === photo.thumbnailPath;
        if (!verified) continue;
        const description = observation.description.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240).trim();
        if (!description) continue;
        const createdAt = Number.isFinite(job.createdAt) ? job.createdAt : 0;
        if (!selected.has(photo.id) || createdAt > selected.get(photo.id)!.createdAt) selected.set(photo.id, {description, createdAt});
      }
    }
  }
  return new Map([...selected].map(([id, value]) => [id, value.description]));
}
