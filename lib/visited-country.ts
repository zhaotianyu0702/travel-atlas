'use client';

import { geoContains } from 'd3-geo';
import { useEffect, useMemo, useState } from 'react';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { Photo } from './types';

type CountryFeature = Omit<Feature<Polygon | MultiPolygon, { name: string; code: string }>, 'bbox'> & { bbox: [number, number, number, number] };
type World = { features: CountryFeature[] };
type CountryPhoto = Pick<Photo, 'country' | 'latitude' | 'longitude'>;

const normalize = (value: string) => value.trim().toLocaleLowerCase('en').replace(/[.]/g, '').replace(/\s+/g, ' ');
// Common recorded variants share the labels used by the existing basemap.
const aliases: Record<string, string> = {
  us: 'united states of america', usa: 'united states of america', 'united states': 'united states of america',
  uk: 'united kingdom', 'great britain': 'united kingdom', britain: 'united kingdom',
  prc: 'china', 'people\'s republic of china': 'china', taiwan: 'china',
};
const canonical = (name: string) => aliases[normalize(name)] ?? normalize(name);
const hasGps = (p: CountryPhoto) => typeof p.latitude === 'number' && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && typeof p.longitude === 'number' && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;

export function visitedCountryCount(photos: CountryPhoto[], world: World | null = null): number {
  const names = new Set<string>();
  const byName = new Map<string, string>();
  if (world) for (const f of world.features) {
    const name = canonical(f.properties.name);
    byName.set(name, name);
    if (f.properties.code && f.properties.code !== '-99') byName.set(normalize(f.properties.code), name);
  }
  const cache = new Map<string, string | null>();
  for (const p of photos) {
    const recorded = canonical(p.country || '');
    if (recorded) { names.add(byName.get(recorded) ?? recorded); continue; }
    if (!world || !hasGps(p)) continue;
    const lon = p.longitude!, lat = p.latitude!, key = `${lon},${lat}`;
    if (!cache.has(key)) {
      const found = world.features.find(f => {
        const [west, south, east, north] = f.bbox;
        return lon >= west && lon <= east && lat >= south && lat <= north && geoContains(f, [lon, lat]);
      });
      cache.set(key, found ? canonical(found.properties.name) : null);
    }
    const located = cache.get(key);
    if (located) names.add(located);
  }
  return names.size;
}

let worldPromise: Promise<World> | null = null;
function loadWorld(): Promise<World> {
  if (!worldPromise) worldPromise = fetch('/world.geojson').then(response => {
    if (!response.ok) throw new Error('Unable to load world basemap');
    return response.json() as Promise<World>;
  }).catch(error => { worldPromise = null; throw error; });
  return worldPromise;
}

export function useVisitedCountryCount(photos: Photo[]): number {
  const [world, setWorld] = useState<World | null>(null);
  const needsWorld = photos.some(p => !p.country?.trim() && hasGps(p));
  useEffect(() => {
    if (!needsWorld || world) return;
    let active = true;
    loadWorld().then(data => { if (active) setWorld(data); }).catch(() => {});
    return () => { active = false; };
  }, [needsWorld, world]);
  return useMemo(() => visitedCountryCount(photos, world), [photos, world]);
}
