'use client';

import { useEffect, useMemo, useState } from 'react';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { Photo } from '../lib/types';
import { atlasProjection, projectLocation, viewportScale, type Coordinate, type FlatCamera, type MapSize } from './atlas-camera';

type Props = { size: MapSize; flatCamera: FlatCamera; opacity: number; panelOpen: boolean };
type Detail = { id: string; kind: 'road' | 'roadLabel' | 'place' | 'water'; coordinates: Coordinate[]; rings?: Coordinate[][]; name: string; roadClass: string; rank: number };
type Tile = { key: string; z: number; x: number; y: number };
const cache = new Map<string, Promise<Detail[]>>();
const projectionCache = new WeakMap<Coordinate, Coordinate>();
let tileTemplate: Promise<string> | undefined;
const maxCache = 160;
const mercatorY = (lat: number) => (1 - Math.asinh(Math.tan(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180)) / Math.PI) / 2;

// Sample the Equal Earth viewport, rather than pretending its bounds are Mercator bounds.
type Bounds = { left: number; right: number; top: number; bottom: number };
function visibleTiles(camera: FlatCamera, bounds: Bounds): Tile[] {
  const inverse = atlasProjection.invert;
  if (!inverse || camera.k < 1.35) return [];
  const samples: Coordinate[] = [];
  for (let row = 0; row <= 4; row++) for (let col = 0; col <= 4; col++) {
    const x = bounds.left + (bounds.right - bounds.left) * col / 4;
    const y = bounds.top + (bounds.bottom - bounds.top) * row / 4;
    const p = inverse([(x - camera.x) / camera.k, (y - camera.y) / camera.k]);
    if (p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90) samples.push(p);
  }
  if (!samples.length) return [];
  const center = inverse([((bounds.left + bounds.right) / 2 - camera.x) / camera.k, ((bounds.top + bounds.bottom) / 2 - camera.y) / camera.k]) ?? samples[0];
  const longitudes = samples.map(p => center[0] + ((((p[0] - center[0]) + 540) % 360) - 180));
  const latitudes = samples.map(p => p[1]);
  let z = Math.max(2, Math.min(14, Math.floor(Math.log2(1400 * camera.k / 512))));
  for (; z >= 2; z--) {
    const n = 2 ** z;
    const x0 = Math.floor((Math.min(...longitudes) + 180) / 360 * n), x1 = Math.floor((Math.max(...longitudes) + 180) / 360 * n);
    const y0 = Math.max(0, Math.floor(mercatorY(Math.max(...latitudes)) * n)), y1 = Math.min(n - 1, Math.floor(mercatorY(Math.min(...latitudes)) * n));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 36) continue;
    const result: Tile[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const wrapped = ((x % n) + n) % n;
      result.push({ key: `${z}/${wrapped}/${y}`, z, x: wrapped, y });
    }
    return result;
  }
  return [];
}

async function loadTile(tile: Tile): Promise<Detail[]> {
  const existing = cache.get(tile.key);
  if (existing) return existing;
  const promise = (async () => {
    tileTemplate ??= fetch('https://tiles.openfreemap.org/planet', { referrerPolicy: 'no-referrer' }).then(async response => {
      if (!response.ok) throw new Error('Tile metadata unavailable');
      const metadata = await response.json() as { tiles: string[] };
      return metadata.tiles[0];
    }).catch(error => { tileTemplate = undefined; throw error; });
    const template = await tileTemplate;
    const url = template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
    const response = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('Map tile unavailable');
    const vector = new VectorTile(new Pbf(new Uint8Array(await response.arrayBuffer())));
    const result: Detail[] = [];
    for (const layerName of ['water', 'transportation', 'transportation_name', 'place']) {
      if (layerName === 'water' && tile.z < 8) continue;
      const layer = vector.layers[layerName];
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        const properties = feature.properties;
        const roadClass = String(properties.class ?? '');
        const name = String(properties.name_en ?? properties['name:en'] ?? properties.name ?? '');
        if ((layerName === 'place' || layerName === 'transportation_name') && !name) continue;
        if (layerName === 'transportation' && !['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'path'].includes(roadClass)) continue;
        const geo = feature.toGeoJSON(tile.x, tile.y, tile.z);
        const geometry = geo.geometry;
        if (!geometry) continue;
        if (layerName === 'water') {
          const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
          for (let j = 0; j < polygons.length; j++) result.push({ id: `${tile.key}:water:${i}:${j}`, kind: 'water', coordinates: [], rings: polygons[j] as Coordinate[][], name: '', roadClass: '', rank: 0 });
          continue;
        }
        let lines: Coordinate[][] = [];
        if (geometry.type === 'Point') lines = [[geometry.coordinates as Coordinate]];
        else if (geometry.type === 'LineString') lines = [geometry.coordinates as Coordinate[]];
        else if (geometry.type === 'MultiLineString') lines = geometry.coordinates as Coordinate[][];
        for (let j = 0; j < lines.length; j++) result.push({ id: `${tile.key}:${layerName}:${i}:${j}`, kind: layerName === 'place' ? 'place' : layerName === 'transportation_name' ? 'roadLabel' : 'road', coordinates: lines[j], name, roadClass, rank: Number(properties.rank ?? 9) });
      }
    }
    return result;
  })();
  cache.set(tile.key, promise);
  if (cache.size > maxCache) cache.delete(cache.keys().next().value!);
  promise.catch(() => cache.delete(tile.key));
  return promise;
}

export default function AtlasMapDetails({ size, flatCamera, opacity, panelOpen }: Props) {
  const [details, setDetails] = useState<Detail[]>([]);
  const { x, y, k } = flatCamera;
  const screenWidth = typeof window === 'undefined' ? size.width : window.innerWidth;
  const screenHeight = typeof window === 'undefined' ? size.height : window.innerHeight;
  const viewScale = viewportScale(size);
  const offsetX = (size.width - 1600 * viewScale) / 2, offsetY = (size.height - 900 * viewScale) / 2;
  const shiftX = panelOpen && screenWidth >= 801 ? Math.min(200, screenWidth * .18) : 0;
  const shiftY = panelOpen && screenWidth <= 600 ? -screenHeight * .23 : 0;
  const visibleBottom = panelOpen && screenWidth <= 600 ? size.height - screenHeight * .46 : size.height;
  const bounds = { left: (-offsetX - shiftX) / viewScale, right: (size.width - offsetX - shiftX) / viewScale, top: (-offsetY - shiftY) / viewScale, bottom: (visibleBottom - offsetY - shiftY) / viewScale };
  const { left, right, top, bottom } = bounds;
  const tileKey = useMemo(() => visibleTiles({ x, y, k }, { left, right, top, bottom }).map(tile => tile.key).join(','), [x, y, k, left, right, top, bottom]);
  const enabled = opacity > 0;
  useEffect(() => {
    let active = true;
    if (!enabled || !tileKey) return;
    const tiles = tileKey.split(',').map(key => {
      const [z, x, y] = key.split('/').map(Number);
      return { key, z, x, y };
    });
    // Debounce movement so animation frames do not each start network requests.
    const timeout = window.setTimeout(() => {
      Promise.all(tiles.map(tile => loadTile(tile).catch(() => []))).then(items => { if (active) setDetails(items.flat()); });
    }, 120);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [tileKey, enabled]);
  const scale = viewScale;
  const project = (point: Coordinate): Coordinate => {
    let p = projectionCache.get(point);
    if (!p) { p = projectLocation(point); projectionCache.set(point, p); }
    return [flatCamera.x + p[0] * flatCamera.k, flatCamera.y + p[1] * flatCamera.k];
  };
  const waters: React.ReactNode[] = [];
  const roads: React.ReactNode[] = [];
  const labels: { x: number; y: number; name: string; kind: 'place' | 'roadLabel'; rank: number }[] = [];
  const regional = k < 12;
  const continental = k < 4;
  for (const detail of enabled && tileKey ? details : []) {
    if (detail.kind === 'water') {
      const rings = (detail.rings ?? []).map(ring => ring.map(project));
      const vertices = rings.flat();
      if (!vertices.length) continue;
      const xs = vertices.map(point => point[0]), ys = vertices.map(point => point[1]);
      if (Math.max(...xs) < bounds.left - 100 || Math.min(...xs) > bounds.right + 100 || Math.max(...ys) < bounds.top - 100 || Math.min(...ys) > bounds.bottom + 100) continue;
      const d = rings.map(ring => ring.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('') + 'Z').join('');
      waters.push(<path key={detail.id} d={d} fill="#8FAFB6" fillRule="evenodd" />);
      continue;
    }
    if (!detail.coordinates.length) continue;
    const points = detail.coordinates.map(project);
    if (detail.kind === 'road') {
      if (points.length < 2 || !points.some(([x, y]) => x > bounds.left - 100 && x < bounds.right + 100 && y > bounds.top - 100 && y < bounds.bottom + 100)) continue;
      const d = points.map(([x, y], i) => `${i === 0 || Math.abs(x - points[i - 1][0]) > 1000 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
      const major = ['motorway', 'trunk', 'primary'].includes(detail.roadClass);
      roads.push(<path key={detail.id} d={d} fill="none" stroke={major ? '#b7a992' : '#c8bba6'} strokeWidth={(major ? 1.8 : 1) / scale} strokeLinecap="round" strokeLinejoin="round" />);
    } else {
      if (detail.kind === 'roadLabel' && flatCamera.k < 250) continue;
      if (detail.kind === 'place' && continental && !['country', 'city'].includes(detail.roadClass)) continue;
      if (detail.kind === 'place' && regional && detail.rank > 6 && !['city', 'country'].includes(detail.roadClass)) continue;
      const [x, y] = points[Math.floor(points.length / 2)];
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) continue;
      labels.push({ x, y, name: detail.name, kind: detail.kind, rank: detail.rank });
    }
  }
  labels.sort((a, b) => (a.kind === 'place' ? 0 : 1) - (b.kind === 'place' ? 0 : 1) || a.rank - b.rank);
  const accepted: typeof labels = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const key = `${label.kind}:${label.name}`;
    if (seen.has(key)) continue;
    const width = Math.min(180, 12 + label.name.length * (label.kind === 'place' ? 7 : 6)) / scale;
    if (accepted.some(other => Math.abs(other.x - label.x) < width / 2 + Math.min(180, 12 + other.name.length * 7) / (2 * scale) && Math.abs(other.y - label.y) < 20 / scale)) continue;
    seen.add(key); accepted.push(label);
    if (accepted.length >= (continental ? 32 : regional ? 52 : 84)) break;
  }
  return <g className="atlas-map-details" data-basemap-detail="true" data-detail-roads={roads.length} data-detail-labels={accepted.length} data-detail-water={waters.length} opacity={opacity} pointerEvents="none" aria-hidden="true">
    <g className="atlas-detail-water">{waters}</g>
    <g className="atlas-detail-roads">{roads}</g>
    <g className="atlas-detail-labels">{accepted.map((label, i) => <text className={label.kind === 'place' ? 'atlas-detail-place-label' : 'atlas-detail-street-label'} key={`${label.kind}:${label.name}:${i}`} x={label.x} y={label.y} textAnchor="middle" dominantBaseline="central" fontFamily="system-ui, sans-serif" fontSize={(label.kind === 'place' ? 14 : 12) / scale} fontWeight={label.kind === 'place' ? 600 : 400} fill={label.kind === 'place' ? '#4d5247' : '#645c4e'} stroke="#f1e9d9" strokeWidth={3 / scale} paintOrder="stroke" strokeLinejoin="round">{label.name}</text>)}</g>
  </g>;
}

export type AtlasPlace = { name: string; nearby: boolean };
type PhotoLocation = { id: string; lat: number; lon: number };

/** Resolve only named settlements, using distance as a conservative nearby hint. */
export function useAtlasPlaces(photos: Photo[]): Record<string, AtlasPlace> {
  const locationsKey = JSON.stringify(photos.flatMap(photo => {
    const lat = photo.latitude, lon = photo.longitude;
    const place = photo.placeName.trim().toLowerCase();
    const hasSpecificPlace = place && place !== photo.country.trim().toLowerCase();
    return !hasSpecificPlace && lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180
      ? [{ id: photo.id, lat, lon }] : [];
  }));
  const [result, setResult] = useState<{ key: string; places: Record<string, AtlasPlace> }>({ key: '', places: {} });
  useEffect(() => {
    let active = true;
    const locations = JSON.parse(locationsKey) as PhotoLocation[];
    if (!locations.length) return;
    const zoom = 8, n = 2 ** zoom;
    const groups = new Map<string, PhotoLocation[]>();
    for (const item of locations) {
      const x = Math.min(n - 1, Math.max(0, Math.floor((item.lon + 180) / 360 * n)));
      const y = Math.min(n - 1, Math.max(0, Math.floor(mercatorY(item.lat) * n)));
      const key = `${x}/${y}`;
      const group = groups.get(key) ?? [];
      group.push(item); groups.set(key, group);
    }
    void (async () => {
      const visited = new Set<string>();
      const resolved: Record<string, AtlasPlace> = {};
      for (const [key, group] of groups) {
        if (!active) return;
        const [cx, cy] = key.split('/').map(Number);
        const tiles: Tile[] = [];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const x = (cx + dx + n) % n, y = cy + dy;
          if (y >= 0 && y < n) tiles.push({ key: `${zoom}/${x}/${y}`, z: zoom, x, y });
        }
        const additional = tiles.filter(tile => !visited.has(tile.key));
        // Do not return a potentially misleading nearest result from an incomplete neighborhood.
        if (visited.size + additional.length > 256) break;
        tiles.forEach(tile => visited.add(tile.key));
        const data: Detail[] = [];
        for (let i = 0; i < tiles.length; i += 3) {
          const batch = await Promise.all(tiles.slice(i, i + 3).map(tile => loadTile(tile).catch(() => null)));
          if (!active) return;
          if (batch.some(tile => tile === null)) { data.length = 0; break; }
          data.push(...batch.flatMap(tile => tile ?? []));
        }
        const places = data.filter(item => item.kind === 'place' && ['city', 'town', 'village'].includes(item.roadClass) && item.coordinates.length > 0);
        for (const item of group) {
          let best: { name: string; distance: number } | undefined;
          for (const place of places) {
            const [lon, lat] = place.coordinates[0];
            const radians = Math.PI / 180;
            const dLat = (lat - item.lat) * radians, dLon = (lon - item.lon) * radians;
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(item.lat * radians) * Math.cos(lat * radians) * Math.sin(dLon / 2) ** 2;
            const distance = 12742 * Math.asin(Math.sqrt(Math.min(1, a)));
            const limit = place.roadClass === 'city' ? 10 : place.roadClass === 'town' ? 6 : 3;
            if (distance <= limit && (!best || distance < best.distance)) best = { name: place.name, distance };
          }
          if (best) resolved[item.id] = { name: best.name, nearby: true };
        }
        if (active) setResult({ key: locationsKey, places: { ...resolved } });
      }
    })();
    return () => { active = false; };
  }, [locationsKey]);
  // Filter immediately when the album or reviewed place names change.
  return result.key === locationsKey ? result.places : {};
}
