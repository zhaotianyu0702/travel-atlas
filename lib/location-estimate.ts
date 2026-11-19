import { locationDistanceMeters, type LocationContext } from './location-context';
import type { LocationSuggestion, Photo } from './types';

type Coordinate = { latitude: number; longitude: number };
type Decision = { verdict: 'match' | 'different' | 'uncertain'; evidencePhotoIds: string[]; reason: string };

// Reject floating or malformed times, including dates that Date.parse would normalize.
function instant(photo: Photo): number | null {
  const value = photo.capturedAt;
  if (!value || (photo.timeSource !== 'user' && photo.timeMetadata?.capturedAt === value && !photo.timeMetadata.timezoneKnown)) return null;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/i.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0', zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (m < 1 || m > 12 || d < 1 || d > days || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (zone.toUpperCase() !== 'Z') {
    const offset = zone.slice(1).replace(':', '');
    if (Number(offset.slice(0, 2)) > 23 || Number(offset.slice(2)) > 59) return null;
  }
  const time = Date.parse(value.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(time) ? time : null;
}

function valid(c: Coordinate): boolean {
  return Number.isFinite(c.latitude) && Number.isFinite(c.longitude) && Math.abs(c.latitude) <= 90 && Math.abs(c.longitude) <= 180;
}

/** Interpolate only between independently observed, temporally bracketing anchors. */
export function estimateLocation(context: LocationContext): Coordinate | null {
  const anchors = context.anchors;
  if (!anchors || anchors.before.photoId === anchors.after.photoId || !valid(anchors.before) || !valid(anchors.after)) return null;
  const find = (id: string) => {
    const matches = context.photos.filter(p => p.id === id);
    return matches.length === 1 ? matches[0] : null;
  };
  const target = find(context.targetPhotoId), before = find(anchors.before.photoId), after = find(anchors.after.photoId);
  if (!target || !before || !after || target.id === before.id || target.id === after.id) return null;
  const observed = (p: Photo, c: Coordinate) => (p.confirmed || p.locationSource === 'exif' || p.locationSource === 'photos') && p.latitude === c.latitude && p.longitude === c.longitude && !p.deletedAt && p.accountId === target.accountId && p.tripId === target.tripId;
  if (!observed(before, anchors.before) || !observed(after, anchors.after)) return null;
  const t = instant(target), b = instant(before), a = instant(after);
  if (t === null || b === null || a === null || !(b < t && t < a) || locationDistanceMeters(anchors.before, anchors.after) > 1000) return null;
  const ratio = (t - b) / (a - b);
  const deltaLongitude = ((anchors.after.longitude - anchors.before.longitude + 540) % 360) - 180;
  const result = { latitude: anchors.before.latitude + (anchors.after.latitude - anchors.before.latitude) * ratio, longitude: ((anchors.before.longitude + deltaLongitude * ratio + 540) % 360) - 180 };
  return locationDistanceMeters(result, anchors.before) <= 1000 && locationDistanceMeters(result, anchors.after) <= 1000 ? result : null;
}

// Tight EXIF agreement can conflict with a cheap visual rejection when the camera turns in place.
export function hasTightLocationBracket(context:LocationContext,maxMeters=30,maxDurationMs=120_000):boolean {
  const a=context.anchors;
  if(!a||!estimateLocation(context)||locationDistanceMeters(a.before,a.after)>maxMeters) return false;
  const before=context.photos.find(p=>p.id===a.before.photoId), after=context.photos.find(p=>p.id===a.after.photoId);
  const b=before?instant(before):null, e=after?instant(after):null;
  return b!==null && e!==null && e-b<=maxDurationMs;
}

export function estimateSuggestion(context: LocationContext, target: Photo, decision: Decision): LocationSuggestion | null {
  const anchors = context.anchors;
  if (target.id !== context.targetPhotoId || !anchors || decision.verdict !== 'match' || !Array.isArray(decision.evidencePhotoIds) || decision.evidencePhotoIds.length !== 2 || new Set(decision.evidencePhotoIds).size !== 2 || ![anchors.before.photoId, anchors.after.photoId].every(id => decision.evidencePhotoIds.includes(id))) return null;
  const coordinate = estimateLocation(context);
  if (!coordinate) return null;
  return { ...coordinate, placeName: target.placeName, country: target.country, confidence: 'medium', precision: 'locality', reason: 'Approximate location interpolated between two nearby photos.', supportingPhotoIds: [anchors.before.photoId, anchors.after.photoId], evidence: 'time-series' };
}
