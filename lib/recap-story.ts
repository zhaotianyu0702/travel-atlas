import type { Photo, Recap } from "./types";
import { editRecapCut, type RecapBeat } from "./recap-cut";
import { photoCaptureDate } from "./photo-time";
import { recapCaptureOrder } from "./recap-guidance";
import { recapCoastAt, recapCountryAt } from "./recap-map";

export interface RecapScenePhoto {
  id: string;
  src: string;
  width: number;
  height: number;
  date: string;
  label: string;
  point: [number, number] | null;
}
export interface RecapScene {
  recap: Recap;
  photos: RecapScenePhoto[];
  width: number;
  height: number;
  snapshotHash: string;
  beats: RecapBeat[];
  mapContext?: [number, number];
}

export function recapFrameCopy(scene: RecapScene, photoIndex: number, beat?: RecapBeat, opening = photoIndex === 0) {
  const cut = scene.recap.cut;
  if (cut?.presentation) return {
    headline: cut.presentation.text === "none" ? "" : (beat ?? scene.beats.find(item => item.photoIds.includes(scene.photos[photoIndex]?.id)))?.caption ?? "",
    date: "",
    place: "",
  };
  const photo = scene.photos[photoIndex];
  return {
    headline: opening ? scene.recap.title : beat?.caption || (cut?.kind === "moments" ? "" : photo?.label ?? ""),
    date: !cut || cut.kind === "journey" ? photo?.date ?? "" : "",
    place: opening ? photo?.label ?? "" : "",
  };
}

function distanceKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (a[1] - b[1]) * rad, dLon = (a[0] - b[0]) * rad;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, value)));
}

/** Fill missing Places captions only from nearby accepted evidence or matching time brackets. */
function fillPlaceCaptions(cut: NonNullable<Recap['cut']>, photos: Photo[]) {
  if (cut.presentation?.text !== 'places') return cut;
  const byId = new Map(photos.map(photo => [photo.id, photo]));
  const captions = new Map<string, string>();
  for (const beat of cut.beats) {
    // A multi-photo caption does not establish which photo provided its evidence.
    if (beat.photoIds.length === 1 && beat.caption.trim()) captions.set(beat.photoIds[0], beat.caption.trim());
  }
  const acceptedLabel = (p: Photo) => (p.confirmed || ['exif', 'photos', 'user'].includes(p.locationSource))
    ? [p.placeName.replace(/^near\s+/i, '').trim(), p.country.trim()].filter(Boolean).join(', ') : '';
  const anchors = photos.flatMap(p => {
    const label = captions.get(p.id) || acceptedLabel(p);
    return label ? [{ photo: p, label, point: acceptedPoint(p) }] : [];
  });
  const infer = (p: Photo): string => {
    const direct = captions.get(p.id) || acceptedLabel(p);
    if (direct) return direct;
    const point = acceptedPoint(p);
    if (point) {
      const nearby = anchors.filter(a => a.photo.tripId === p.tripId && a.point && distanceKm(point, a.point) <= 1);
      const labels = [...new Set(nearby.map(a => a.label.toLocaleLowerCase()))];
      if (labels.length === 1) return nearby[0].label;
      if (labels.length > 1) {
        const countries = nearby.map(a => a.photo.country.trim() || (a.point ? recapCountryAt(a.point) : '')).filter(Boolean);
        if (countries.length === nearby.length && new Set(countries.map(c => c.toLocaleLowerCase())).size === 1) return countries[0];
        return '';
      }
      const country = recapCountryAt(point);
      if (country) return country;
      const coast = recapCoastAt(point);
      return coast ? `${coast} · Coast` : '';
    }
    const time = recapCaptureOrder(p);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(time)) return '';
    const millis = Date.parse(`${time}Z`);
    if (!Number.isFinite(millis)) return '';
    const timed = anchors.flatMap(a => {
      const value = recapCaptureOrder(a.photo);
      if (a.photo.tripId !== p.tripId || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return [];
      const delta = Date.parse(`${value}Z`) - millis;
      return Number.isFinite(delta) && Math.abs(delta) <= 30 * 60 * 1000 ? [{ ...a, delta }] : [];
    });
    const before = timed.filter(a => a.delta < 0).sort((a, b) => b.delta - a.delta)[0];
    const after = timed.filter(a => a.delta > 0).sort((a, b) => a.delta - b.delta)[0];
    return before && after && before.label.toLocaleLowerCase() === after.label.toLocaleLowerCase() ? before.label : '';
  };
  return { ...cut, beats: cut.beats.map(beat => {
    if (beat.caption.trim()) return beat;
    const labels = beat.photoIds.map(id => { const photo = byId.get(id); return photo ? infer(photo) : ''; });
    const unique = [...new Set(labels.map(label => label.toLocaleLowerCase()))];
    if (labels.every(Boolean) && unique.length === 1) return { ...beat, caption: labels[0] };
    const countries = beat.photoIds.map(id => {
      const photo = byId.get(id);
      const point = photo && acceptedPoint(photo);
      return point ? recapCountryAt(point) : '';
    });
    const sharedCountry = countries[0] && countries.every(country => country === countries[0]) ? countries[0] : '';
    return { ...beat, caption: sharedCountry || 'Location unrecorded' };
  }) };
}

function acceptedPoint(photo: Photo): [number, number] | null {
  const { latitude, longitude } = photo;
  const accepted = photo.confirmed || photo.locationSource === "exif" ||
    photo.locationSource === "photos" || photo.locationSource === "user";
  return accepted && typeof latitude === "number" && typeof longitude === "number" &&
    Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? [longitude, latitude] : null;
}

/** Only export the rounded center of the trip area when the selected photos lack GPS. */
function recapMapContext(photos: Photo[], tripIds: ReadonlySet<string>): [number, number] | undefined {
  const points = photos.flatMap(photo => {
    const point = tripIds.has(photo.tripId) && acceptedPoint(photo);
    return point ? [point] : [];
  });
  if (!points.length) return undefined;
  const radians = Math.PI / 180;
  const sum = points.reduce(([x, y, lat], [longitude, latitude]) =>
    [x + Math.cos(longitude * radians), y + Math.sin(longitude * radians), lat + latitude], [0, 0, 0]);
  if (Math.hypot(sum[0], sum[1]) / points.length < .2) return undefined;
  return [Math.round(Math.atan2(sum[1], sum[0]) / radians), Math.round(sum[2] / points.length)];
}

/** Public-facing scene data contains only day-level dates and coarse, accepted locations. */
export function buildRecapScene(
  recap: Recap,
  photos: Photo[],
  snapshotHash: string,
): RecapScene {
  const owned = photos.filter(p => p.accountId === recap.accountId && !p.deletedAt);
  const byId = new Map(owned.map(p => [p.id, p]));
  const tripIds = new Set(recap.tripIds);
  const selected = recap.photoIds.flatMap((id) => {
    const p = byId.get(id);
    if (!p) return [];
    tripIds.add(p.tripId);
    const accepted =
      p.locationSource === "exif" ||
      p.locationSource === "photos" ||
      p.locationSource === "user" ||
      p.confirmed;
    const coordinates = acceptedPoint(p);
    const point: [number, number] | null = coordinates
      ? [Math.round(coordinates[0] * 10) / 10, Math.round(coordinates[1] * 10) / 10] : null;
    const day = photoCaptureDate(p);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    const parsed = match ? new Date(`${day}T00:00:00Z`) : null;
    const date =
      parsed &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === day
        ? parsed.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
          })
        : "";
    return [
      {
        id: p.id,
        src: `/api/media/${encodeURIComponent(p.id)}?variant=${p.storageMode === "optimized" && p.mimeType === "image/jpeg" ? "original" : "thumb"}`,
        width: p.width,
        height: p.height,
        date,
        label: accepted
          ? [p.placeName.replace(/^near\s+/i, ""), p.country]
              .filter(Boolean)
              .join(", ")
          : "",
        point,
      },
    ];
  });
  const edited = editRecapCut(recap.cut, selected.map(photo => photo.id));
  const cut = edited ? fillPlaceCaptions(edited, owned) : null;
  const ordered = cut ? cut.beats.flatMap(beat => beat.photoIds.map(id => selected.find(photo => photo.id === id)!)) : selected;
  const mapContext = ordered.some(photo => photo.point) ? undefined : recapMapContext(owned, tripIds);
  return { recap: { ...recap, cut }, photos: ordered, beats: cut?.beats ?? [], width: 1920, height: 1080, snapshotHash, ...(mapContext ? { mapContext } : {}) };
}

/** Fit coarse positions into an inset; unwrap longitudes to avoid a route across the world at the date line. */
export function projectRecapPoints(
  photos: RecapScenePhoto[],
  width = 240,
  height = 130,
): ([number, number] | null)[] {
  let last: number | undefined;
  const unwrapped = photos.map((p) => {
    if (!p.point) return null;
    let [lon, lat] = p.point;
    if (last !== undefined) {
      while (lon - last > 180) lon -= 360;
      while (lon - last < -180) lon += 360;
    }
    last = lon;
    return [lon, lat] as [number, number];
  });
  const points = unwrapped.filter((p): p is [number, number] => p !== null);
  if (!points.length) return unwrapped;
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => -p[1]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const scale = Math.min(
    (width - 32) / Math.max(maxX - minX, 1),
    (height - 32) / Math.max(maxY - minY, 1),
  );
  return unwrapped.map((p) =>
    p
      ? [
          width / 2 + (p[0] - (minX + maxX) / 2) * scale,
          height / 2 + (-p[1] - (minY + maxY) / 2) * scale,
        ]
      : null,
  );
}
