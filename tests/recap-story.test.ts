import test from "node:test";
import { Script } from "node:vm";
import assert from "node:assert/strict";
import { buildRecapScene, projectRecapPoints, recapFrameCopy } from "../lib/recap-story";
import { applyRecapPresentation } from "../lib/recap-guidance";
import { renderRecapHtml } from "../lib/recap-html";
import { stripImageMetadata } from "../lib/recap-image";
import type { Photo, Recap } from "../lib/types";

const recap = {
  accountId: "x",
  tripIds: ["x"],
  title: "<Trip </script>",
  photoIds: ["b", "a"],
  theme: "story",
} as Recap;
const photo = (id: string, overrides: Partial<Photo> = {}): Photo => ({
  id,
  accountId: "x",
  tripId: "x",
  fileName: "secret.jpg",
  mimeType: "image/jpeg",
  width: 100,
  height: 50,
  sha256: "",
  capturedAt: "2024-01-02T13:01:00Z",
  latitude: 42.1234,
  longitude: 179.97,
  placeName: "Boston",
  country: "US",
  notes: "",
  locationSource: "exif",
  confirmed: false,
  originalPath: "",
  thumbnailPath: "",
  metadata: { capturedAt: null, latitude: null, longitude: null },
  createdAt: "",
  ...overrides,
});

test('Places keeps known, repeated, inferred and missing locations consistent', () => {
  const cut = { kind: 'journey' as const, title: 'Coast', presentation: { style: 'minimal' as const, text: 'places' as const }, beats: [
    { photoIds: ['a'], caption: 'Rockport', seconds: 3 },
    { photoIds: ['b'], caption: '', seconds: 3 },
    { photoIds: ['c'], caption: '', seconds: 3 },
  ] };
  const photos = [photo('a', { placeName: '', country: '', latitude: 42, longitude: -70 }),
    photo('b', { placeName: '', country: '', latitude: 42.001, longitude: -70 }),
    photo('c', { locationSource: 'unknown', placeName: '', country: '', latitude: null, longitude: null, capturedAt: null })];
  const scene = buildRecapScene({ ...recap, photoIds: ['a', 'b', 'c'], cut }, photos, 'hash');
  assert.deepEqual(scene.beats.map(b => b.caption), ['Rockport', 'Rockport', 'Location unrecorded']);
  assert.equal(recapFrameCopy(scene, 1).headline, 'Rockport');
  assert.equal(recapFrameCopy(scene, 2, scene.beats[2]).headline, 'Location unrecorded');
  const generated = applyRecapPresentation(cut, { stage: 'compose', direction: 'place', theme: 'Coast', presentation: cut.presentation }, photos, { a: 'Rockport', b: 'Rockport' });
  assert.equal(generated.storyTheme, 'Coast');
  assert.deepEqual(generated.beats.map(b => b.caption), ['Rockport', 'Rockport', '']);
  const hidden = buildRecapScene({ ...recap, photoIds: ['a'], cut: { ...cut, beats: [cut.beats[0]], presentation: { ...cut.presentation, text: 'none' } } }, photos, 'hash');
  assert.equal(recapFrameCopy(hidden, 0).headline, '');
});

test('conflicting nearby evidence is not assigned an unsupported place', () => {
  const cut = { kind: 'journey' as const, title: 'Coast', presentation: { style: 'minimal' as const, text: 'places' as const }, beats: [
    { photoIds: ['a'], caption: 'A', seconds: 3 }, { photoIds: ['b'], caption: '', seconds: 3 }, { photoIds: ['c'], caption: 'C', seconds: 3 },
  ] };
  const photos = ['a', 'b', 'c'].map((id, i) => photo(id, { placeName: '', country: '', latitude: 42 + i * .001, longitude: -70 }));
  const scene = buildRecapScene({ ...recap, photoIds: ['a', 'b', 'c'], cut }, photos, 'hash');
  assert.equal(scene.beats[1].caption, 'Location unrecorded');
});
test("scene preserves selection order, accepted evidence and coarse location", () => {
  const scene = buildRecapScene(
    recap,
    [
      photo("a", { storageMode: "optimized" }),
      photo("b", {
        locationSource: "unknown",
        confirmed: false,
        latitude: 23.1234,
        longitude: -179.9,
      }),
    ],
    "hash",
  );
  assert.deepEqual(
    scene.photos.map((p) => p.id),
    ["b", "a"],
  );
  assert.equal(scene.photos[0].point, null);
  assert.equal(scene.photos[0].label, "");
  assert.deepEqual(scene.photos[1].point, [180, 42.1]);
  assert.equal(scene.photos[1].date, "Jan 2, 2024");
  assert.match(scene.photos[1].src, /original/);
});

test("a photo without GPS uses only a coarse center from its own trip", () => {
  const scene = buildRecapScene({ ...recap, photoIds: ["a"] }, [
    photo("a", { locationSource: "unknown" }),
    photo("located", { longitude: 15.2, latitude: -21.8 }),
    photo("elsewhere", { tripId: "other", longitude: 2, latitude: 48 }),
    photo("other-account", { accountId: "y", longitude: 2, latitude: 48 }),
  ], "snapshot");
  assert.deepEqual(scene.mapContext, [15, -22]);
  assert.deepEqual(scene.photos.map(photo => [photo.id, photo.point]), [["a", null]]);
});
test("route crosses date line locally and HTML safely embeds every photo", () => {
  const scene = buildRecapScene(
    recap,
    [photo("a", { longitude: 179 }), photo("b", { longitude: -179 })],
    "hash",
  );
  const projected = projectRecapPoints(scene.photos);
  assert.ok(
    projected[0] &&
      projected[1] &&
      Math.abs(projected[0][0] - projected[1][0]) > 100,
  );
  scene.photos.forEach((p) => (p.src = "data:image/jpeg;base64,AAA"));
  const html = renderRecapHtml(scene);
  assert.ok(!html.includes("<Trip </script>"));
  assert.equal((html.match(/data:image\/jpeg;base64,AAA/g) || []).length, 2);
  assert.ok(html.includes("ArrowRight"));
  assert.ok(!html.includes("secret.jpg"));
});
test("JPEG metadata segments are removed including after a scan", () => {
  const image = new Uint8Array([
    255, 216, 255, 225, 0, 6, 1, 2, 3, 4, 255, 218, 0, 2, 5, 255, 0, 7, 255,
    225, 0, 4, 9, 9, 255, 217,
  ]);
  assert.deepEqual(
    Array.from(stripImageMetadata(image, "image/jpeg")),
    [255, 216, 255, 218, 0, 2, 5, 255, 0, 7, 255, 217],
  );
});

test("offline story embeds geographic basemap and remains a self-contained valid player", () => {
  const scene = buildRecapScene(recap, [photo("a", { longitude:34, latitude:26 }), photo("b", { longitude:35, latitude:25 })], "hash");
  scene.photos.forEach(p => p.src = "data:image/jpeg;base64,AAA");
  const html = renderRecapHtml(scene);
  assert.match(html, /class="land"/);
  assert.match(html, /clip-path="url\(#map-clip\)"/);
  assert.ok(!html.includes("<script src="));
  assert.ok(!html.includes("/api/media/"));
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
});

test("offline story retains a map without inventing a current location", () => {
  const scene = buildRecapScene(recap, [photo("a", { latitude: null, longitude: null }), photo("b", { latitude: null, longitude: null })], "hash");
  scene.photos.forEach(p => p.src = "data:image/jpeg;base64,AAA");
  const html = renderRecapHtml(scene);
  assert.match(html, /class="map"/);
  assert.match(html, /class="grid"/);
  assert.match(html, /id="map-active" style="display:none"/);
  assert.match(html, /points=\[\]/);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
});

test("guided offline players preserve preset layout and compile their scripts", () => {
  for (const style of ["minimal", "cinematic", "dynamic"] as const) {
    const cut = { kind: "journey" as const, title: "Trip", presentation: { style, text: "story" as const }, beats: [{ photoIds: ["b", "a"], caption: "A moment", seconds: 3 }] };
    const scene = buildRecapScene({ ...recap, cut }, [photo("a"), photo("b")], "hash");
    const html = renderRecapHtml(scene);
    assert.ok(html.includes(`preset-${style}`));
    assert.match(html, /naturalWidth\/img.naturalHeight<\.67/);
    assert.match(html, /class="map"/);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Script(script));
  }
});
