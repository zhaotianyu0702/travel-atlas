import test from 'node:test';
import assert from 'node:assert/strict';
import { roadRouteKey, routePoints } from '../lib/road-route';
import type { Photo } from '../lib/types';

function photo(id:string, latitude:number|null, longitude:number|null, capturedAt:string|null, extra:Partial<Photo>={}):Photo {
  return {id,accountId:'local',tripId:'trip',latitude,longitude,capturedAt,...extra} as Photo;
}
test('routing selects chronological nearby stops and excludes duplicate, missing, and flight locations',()=>{
  const photos=[photo('b',40.1,-74,'2026-01-01T11:00:00Z'),photo('a',40,-74,'2026-01-01T10:00:00Z'),photo('near',40.0001,-74,'2026-01-01T10:01:00Z'),photo('missing',null,null,'2026-01-01T10:20:00Z'),photo('flight',51.5,-0.1,'2026-01-01T13:00:00Z')];
  assert.deepEqual(routePoints(photos,'local','trip').map(p=>p.id),['a','b']);
});
test('routing bounds waypoints and fingerprint reflects location and deletion changes',()=>{
  const photos=Array.from({length:20},(_,i)=>photo(String(i),40+i*0.01,-74,`2026-01-${String(i+1).padStart(2,'0')}T10:00:00Z`));
  const points=routePoints(photos,'local','trip');
  assert.equal(points.length,12);assert.equal(points[0].id,'0');assert.equal(points.at(-1)?.id,'19');
  const before=roadRouteKey(points);
  photos[0].latitude=41;assert.notEqual(roadRouteKey(routePoints(photos,'local','trip')),before);
  photos[0].deletedAt='2026-01-22T00:00:00Z';
  assert.equal(routePoints(photos,'local','trip')[0].id,'1');
});
test('same-time distant points and invalid coordinates do not form a route',()=>{
  const photos=[photo('a',40,-74,'2026-01-01T10:00:00Z'),photo('b',41,-74,'2026-01-01T10:00:00Z'),photo('bad',NaN,-74,'2026-01-01T10:00:00Z')];
  assert.deepEqual(routePoints(photos,'local','trip'),[]);
});
