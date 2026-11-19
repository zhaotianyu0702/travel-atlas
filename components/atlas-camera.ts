import { geoEqualEarth, geoInterpolate, geoPath } from 'd3-geo';

export type Coordinate = [number, number];
export type FlatCamera = { x: number; y: number; k: number };
export type MapSize = { width: number; height: number; mobile: boolean };
export type StreetCamera = { center: Coordinate; zoom: number; worldSize: number };
export type Camera = {
  zoom: number;
  base: FlatCamera;
  anchor: Coordinate;
  location: Coordinate;
  detail: number;
  anchored: boolean;
};

// Keep the projection, seam, and reference frame identical to Personal Atlas.
export const atlasProjection = geoEqualEarth().rotate([-12, 0]).fitExtent([[60, 112], [1540, 826]], { type: 'Sphere' });
export const atlasPath = geoPath(atlasProjection).digits(2);
export const projectLocation = (coordinates: Coordinate) => atlasProjection(coordinates)!;
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const maxMapZoom = 32768;
export function smoothstep(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const viewportScale = ({ width, height }: MapSize) => Math.min(width / 1600, height / 900) || 1;

export function worldCamera(size: MapSize): Camera {
  void size; // Kept in the camera API so callers can share the responsive sizing contract.
  const base = { x: 80, y: 45, k: .9 };
  return { zoom: 1, base, anchor: [800, 450], location: [12, 18], detail: 0, anchored: false };
}

export function cameraFrame(camera: Camera, size: MapSize) {
  const zoom = camera.zoom;
  const morph = 1 - smoothstep((zoom - 1.05) / .45);
  const flatScale = zoom;
  const flatCamera = {
    x: camera.anchor[0] - (camera.anchor[0] - camera.base.x) * flatScale,
    y: camera.anchor[1] - (camera.anchor[1] - camera.base.y) * flatScale,
    k: camera.base.k * flatScale,
  };
  const center: Coordinate = [800, 450];
  const radius = size.mobile ? 684 : Math.min(410, size.width / viewportScale(size) * .42);
  return { flatCamera, morph, center, radius, latitude: camera.location[1], longitude: camera.location[0], width: size.width, height: size.height };
}

export function cameraAt(location: Coordinate, zoom: number, size: MapSize, anchor: Coordinate = [800, 450]): Camera {
  const world = worldCamera(size);
  const [x, y] = projectLocation(location);
  return {
    ...world, location, zoom: clamp(zoom, 1, maxMapZoom), anchor, anchored: true,
    base: { ...world.base, x: anchor[0] - x * world.base.k, y: anchor[1] - y * world.base.k },
  };
}

const degrees = Math.PI / 180;
const maxMercatorLatitude = 85.05112878;
const wrapLongitude = (longitude: number) => ((longitude + 180) % 360 + 360) % 360 - 180;
const mercatorY = (latitude: number) => (1 - Math.asinh(Math.tan(clamp(latitude, -maxMercatorLatitude, maxMercatorLatitude) * degrees)) / Math.PI) / 2;
export const streetStart = 20;
export const streetFull = 42;

export function streetCamera(flat: FlatCamera, size: MapSize): StreetCamera {
  const centerPoint: Coordinate = [(800 - flat.x) / flat.k, (450 - flat.y) / flat.k];
  const inverse = atlasProjection.invert?.(centerPoint);
  const center: Coordinate = inverse?.every(Number.isFinite)
    ? [wrapLongitude(inverse[0]), clamp(inverse[1], -maxMercatorLatitude, maxMercatorLatitude)]
    : [12, 0];
  // Match the overview's east-west scale at the center of the viewport.
  const [longitude, latitude] = center;
  const [x] = projectLocation(center);
  const east = Math.abs(projectLocation([longitude + .02, latitude])[0] - x);
  const west = Math.abs(projectLocation([longitude - .02, latitude])[0] - x);
  const scale = viewportScale(size);
  const zoom = clamp(Math.log2((Math.min(east, west) * 18000 * flat.k * scale) / 512), 0, 20);
  return { center, zoom, worldSize: 512 * 2 ** zoom / scale };
}

export function streetPoint(point: Coordinate, street: StreetCamera): Coordinate {
  return [
    800 + wrapLongitude(point[0] - street.center[0]) / 360 * street.worldSize,
    450 + (mercatorY(point[1]) - mercatorY(street.center[1])) * street.worldSize,
  ];
}

export function invertStreetPoint(point: Coordinate, street: StreetCamera): Coordinate {
  const y = clamp(mercatorY(street.center[1]) + (point[1] - 450) / street.worldSize, 0, 1);
  return [
    wrapLongitude(street.center[0] + (point[0] - 800) / street.worldSize * 360),
    Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / degrees,
  ];
}

export function zoomStreetCamera(from: Camera, to: Camera, anchor: Coordinate, size: MapSize): Camera {
  const point = invertStreetPoint(anchor, streetCamera(cameraFrame(from, size).flatCamera, size));
  const target = streetCamera(cameraFrame(to, size).flatCamera, size);
  const [x, y] = streetPoint(point, target);
  return cameraAt(invertStreetPoint([800 + x - anchor[0], 450 + y - anchor[1]], target), to.zoom, size);
}

export function dragStreetCamera(start: Camera, dx: number, dy: number, size: MapSize): Camera {
  const street = streetCamera(cameraFrame(start, size).flatCamera, size);
  return cameraAt(invertStreetPoint([800 - dx, 450 - dy], street), start.zoom, size);
}

export function fitLocations(locations: Coordinate[], size: MapSize, panelOpen: boolean, maxZoom = 220): Camera {
  const scale = viewportScale(size);
  const drawer = panelOpen && !size.mobile ? Math.min(400, size.width * .36) : 0;
  const availableWidth = Math.max(240, (size.width - drawer) * .82);
  const availableHeight = Math.max(240, size.height * (panelOpen && size.mobile ? .38 : .76));
  const points = locations.map(projectLocation);
  const bounds = points.reduce(([left, top, right, bottom], [x, y]) => [
    Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  const [left, top, right, bottom] = bounds;
  const location = atlasProjection.invert!([(left + right) / 2, (top + bottom) / 2]) || locations[0];
  const factor = Math.min(availableWidth / Math.max(right - left, .001), availableHeight / Math.max(bottom - top, .001));
  const anchor: Coordinate = [800, 450];
  return cameraAt(location, clamp(factor / (scale * worldCamera(size).base.k), 1.5, maxZoom), size, anchor);
}

export function focusPhotoCluster(locations: Coordinate[], size: MapSize, panelOpen: boolean, currentZoom: number): Camera {
  const points = locations.slice(0, 8).map(projectLocation);
  let nearest = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = 0; j < i; j++) {
      const distance = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
      if (distance > .00001) nearest = Math.min(nearest, distance);
    }
  }
  const separatedZoom = nearest === Infinity ? 360 : 68 / (nearest * viewportScale(size) * worldCamera(size).base.k);
  const maxZoom = Math.min(maxMapZoom, Math.max(separatedZoom, currentZoom * 2.3));
  return fitLocations(locations, size, panelOpen, maxZoom);
}

export function zoomCamera(current: Camera, factor: number, anchor: Coordinate): Camera {
  if (!Number.isFinite(factor) || factor <= 0) return current;
  const zoom = clamp(current.zoom * factor, 1, maxMapZoom);
  if (zoom === current.zoom) return current;
  if (zoom === 1) return { ...current, zoom, detail: 0, anchored: false };
  const { x, y, k } = current.base;
  return {
    ...current, zoom, anchor, anchored: true,
    base: { k, x: current.anchor[0] / current.zoom + x - current.anchor[0] + anchor[0] * (1 - 1 / current.zoom),
      y: current.anchor[1] / current.zoom + y - current.anchor[1] + anchor[1] * (1 - 1 / current.zoom) },
  };
}

export function dragCamera(start: Camera, dx: number, dy: number, size: MapSize): Camera {
  const { morph, radius } = cameraFrame(start, size);
  if (morph > .25) {
    const speed = 5 * radius / 360;
    return { ...start, location: [((start.location[0] - dx / speed + 180) % 360 + 360) % 360 - 180, clamp(start.location[1] + dy / speed, -80, 80)] };
  }
  return { ...start, base: { ...start.base, x: start.base.x + dx, y: start.base.y + dy }, anchor: [start.anchor[0] + dx, start.anchor[1] + dy] };
}

export function cameraInterpolation(from: Camera, to: Camera) {
  const location = geoInterpolate(from.location, to.location);
  return (t: number): Camera => {
    if (t <= 0) return from;
    if (t >= 1) return to;
    const zoom = from.zoom * (to.zoom / from.zoom) ** t;
    // Interpolate the viewport offsets in screen space so distant targets don't whip past as the scale grows.
    const offset = (axis: 'x' | 'y', index: 0 | 1) => {
      const start = from.base[axis] + from.anchor[index] / from.zoom - from.anchor[index];
      const end = to.base[axis] + to.anchor[index] / to.zoom - to.anchor[index];
      const weight = Math.abs(to.zoom - from.zoom) < .0001 ? t : (1 / zoom - 1 / from.zoom) / (1 / to.zoom - 1 / from.zoom);
      return mix(start, end, weight);
    };
    const anchor: Coordinate = [mix(from.anchor[0], to.anchor[0], t), mix(from.anchor[1], to.anchor[1], t)];
    return {
      zoom, anchor,
      base: { x: offset('x', 0) + anchor[0] - anchor[0] / zoom,
        y: offset('y', 1) + anchor[1] - anchor[1] / zoom, k: mix(from.base.k, to.base.k, t) },
      location: location(t),
      detail: mix(from.detail, to.detail, t),
      anchored: from.anchored || to.anchored,
    };
  };
}
