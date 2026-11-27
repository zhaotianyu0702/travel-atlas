import land from "./data/recap-land.json";
import landNames from "./data/recap-land-names.json";
import type { RecapScene, RecapScenePhoto } from "./recap-story";

function pointInRing(ring: readonly (readonly number[])[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const regions = land.map((rings, index) => {
  const outer = rings[0] ?? [];
  const lon = outer.map(point => point[0]), lat = outer.map(point => point[1]);
  return { rings, name: landNames[index], west: Math.min(...lon), east: Math.max(...lon), south: Math.min(...lat), north: Math.max(...lat) };
});

/** Country-level fallback from the same geographic boundaries used by the inset. */
export function recapCountryAt([lon, lat]: [number, number]): string {
  const matches = new Set<string>();
  for (const { rings, name, west, east, south, north } of regions) {
    if (!name || east - west > 180 || lon < west || lon > east || lat < south || lat > north) continue;
    if (rings.reduce((inside, ring) => inside !== pointInRing(ring, lon, lat), false)) matches.add(name);
  }
  return matches.size === 1 ? [...matches][0] : "";
}

/** Approximate coastline fallback for accepted GPS just outside the simplified land boundary. */
export function recapCoastAt([lon, lat]: [number, number]): string {
  const limit = 25;
  const lonKm = 111 * Math.max(.15, Math.cos(lat * Math.PI / 180));
  const names = new Set<string>();
  for (const { rings, name, west, east, south, north } of regions) {
    if (!name || east - west > 180 || lon < west - limit / lonKm || lon > east + limit / lonKm ||
        lat < south - limit / 111 || lat > north + limit / 111) continue;
    const outer = rings[0] ?? [];
    for (let i = 1; i < outer.length; i++) {
      const [ax, ay] = [(outer[i - 1][0] - lon) * lonKm, (outer[i - 1][1] - lat) * 111];
      const [bx, by] = [(outer[i][0] - lon) * lonKm, (outer[i][1] - lat) * 111];
      const dx = bx - ax, dy = by - ay;
      const length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
      if (Math.hypot(ax + t * dx, ay + t * dy) <= limit) { names.add(name); break; }
    }
  }
  return names.size === 1 ? [...names][0] : "";
}

/** Simplified Natural Earth 1:50m country polygons from public/world.geojson. */
export interface RecapMap {
  width: number;
  height: number;
  landPaths: string[];
  points: { x: number; y: number; index: number }[];
  routePath: string;
  gridPath: string;
  contextOnly: boolean;
  labels: { x: number; y: number; text: string }[];
}

export function buildRecapSceneMap(scene: RecapScene, width: number, height: number): RecapMap {
  return buildRecapMap(scene.photos, width, height, scene.mapContext);
}

/** A local equirectangular view, shared by geography and the coarse route. */
export function buildRecapMap(photos: RecapScenePhoto[], width: number, height: number, context?: [number, number]): RecapMap {
  const points: { lon: number; lat: number; index: number }[] = [];
  photos.forEach((photo, index) => {
    if (!photo.point) return;
    let lon = photo.point[0];
    const lat = photo.point[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return;
    if (points.length) {
      const last = points[points.length - 1].lon;
      lon += 360 * Math.round((last - lon) / 360);
    }
    points.push({ lon, lat, index });
  });
  const contextOnly = points.length === 0;
  const empty = { width, height, landPaths: [], points: [], routePath: "", gridPath: "", labels: [], contextOnly };
  if (width <= 0 || height <= 0) return empty;
  const extents = points.length ? points : context ? [{ lon: context[0], lat: context[1] }] : [{ lon: 0, lat: 0 }];
  const minLon = Math.min(...extents.map(p => p.lon)), maxLon = Math.max(...extents.map(p => p.lon));
  const minLat = Math.min(...extents.map(p => p.lat)), maxLat = Math.max(...extents.map(p => p.lat));
  const centerLon = (minLon + maxLon) / 2, centerLat = (minLat + maxLat) / 2;
  const cos = Math.max(0.2, Math.cos(centerLat * Math.PI / 180));
  const world = contextOnly && !context;
  const marginX = Math.min(48, width / 4), marginY = Math.min(36, height / 4);
  // Give even a single stop a regional frame with borders and coastline in view.
  const scale = world ? Math.min(width / 360, height / 180) :
    Math.min((width - marginX) / Math.max((maxLon - minLon) * cos * 1.32, 16 * cos),
      (height - marginY) / Math.max((maxLat - minLat) * 1.32, 11));
  const project = (lon: number, lat: number): [number, number] => [width / 2 + (lon - centerLon) * cos * scale, height / 2 - (lat - centerLat) * scale];
  const num = (n: number) => Math.round(n * 10) / 10;
  const longitudeSpan = width / (cos * scale), latitudeSpan = height / scale;
  const step = longitudeSpan > 150 ? 30 : longitudeSpan > 55 ? 10 : 5;
  const grid: string[] = [];
  for (let lon = Math.ceil((centerLon - longitudeSpan / 2) / step) * step; lon < centerLon + longitudeSpan / 2; lon += step) {
    const [x] = project(lon, 0);
    grid.push(`M${num(x)},0V${height}`);
  }
  const south = Math.max(-90, centerLat - latitudeSpan / 2), north = Math.min(90, centerLat + latitudeSpan / 2);
  for (let lat = Math.ceil(south / step) * step; lat < north; lat += step) {
    const [, y] = project(0, lat);
    grid.push(`M0,${num(y)}H${width}`);
  }
  const landPaths: string[] = [];
  const mapped = points.map(p => { const [x, y] = project(p.lon, p.lat); return { x, y, index: p.index }; });
  const candidates: { x: number; y: number; text: string; score: number }[] = [];
  const routeDistance = (x: number, y: number) => {
    let result = Infinity;
    for (let i = 0; i < mapped.length; i++) {
      const a = mapped[i], b = mapped[Math.min(i + 1, mapped.length - 1)];
      const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0;
      result = Math.min(result, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
    }
    return result;
  };
  for (const [polygonIndex, polygon] of land.entries()) {
    for (let shift = -1; shift <= 1; shift++) {
      let path = "", visible = false;
      const visibleRings: [number, number][][] = [];
      for (const ring of polygon) {
        if (ring.length < 4) continue;
        let previous = ring[0][0] + 360 * Math.round((centerLon - ring[0][0]) / 360) + shift * 360;
        const projected: [number, number][] = [];
        for (const pair of ring) {
          const lon = pair[0] + 360 * Math.round((previous - pair[0]) / 360);
          previous = lon;
          projected.push(project(lon, pair[1]));
        }
        const xs = projected.map(p => p[0]), ys = projected.map(p => p[1]);
        if (Math.max(...xs) < 0 || Math.min(...xs) > width || Math.max(...ys) < 0 || Math.min(...ys) > height) continue;
        visible = true;
        visibleRings.push(projected);
        path += projected.map(([x, y], i) => `${i ? "L" : "M"}${num(x)},${num(y)}`).join("") + "Z";
      }
      if (visible) {
        landPaths.push(path);
        const text = landNames[polygonIndex];
        if (world || !text) continue;
        const halfWidth = Math.max(18, text.length * 4.2);
        let best: { x: number; y: number; text: string; score: number } | undefined;
        // Sample only label centers whose surrounding area lies inside this country.
        for (let y = 20; y < height - 15; y += 16) for (let x = halfWidth + 8; x < width - halfWidth - 8; x += 16) {
          const inside = (px: number, py: number) => visibleRings.reduce((inLand, ring) => inLand !== pointInRing(ring, px, py), false);
          if (!inside(x, y) || !inside(x - 5, y) || !inside(x + 5, y) || !inside(x, y - 5) || !inside(x, y + 5)) continue;
          const distance = routeDistance(x, y);
          if (distance < 22) continue;
          const score = Math.min(distance, 90) + Math.min(x, width - x, y, height - y) * .3;
          if (!best || score > best.score) best = { x, y, text, score };
        }
        if (best) candidates.push(best);
      }
    }
  }
  const routePath = mapped.map((p, i) => `${i ? "L" : "M"}${num(p.x)},${num(p.y)}`).join("");
  const labels: RecapMap["labels"] = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (labels.some(p => p.text === candidate.text || (Math.abs(p.y - candidate.y) < 22 && Math.abs(p.x - candidate.x) < (p.text.length + candidate.text.length) * 4.3 + 14))) continue;
    labels.push({ x: candidate.x, y: candidate.y, text: candidate.text });
    if (labels.length === 3) break;
  }
  // A remote ocean stop benefits from a global locator with real continents.
  if (!landPaths.length && !world) {
    const overview = buildRecapMap([], width, height);
    const wrap = (lon: number) => ((lon + 540) % 360 + 360) % 360 - 180;
    const worldScale = Math.min(width / 360, height / 180);
    const locations = points.map(p => ({ x: width / 2 + wrap(p.lon) * worldScale, y: height / 2 - p.lat * worldScale, index: p.index }));
    return { ...overview, contextOnly, points: locations };
  }
  return { width, height, landPaths, points: mapped, routePath, gridPath: grid.join(""), labels, contextOnly };
}

/** The static portion can be cached in a canvas once for video encoding. */
export function drawRecapMapBase(ctx: CanvasRenderingContext2D, map: RecapMap) {
  ctx.fillStyle = "#91b5c2";
  ctx.fillRect(0, 0, map.width, map.height);
  ctx.fillStyle = "#f3ead4";
  ctx.strokeStyle = "#657a75";
  ctx.lineWidth = 1;
  for (const d of map.landPaths) {
    const path = new Path2D(d);
    ctx.fill(path, "evenodd");
    ctx.stroke(path);
  }
  ctx.save();
  ctx.strokeStyle = "#4b7887"; ctx.globalAlpha = .25; ctx.lineWidth = 1;
  ctx.stroke(new Path2D(map.gridPath));
  ctx.globalAlpha = 1; ctx.fillStyle = "#3f5b53"; ctx.font = "650 14px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const label of map.labels) ctx.fillText(label.text.toUpperCase(), label.x, label.y);
  ctx.restore();
}

export function drawRecapMapRoute(ctx: CanvasRenderingContext2D, map: RecapMap, progress: number) {
  const pts = map.points;
  if (!pts.length) return;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const stroke = (color: string, lineWidth: number, completed: boolean) => {
    ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const t = completed ? Math.max(0, Math.min(1, (progress - a.index) / (b.index - a.index))) : 1;
      if (Math.abs(b.x - a.x) > map.width / 2) ctx.moveTo(b.x, b.y);
      else ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      if (t < 1) break;
    }
    ctx.stroke();
  };
  stroke("rgba(255,255,255,.9)", 5, false); stroke("#416e71", 2.5, false);
  stroke("#fffaf0", 6, true); stroke("#99482f", 3, true);
  for (const p of pts) {
    ctx.beginPath(); ctx.arc(p.x, p.y, p.index <= progress ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = p.index <= progress ? "#9a503a" : "#77958c"; ctx.fill();
    ctx.strokeStyle = "#fffaf0"; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // Only animate between adjacent photos that both have a known location.
  const before = pts.find(p => p.index === Math.floor(progress));
  const after = pts.find(p => p.index === Math.ceil(progress));
  if (!before || !after || Math.abs(after.x - before.x) > map.width / 2) return;
  const t = progress % 1;
  const x = before.x + (after.x - before.x) * t;
  const y = before.y + (after.y - before.y) * t;
  ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fillStyle = "#9a503a"; ctx.fill(); ctx.strokeStyle = "#fffaf0"; ctx.lineWidth = 2.5; ctx.stroke();
}

export function drawRecapMap(ctx: CanvasRenderingContext2D, map: RecapMap, progress: number) {
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, map.width, map.height); ctx.clip();
  drawRecapMapBase(ctx, map); drawRecapMapRoute(ctx, map, progress); ctx.restore();
}
