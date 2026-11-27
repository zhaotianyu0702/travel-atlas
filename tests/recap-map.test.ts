import test from "node:test";
import assert from "node:assert/strict";
import { buildRecapMap, drawRecapMapRoute, recapCoastAt, recapCountryAt } from "../lib/recap-map";
import type { RecapScenePhoto } from "../lib/recap-story";

const photo = (point: [number, number] | null): RecapScenePhoto => ({ id: "p", src: "", width: 1, height: 1, date: "", label: "", point });

test("country fallback uses the recorded point without assigning land to ocean photos", () => {
  assert.equal(recapCountryAt([24.69, -31.65]), "South Africa");
  assert.equal(recapCountryAt([15.2, -21.8]), "Namibia");
  assert.equal(recapCountryAt([-18, -28]), "");
  assert.equal(recapCoastAt([18.47, -34.36]), "South Africa");
  assert.equal(recapCoastAt([-18, -28]), "");
});

test("Red Sea stops produce actual geographic shapes and aligned route", () => {
  const map = buildRecapMap([photo([34.0, 26.0]), photo([34.8, 27.2])], 400, 204);
  assert.ok(map.landPaths.length > 0);
  assert.ok(map.landPaths.every(path => path.startsWith("M") && path.endsWith("Z")));
  assert.ok(map.labels.some(label => label.text === "Egypt" || label.text === "Saudi Arabia"));
  assert.equal(map.points.length, 2);
  assert.ok(map.points[1].x > map.points[0].x);
  assert.ok(map.points[1].y < map.points[0].y);
  assert.match(map.routePath, /^M.*L/);
});

test("date line, missing locations, single stop and poles remain finite", () => {
  const map = buildRecapMap([photo([179, 60]), photo(null), photo([-179, 61])], 400, 204);
  assert.deepEqual(map.points.map(p => p.index), [0, 2]);
  assert.ok(Math.abs(map.points[1].x - map.points[0].x) < 150);
  for (const m of [map, buildRecapMap([photo([0, 90])], 400, 204), buildRecapMap([photo([34, 26])], 400, 204)]) {
    assert.ok(!m.landPaths.join("").match(/NaN|Infinity/));
    assert.ok(m.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  }
  assert.equal(buildRecapMap([photo(null)], 400, 204).points.length, 0);
});


test("missing photo location does not display an active marker", () => {
  const map = buildRecapMap([photo([34, 26]), photo(null), photo([35, 27])], 400, 204);
  const radii: number[] = [];
  const ctx = { beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc(_x: number, _y: number, r: number) { radii.push(r); } } as unknown as CanvasRenderingContext2D;
  drawRecapMapRoute(ctx, map, 1);
  assert.ok(!radii.includes(8));
  radii.length = 0;
  drawRecapMapRoute(ctx, map, 1.5);
  assert.ok(!radii.includes(8));
  radii.length = 0;
  drawRecapMapRoute(ctx, map, 2);
  assert.ok(radii.includes(8));
});

test("co-located stops and location-less scenes keep geographic context", () => {
  const sameStop = buildRecapMap([photo([15.2, -21.8]), photo([15.2, -21.8])], 400, 204);
  assert.equal(sameStop.points[0].x, sameStop.points[1].x);
  assert.ok(sameStop.landPaths.length > 2);
  assert.match(sameStop.gridPath, /V204/);
  for (const context of [[15, -22] as [number, number], undefined]) {
    const fallback = buildRecapMap([photo(null)], 400, 204, context);
    assert.equal(fallback.contextOnly, true);
    assert.equal(fallback.routePath, "");
    assert.deepEqual(fallback.points, []);
    assert.ok(fallback.landPaths.length > 2);
  }
});
