import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { visitedCountryCount } from '../lib/visited-country';

const world = JSON.parse(readFileSync(new URL('../public/world.geojson', import.meta.url), 'utf8'));
const photo = (country: string, latitude: number | null, longitude: number | null) => ({ country, latitude, longitude });

test('counts distinct recorded and GPS countries, preserving recorded values', () => {
  const photos = [photo('USA', null, null), photo('United States', 48.86, 2.35), photo('', 42.36, -71.06), photo('', 48.86, 2.35), photo('France', null, null), photo('', 25.03, 121.56), photo('China', null, null)];
  assert.equal(visitedCountryCount(photos, world), 3);
});

test('does not turn sea, invalid GPS or blank labels into countries', () => {
  assert.equal(visitedCountryCount([photo('', 0, -140), photo(' ', null, null), photo('', 91, 0), photo('', 0, NaN)], world), 0);
  assert.equal(visitedCountryCount([photo(' United States ', null, null), photo('USA', null, null)]), 1);
});
