import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraAt, cameraFrame, cameraInterpolation, dragCamera, fitLocations, focusPhotoCluster, invertStreetPoint, projectLocation, streetCamera, streetPoint, worldCamera, zoomCamera, zoomStreetCamera, type Coordinate } from '../components/atlas-camera';
import { locatedPhotos, routeData, timelineRouteData } from '../lib/map-data';
import type { Photo } from '../lib/types';

const desktop = { width: 1600, height: 900, mobile: false };
const mobile = { width: 390, height: 844, mobile: true };

test('overview is a centered globe and zoom moves reversibly to Equal Earth', () => {
  for (const size of [desktop, mobile]) {
    const start = worldCamera(size);
    assert.deepEqual(cameraFrame(start, size).center, [800, 450]);
    assert.equal(cameraFrame(start, size).morph, 1);
    const middle = zoomCamera(start, 1.25, [800, 450]);
    assert.ok(cameraFrame(middle, size).morph > 0 && cameraFrame(middle, size).morph < 1);
    const flat = zoomCamera(middle, 1.5 / 1.25, [800, 450]);
    assert.equal(cameraFrame(flat, size).morph, 0);
    assert.equal(cameraFrame(zoomCamera(flat, 1 / 1.5, [800, 450]), size).morph, 1);
    assert.equal(cameraFrame(flat, size).flatCamera.k, start.base.k * 1.5);
    assert.notDeepEqual(dragCamera(start, 50, 0, size).location, start.location);
    assert.notEqual(dragCamera(flat, 50, 0, size).base.x, flat.base.x);
  }
});

test('routes exclude unlocated photos and take the short antimeridian crossing', () => {
  const photo = (id:string, longitude:number | null, capturedAt:string) => ({ id, tripId: 'trip', longitude, latitude: longitude === null ? null : 10, capturedAt }) as Photo;
  const photos = [photo('a', 179, '2026-01-01T00:00:00Z'), photo('b', -179, '2026-01-01T01:00:00Z'), photo('missing', null, '2026-01-01T02:00:00Z')];
  assert.equal(locatedPhotos(photos).length, 2);
  assert.deepEqual(routeData(photos).features[0].geometry.coordinates, [[179, 10], [181, 10]]);
});

test('flat zoom preserves the map location under the pointer throughout the animation', () => {
  const from = fitLocations([[18.42, -33.93]], desktop, true);
  const cursor: Coordinate = [1040, 280];
  const start = cameraFrame(from, desktop).flatCamera;
  const point = [(cursor[0] - start.x) / start.k, (cursor[1] - start.y) / start.k];
  const to = zoomCamera(from, 3, cursor);
  for (const t of [0, .25, .5, .75, 1]) {
    const { x, y, k } = cameraFrame(cameraInterpolation(from, to)(t), desktop).flatCamera;
    assert.ok(Math.hypot(x + k * point[0] - cursor[0], y + k * point[1] - cursor[1]) < .00001);
  }
});

test('nearby photos open at street scale while coincident photos can still open together', () => {
  const a: Coordinate = [18.423, -33.925], b: Coordinate = [18.424, -33.925];
  const launch = fitLocations([a, b], desktop, true);
  const detail = focusPhotoCluster([a, b], desktop, true, launch.zoom);
  assert.ok(detail.zoom > launch.zoom);
  const [ax, ay] = projectLocation(a), [bx, by] = projectLocation(b);
  assert.ok(Math.hypot(ax - bx, ay - by) * cameraFrame(detail, desktop).flatCamera.k >= 65);
  const sameSpot = focusPhotoCluster([a, a], desktop, true, launch.zoom);
  assert.ok(Number.isFinite(sameSpot.zoom) && sameSpot.zoom > launch.zoom);
});

test('the street basemap and photo overlay share a center and maintain cursor zoom', () => {
  for (const size of [desktop, mobile]) {
    const location: Coordinate = [18.424, -33.926];
    const start = cameraAt(location, 820, size);
    const street = streetCamera(cameraFrame(start, size).flatCamera, size);
    assert.ok(Math.hypot(streetPoint(location, street)[0]-800, streetPoint(location, street)[1]-450) < .001);
    const anchor: Coordinate = [1100, 800];
    const point = invertStreetPoint(anchor, street);
    const end = zoomStreetCamera(start, zoomCamera(start, 1.8, anchor), anchor, size);
    const endStreet = streetCamera(cameraFrame(end, size).flatCamera, size);
    const [x, y] = streetPoint(point, endStreet);
    assert.ok(Math.hypot(x-anchor[0], y-anchor[1]) < 1);
  }
});

test('timeline lines connect all dated photographed stops', () => {
  const photo = (id: string, longitude: number, capturedAt: string | null) =>
    ({ id, tripId: 'trip', longitude, latitude: 10, capturedAt }) as Photo;
  const photos = [photo('first', 1, '2026-01-01T08:00:00'), photo('next', 2, '2026-01-02T08:00:00'), photo('undated', 3, null)];
  assert.equal(timelineRouteData(photos.slice(0, 1)).features.length, 0);
  assert.deepEqual(timelineRouteData(photos).features[0].geometry.coordinates, [[1, 10], [2, 10]]);
});
