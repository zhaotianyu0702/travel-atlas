import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { Photo } from './types';

type Place = { name: string; kind: string; lat: number; lon: number };
type Tile = { x: number; y: number; key: string };
const zoom = 8;
const tileCount = 2 ** zoom;
const tileCache = new Map<string, Promise<Place[]>>();
let templatePromise: Promise<string> | undefined;

function countryName(value: string): string {
  const normalized = value.trim();
  if (/^[a-z]{2}$/i.test(normalized)) {
    try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(normalized.toUpperCase()) ?? normalized; } catch { /* Keep the original value. */ }
  }
  return normalized;
}

const countryNames = (() => {
  const names = new Set<string>();
  try {
    const regions = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = regions.of(code);
      if (name && name !== code) names.add(name.toLocaleLowerCase());
    }
  } catch { /* Matching the photo's own country still works. */ }
  return names;
})();

function storedPlace(photo: Photo): string {
  const name = photo.placeName.trim().replace(/^near\s+/i, '').trim();
  const lower = name.toLocaleLowerCase();
  const country = photo.country.trim().toLocaleLowerCase();
  const expandedCountry = countryName(photo.country).toLocaleLowerCase();
  return name && lower !== country && lower !== expandedCountry && !countryNames.has(lower) ? name : '';
}

function template(): Promise<string> {
  if (!templatePromise) {
    templatePromise = fetch('https://tiles.openfreemap.org/planet', { signal: AbortSignal.timeout(2500) }).then(async response => {
      if (!response.ok) throw new Error('Tile metadata unavailable');
      const metadata = await response.json() as { tiles?: string[] };
      const url = metadata.tiles?.[0];
      if (!url || !url.startsWith('https://tiles.openfreemap.org/') || !url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) throw new Error('Invalid tile template');
      return url;
    }).catch(error => { templatePromise = undefined; throw error; });
  }
  return templatePromise;
}

function loadTile(tile: Tile): Promise<Place[]> {
  const cached = tileCache.get(tile.key);
  if (cached) return cached;
  const pending = (async () => {
    const url = (await template()).replace('{z}', String(zoom)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error('Map tile unavailable');
    const layer = new VectorTile(new Pbf(new Uint8Array(await response.arrayBuffer()))).layers.place;
    const result: Place[] = [];
    if (!layer) return result;
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const kind = String(feature.properties.class ?? '');
      const name = String(feature.properties.name_en ?? feature.properties['name:en'] ?? feature.properties.name ?? '').trim();
      if (!name || !['city', 'town', 'village'].includes(kind)) continue;
      const geometry = feature.toGeoJSON(tile.x, tile.y, zoom).geometry;
      if (geometry?.type === 'Point') result.push({ name, kind, lon: geometry.coordinates[0], lat: geometry.coordinates[1] });
    }
    return result;
  })();
  tileCache.set(tile.key, pending);
  if (tileCache.size > 160) tileCache.delete(tileCache.keys().next().value!);
  pending.catch(() => { if (tileCache.get(tile.key) === pending) tileCache.delete(tile.key); });
  return pending;
}

function distanceKm(lat: number, lon: number, place: Place): number {
  const rad = Math.PI / 180;
  const dLat = (place.lat - lat) * rad, dLon = (place.lon - lon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(place.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Resolve stored names first, then nearby named settlements from coarse map tiles. */
export async function resolveRecapPlaces(photos: readonly Photo[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const groups = new Map<string, Photo[]>();
  for (const photo of photos) {
    const name = storedPlace(photo);
    if (name) { result[photo.id] = name; continue; }
    const { latitude: lat, longitude: lon } = photo;
    if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180 || (photo.locationSource === 'unknown' && !photo.confirmed)) continue;
    const x = Math.min(tileCount - 1, Math.max(0, Math.floor((lon + 180) / 360 * tileCount)));
    const y = Math.min(tileCount - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * tileCount)));
    const key = `${x}/${y}`;
    const group = groups.get(key) ?? [];
    group.push(photo); groups.set(key, group);
  }
  const visited = new Set<string>();
  const deadline = Date.now() + 3500;
  for (const [key, group] of groups) {
    if (Date.now() >= deadline) break;
    const [cx, cy] = key.split('/').map(Number);
    const tiles: Tile[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const x = (cx + dx + tileCount) % tileCount, y = cy + dy;
      if (y >= 0 && y < tileCount) tiles.push({ x, y, key: `${zoom}/${x}/${y}` });
    }
    const newTiles = tiles.filter(tile => !visited.has(tile.key));
    if (visited.size + newTiles.length > 54) break;
    tiles.forEach(tile => visited.add(tile.key));
    // Require the complete neighborhood so a missing tile cannot skew the nearest result.
    const remaining = Math.max(1, deadline - Date.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const loaded = await Promise.race([
      Promise.all(tiles.map(tile => loadTile(tile))).catch(() => null),
      new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), remaining); }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!loaded) continue;
    const places = loaded.flat();
    for (const photo of group) {
      let best: { name: string; distance: number } | undefined;
      for (const place of places) {
        const distance = distanceKm(photo.latitude!, photo.longitude!, place);
        const limit = place.kind === 'city' ? 10 : place.kind === 'town' ? 6 : 3;
        if (distance <= limit && (!best || distance < best.distance)) best = { name: place.name, distance };
      }
      if (best) result[photo.id] = best.name;
    }
  }
  return result;
}
