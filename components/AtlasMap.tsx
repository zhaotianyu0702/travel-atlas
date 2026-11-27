'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { geoDistance, geoGraticule10, geoOrthographic, geoPath, geoProjection } from 'd3-geo';
import { Globe2, Maximize, Minus, Plus } from 'lucide-react';
import type { FeatureCollection, LineString } from 'geojson';
import type { EstimatedRoute, Photo } from '@/lib/types';
import { locatedPhotos, timelineRouteData } from '@/lib/map-data';
import {
  atlasPath, atlasProjection, cameraAt, cameraFrame, cameraInterpolation, clamp, dragCamera,
  dragStreetCamera, fitLocations, focusPhotoCluster, projectLocation, smoothstep,
  streetCamera, streetFull, streetPoint, streetStart, viewportScale, worldCamera, zoomCamera, zoomStreetCamera,
  type Camera, type Coordinate, type MapSize,
} from './atlas-camera';
import { createGlobeRenderer } from './atlas-globe';
import AtlasMapDetails from './AtlasMapDetails';
import AtlasStreetMap from './AtlasStreetMap';
import './atlas-map.css';

type Props = {
  photos: Photo[];
  onSelectPhoto: (photo: Photo) => void;
  focusTripId: string;
  focusVersion: number;
  overviewVersion: number;
  focusPhotoId?: string;
  focusPhotoVersion?: number;
  trackPhotoId?: string;
  onClearTrack?: () => void;
  showRoute?: boolean;
  estimatedRoutes?: EstimatedRoute[];
  tripMarkers?: { id: string; title: string; latitude: number; longitude: number; color: string; coverUrl?: string }[];
  onSelectTrip?: (tripId: string) => void;
  panelOpen?: boolean;
};

const initialSize: MapSize = { width: 0, height: 0, mobile: false };
const sphere = { type: 'Sphere' } as const;
const graticule = geoGraticule10();
const flatGlobe = atlasPath(sphere) ?? '';
const flatGrid = atlasPath(graticule) ?? '';
const coordinates = (photo: Photo): Coordinate => [photo.longitude!, photo.latitude!];
const zoomStep = 1.8;
const thumbnailLimit = 8;
const emptyRoutes: EstimatedRoute[] = [];

export default function AtlasMap({ photos, onSelectPhoto, focusTripId, focusVersion, overviewVersion, focusPhotoId, focusPhotoVersion, trackPhotoId, onClearTrack, showRoute = true, estimatedRoutes = emptyRoutes, tripMarkers, onSelectTrip, panelOpen = false }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const renderer = useRef<ReturnType<typeof createGlobeRenderer>>(null);
  const animationFrame = useRef(0);
  const animationTarget = useRef<Camera | null>(null);
  const gestureFrame = useRef(0);
  const pending = useRef<Camera | null>(null);
  const sizeRef = useRef(initialSize);
  const current = useRef(worldCamera(initialSize));
  const pointers = useRef(new Map<number, Coordinate>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const drag = useRef<{ origin: Coordinate; start: Camera; id: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [camera, setCamera] = useState(() => worldCamera(initialSize));
  const [size, setSize] = useState(initialSize);
  const [world, setWorld] = useState<FeatureCollection | null>(null);
  const [webgl, setWebgl] = useState(false);
  const [streetReady, setStreetReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [chosen, setChosen] = useState<{ photos: Photo[]; zoom: number } | null>(null);
  const key = useId();

  const apply = useCallback((next: Camera) => { current.current = next; setCamera(next); }, []);
  const stopMotion = useCallback(() => {
    cancelAnimationFrame(animationFrame.current);
    animationFrame.current = 0;
    animationTarget.current = null;
  }, []);
  const flushGesture = useCallback(() => {
    cancelAnimationFrame(gestureFrame.current);
    gestureFrame.current = 0;
    if (pending.current) { apply(pending.current); pending.current = null; }
  }, [apply]);
  const queueGesture = useCallback((next: Camera) => {
    stopMotion();
    pending.current = next;
    if (!gestureFrame.current) gestureFrame.current = requestAnimationFrame(flushGesture);
  }, [stopMotion, flushGesture]);
  const animate = useCallback((target: Camera) => {
    stopMotion();
    flushGesture();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(target); return; }
    animationTarget.current = target;
    const from = current.current;
    const interpolate = cameraInterpolation(from, target);
    const crossesProjection = (from.zoom < 1.5) !== (target.zoom < 1.5);
    const duration = crossesProjection ? 680 : clamp(270 + 58 * Math.abs(Math.log2(target.zoom / from.zoom)), 280, 630);
    const start = performance.now();
    const tick = (now: number) => {
      const t = clamp((now - start) / duration, 0, 1);
      apply(interpolate(t ** 3 * (t * (t * 6 - 15) + 10)));
      animationFrame.current = t < 1 ? requestAnimationFrame(tick) : 0;
      if (t === 1) animationTarget.current = null;
    };
    animationFrame.current = requestAnimationFrame(tick);
  }, [apply, flushGesture, stopMotion]);
  const reset = useCallback(() => {
    setChosen(null);
    animate(worldCamera(sizeRef.current));
  }, [animate]);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const resize = () => {
      const next = { width: node.clientWidth, height: node.clientHeight, mobile: window.innerWidth <= 600 };
      const old = sizeRef.current;
      if (old.width === next.width && old.height === next.height && old.mobile === next.mobile) return;
      const oldBase = worldCamera(old);
      const nextBase = worldCamera(next);
      const active = pending.current ?? current.current;
      if (oldBase.base.x !== nextBase.base.x || oldBase.base.y !== nextBase.base.y || oldBase.base.k !== nextBase.base.k) {
        stopMotion();
        flushGesture();
        const dx = nextBase.base.x - oldBase.base.x;
        const dy = nextBase.base.y - oldBase.base.y;
        apply({ ...active, base: { x: active.base.x + dx, y: active.base.y + dy, k: nextBase.base.k },
          anchor: active.anchored ? [active.anchor[0] + dx, active.anchor[1] + dy] : nextBase.anchor });
      }
      sizeRef.current = next;
      setSize(next);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [apply, stopMotion, flushGesture]);

  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const controller = new AbortController();
    const onLost = () => setWebgl(false);
    const onRestored = () => setWebgl(Boolean(renderer.current));
    fetch('/world.geojson', { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error('Could not load the map');
      return response.json() as Promise<FeatureCollection>;
    }).then((data) => {
      if (controller.signal.aborted) return;
      setWorld(data);
      renderer.current = createGlobeRenderer(node, data);
      node.addEventListener('webglcontextlost', onLost);
      node.addEventListener('webglcontextrestored', onRestored);
      setWebgl(Boolean(renderer.current));
    }).catch(() => { if (!controller.signal.aborted) setLoadFailed(true); });
    return () => {
      controller.abort();
      stopMotion();
      cancelAnimationFrame(gestureFrame.current);
      gestureFrame.current = 0;
      pending.current = null;
      node.removeEventListener('webglcontextlost', onLost);
      node.removeEventListener('webglcontextrestored', onRestored);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [stopMotion]);

  const frame = useMemo(() => cameraFrame(camera, size), [camera, size]);
  const street = useMemo(() => streetCamera(frame.flatCamera, size), [frame, size]);
  const streetOpacity = streetReady ? smoothstep((camera.zoom - streetStart) / (streetFull - streetStart)) : 0;
  useLayoutEffect(() => {
    if (webgl && size.width && size.height) renderer.current?.render(frame);
  }, [frame, size, webgl]);

  const points = useMemo(() => locatedPhotos(photos), [photos]);
  const pointsRef = useRef(points);
  useLayoutEffect(() => { pointsRef.current = points; }, [points]);
  const route = useMemo(() => timelineRouteData(points), [points]);
  const roadRoute = useMemo<FeatureCollection<LineString>>(() => ({
    type: 'FeatureCollection',
    features: estimatedRoutes.flatMap(item => item.segments.map(segment => ({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: segment.coordinates },
    }))),
  }), [estimatedRoutes]);
  const trackedLocation = trackPhotoId && points.some(point => point.id === trackPhotoId) ? trackPhotoId : undefined;

  const focus = useCallback((list: Photo[], single = false) => {
    if (!list.length) return;
    setChosen(null);
    animate(fitLocations(list.map(coordinates), sizeRef.current, panelOpen, single ? 1800 : 220));
  }, [animate, panelOpen]);
  useEffect(() => { if (overviewVersion > 0) reset(); }, [overviewVersion, reset]);
  useEffect(() => { if (focusTripId) focus(pointsRef.current); }, [focusTripId, focusVersion, focus]);
  useEffect(() => { if (focusPhotoId) focus(pointsRef.current.filter(photo => photo.id === focusPhotoId), true); }, [focusPhotoId, focusPhotoVersion, focus]);

  const svgPoint = useCallback((clientX: number, clientY: number): Coordinate => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return worldCamera(sizeRef.current).anchor;
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return [point.x, point.y];
  }, []);
  const zoomAt = useCallback((previous: Camera, factor: number, anchor: Coordinate) => {
    const frame = cameraFrame(previous, sizeRef.current);
    const next = zoomCamera(previous, factor, anchor);
    if (next === previous) return previous;
    if (streetReady && previous.zoom >= streetFull && next.zoom >= streetFull) {
      return zoomStreetCamera(previous, next, anchor, sizeRef.current);
    }
    if (frame.morph === 1 && next.zoom > previous.zoom) {
      const fromCenter = Math.hypot(anchor[0] - frame.center[0], anchor[1] - frame.center[1]);
      const globe = geoOrthographic().rotate([-frame.longitude, -frame.latitude]).scale(frame.radius).translate(frame.center);
      const location = fromCenter <= frame.radius ? globe.invert?.(anchor) : previous.location;
      if (location) return cameraAt(location, next.zoom, sizeRef.current, anchor);
    }
    if (frame.morph === 0 && next.zoom < 1.5) {
      const flat = frame.flatCamera;
      const location = atlasProjection.invert?.([(800 - flat.x) / flat.k, (450 - flat.y) / flat.k]);
      if (location?.every(Number.isFinite)) return { ...next, location };
    }
    return next;
  }, [streetReady]);
  const gestureZoom = useCallback((factor: number, x: number, y: number) => {
    const previous = pending.current ?? current.current;
    const next = zoomAt(previous, factor, svgPoint(x, y));
    if (next !== previous) queueGesture(next);
  }, [queueGesture, svgPoint, zoomAt]);
  useEffect(() => {
    const node = svg.current;
    if (!node) return;
    let nativePinch: { scale: number } | null = null;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (nativePinch || pinch.current) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1);
      const speed = event.ctrlKey ? .008 : .0055;
      gestureZoom(Math.exp(clamp(-delta * speed, -.8, .8)), event.clientX, event.clientY);
    };
    const start = (event: Event) => { event.preventDefault(); if (!pinch.current) nativePinch = { scale: 1 }; };
    const change = (event: Event) => {
      event.preventDefault();
      const { scale, clientX, clientY } = event as Event & { scale: number; clientX: number; clientY: number };
      if (!nativePinch || pinch.current || !Number.isFinite(scale) || scale <= 0) return;
      const box = node.getBoundingClientRect();
      gestureZoom(scale / nativePinch.scale, clientX ?? box.left + box.width / 2, clientY ?? box.top + box.height / 2);
      nativePinch.scale = scale;
    };
    const end = (event: Event) => { event.preventDefault(); nativePinch = null; };
    node.addEventListener('wheel', wheel, { passive: false });
    node.addEventListener('gesturestart', start, { passive: false });
    node.addEventListener('gesturechange', change, { passive: false });
    node.addEventListener('gestureend', end, { passive: false });
    return () => {
      node.removeEventListener('wheel', wheel);
      node.removeEventListener('gesturestart', start);
      node.removeEventListener('gesturechange', change);
      node.removeEventListener('gestureend', end);
    };
  }, [gestureZoom]);

  const buttonZoom = (factor: number, anchor = worldCamera(sizeRef.current).anchor) => {
    const previous = pending.current ?? animationTarget.current ?? current.current;
    const next = zoomAt(previous, factor, anchor);
    if (next !== previous) animate(next);
  };
  const toggleProjection = () => {
    if ((pending.current ?? animationTarget.current ?? current.current).zoom > 1.05) { reset(); return; }
    buttonZoom(1.5);
  };

  const projectGlobe = useMemo(() => geoOrthographic().rotate([-frame.longitude, -frame.latitude]).scale(frame.radius).translate(frame.center), [frame]);
  const { flatCamera, morph } = frame;
  const flatTransform = `translate(${flatCamera.x} ${flatCamera.y}) scale(${flatCamera.k})`;
  const flatPoint = (point: Coordinate): Coordinate => {
    const [x, y] = projectLocation(point);
    const equal: Coordinate = [flatCamera.x + x * flatCamera.k, flatCamera.y + y * flatCamera.k];
    if (!streetOpacity) return equal;
    const [sx, sy] = streetPoint(point, street);
    return [equal[0] + (sx - equal[0]) * streetOpacity, equal[1] + (sy - equal[1]) * streetOpacity];
  };
  const morphPoint = (point: Coordinate): Coordinate => {
    const [fx, fy] = flatPoint(point);
    const [gx, gy] = projectGlobe(point)!;
    return [fx + (gx - fx) * morph, fy + (gy - fy) * morph];
  };
  const routePath = morph === 0 ? atlasPath : morph === 1 ? geoPath(projectGlobe) : geoPath(
    geoProjection((lambda, phi) => {
      const [x, y] = morphPoint([Math.min(192 - 1e-7, lambda * 180 / Math.PI + 12), phi * 180 / Math.PI]);
      return [x, -y];
    }).rotate([-12, 0]).scale(1).translate(morphPoint([12, 0])).precision(.4),
  );
  const streetRoutePath = (data: FeatureCollection<LineString>) => data.features.map(feature => {
    let previous: number | null = null;
    return feature.geometry.coordinates.map(point => {
      const [x, y] = flatPoint(point as Coordinate);
      const move = previous === null || Math.abs(x - previous) > street.worldSize / 2;
      previous = x;
      return `${move ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join('');
  }).join('');
  const clipFade = 1 - smoothstep((morph - .3) / .7);
  const scale = viewportScale(size);
  const clusters: { x: number; y: number; opacity: number; photos: Photo[] }[] = [];
  const grid = new Map<string, typeof clusters>();
  const clusterRadius = 26 / scale;
  const expanded = chosen && chosen.photos.length <= thumbnailLimit && camera.zoom >= chosen.zoom * .85 && morph === 0
    ? chosen.photos.filter(photo => points.some(point => point.id === photo.id)) : [];
  const expandedIds = new Set(expanded.map(photo => photo.id));
  for (const photo of tripMarkers === undefined ? points : []) {
    if (expandedIds.has(photo.id)) continue;
    const point = coordinates(photo);
    const back = geoDistance(camera.location, point) > Math.PI / 2 - .015;
    if (back && clipFade < .01) continue;
    const position = morphPoint(point);
    const gx = Math.floor(position[0] / clusterRadius), gy = Math.floor(position[1] / clusterRadius);
    const opacity = back ? clipFade : 1;
    let group: typeof clusters[number] | undefined;
    for (let i = -1; i <= 1 && !group; i++) for (let j = -1; j <= 1 && !group; j++) {
      group = grid.get(`${gx + i}:${gy + j}`)?.find(g => g.opacity === opacity && Math.hypot(g.x - position[0], g.y - position[1]) < clusterRadius);
    }
    if (group) group.photos.push(photo);
    else {
      group = { x: position[0], y: position[1], opacity, photos: [photo] };
      clusters.push(group);
      const bin = `${gx}:${gy}`;
      const neighbors = grid.get(bin);
      if (neighbors) neighbors.push(group);
      else grid.set(bin, [group]);
    }
  }
  const flatLand = useMemo(() => world && !webgl ? atlasPath(world) ?? '' : '', [world, webgl]);
  const choose = (list: Photo[]) => {
    if (list.length === 1) { setChosen(null); onSelectPhoto(list[0]); return; }
    const previous = animationTarget.current ?? current.current;
    const target = focusPhotoCluster(list.map(coordinates), sizeRef.current, panelOpen, previous.zoom);
    setChosen({ photos: list, zoom: target.zoom });
    animate(target);
  };
  const expandedPositions = expanded.map(photo => ({ photo, position: flatPoint(coordinates(photo)) }));
  const separated = expandedPositions.every(({ position: [x, y] }, index) => expandedPositions.slice(0, index)
    .every(({ position: [px, py] }) => Math.hypot(x - px, y - py) * scale >= 60));
  const center = expandedPositions.reduce<Coordinate>(([x, y], { position }) =>
    [x + position[0] / expandedPositions.length, y + position[1] / expandedPositions.length], [0, 0]);
  const onEndPointer = (id: number) => {
    pointers.current.delete(id);
    if (pointers.current.size < 2) pinch.current = null;
    if (drag.current?.id === id) drag.current = null;
  };

  return <div className="atlas-map-v2" ref={root} data-panel-open={panelOpen} data-map-projection={morph === 0 ? 'flat' : morph === 1 ? 'globe' : 'transition'} data-map-zoom={camera.zoom.toFixed(3)} data-map-webgl={String(webgl)} data-track-photo={trackedLocation} data-visible-photo-count={points.length} data-map-basemap={streetOpacity===1?'streets':streetOpacity>0?'crossfade':'atlas'}>
    <canvas ref={canvas} className="atlas-globe-canvas" aria-hidden="true" hidden={!webgl} />
    {camera.zoom >= streetStart * .7 && <AtlasStreetMap size={size} center={street.center} zoom={street.zoom}
      opacity={streetOpacity} onReadyChange={setStreetReady}/>}
    <svg ref={svg} className="atlas-map-overlay" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet" aria-label="Interactive map of photo locations" tabIndex={0}
      onDoubleClick={event => {
        if ((event.target as Element).closest('[data-marker],[data-trip-marker]')) return;
        event.preventDefault();
        buttonZoom(event.shiftKey ? 1 / zoomStep : zoomStep, svgPoint(event.clientX, event.clientY));
      }}
      onClick={event => {
        if (!suppressClick.current && !(event.target as Element).closest('[data-marker],[data-trip-marker]')) setChosen(null);
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === '+' || event.key === '=') { event.preventDefault(); buttonZoom(zoomStep); }
        else if (event.key === '-') { event.preventDefault(); buttonZoom(1 / zoomStep); }
        else if (event.key === 'Escape') { setChosen(null); }
        else if (event.key === 'Home') { event.preventDefault(); reset(); }
        else if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          const dx = event.key === 'ArrowRight' ? -65 : event.key === 'ArrowLeft' ? 65 : 0;
          const dy = event.key === 'ArrowDown' ? -65 : event.key === 'ArrowUp' ? 65 : 0;
          const active = pending.current ?? current.current;
          animate(streetReady && active.zoom>=streetFull ? dragStreetCamera(active, dx, dy, sizeRef.current) : dragCamera(active, dx, dy, sizeRef.current));
        }
      }}
      onPointerDown={event => {
        if (event.button !== 0 && event.pointerType !== 'touch') return;
        const node = event.currentTarget;
        pointers.current.set(event.pointerId, [event.clientX, event.clientY]);
        if (pointers.current.size === 2) {
          const [a, b] = [...pointers.current.values()];
          stopMotion(); flushGesture();
          pinch.current = { distance: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])), zoom: current.current.zoom };
          drag.current = null;
          suppressClick.current = true;
          for (const id of pointers.current.keys()) node.setPointerCapture(id);
          return;
        }
        if (pointers.current.size !== 1) return;
        suppressClick.current = false;
        drag.current = { origin: [event.clientX, event.clientY], start: pending.current ?? current.current, id: event.pointerId, moved: false };
      }}
      onPointerMove={event => {
        if (!pointers.current.has(event.pointerId)) return;
        const point: Coordinate = [event.clientX, event.clientY];
        pointers.current.set(event.pointerId, point);
        if (pinch.current && pointers.current.size >= 2) {
          const [a, b] = [...pointers.current.values()];
          const target = pinch.current.zoom * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.current.distance;
          gestureZoom(target / (pending.current ?? current.current).zoom, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
          return;
        }
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        const dx = point[0] - active.origin[0], dy = point[1] - active.origin[1];
        if (!active.moved && Math.hypot(dx, dy) < 4) return;
        if (!active.moved) {
          active.moved = true;
          active.start = pending.current ?? current.current;
          suppressClick.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        const ratio = viewportScale(sizeRef.current);
        queueGesture(streetReady && active.start.zoom>=streetFull
          ? dragStreetCamera(active.start, dx / ratio, dy / ratio, sizeRef.current)
          : dragCamera(active.start, dx / ratio, dy / ratio, sizeRef.current));
      }}
      onPointerUp={event => onEndPointer(event.pointerId)} onPointerCancel={event => onEndPointer(event.pointerId)} onLostPointerCapture={event => onEndPointer(event.pointerId)}
      onPointerLeave={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) onEndPointer(event.pointerId); }}>
      {!webgl && <g aria-hidden="true" className="atlas-svg-basemap" opacity={1-streetOpacity}>
        <defs><radialGradient id={`${key}-globe`} cx="38%" cy="30%" r="70%"><stop stopColor="#9cbac0"/><stop offset="1" stopColor="#7899a3"/></radialGradient></defs>
        {morph < 1 && <g transform={flatTransform} opacity={1 - morph}><path className="atlas-svg-ocean" d={flatGlobe}/><path className="atlas-svg-grid" d={flatGrid}/><path className="atlas-svg-land" d={flatLand}/></g>}
        {morph > 0 && <g opacity={morph}><circle cx={frame.center[0]} cy={frame.center[1]} r={frame.radius} fill={`url(#${key}-globe)`}/><path className="atlas-svg-grid" d={geoPath(projectGlobe)(graticule) ?? ''}/>{world && <path className="atlas-svg-land" d={geoPath(projectGlobe)(world) ?? ''}/>}</g>}
      </g>}
      <AtlasMapDetails size={size} flatCamera={flatCamera} opacity={(1 - morph) * (1-streetOpacity)} panelOpen={panelOpen}/>
      {showRoute && tripMarkers === undefined && <g className="atlas-route" transform={morph === 0 && !streetOpacity ? flatTransform : undefined} aria-hidden="true">
        <path d={streetOpacity ? streetRoutePath(route) : routePath(route) ?? ''} opacity={morph === 0 || morph === 1 ? 1 : .5 + .5 * Math.abs(2 * morph - 1)} />
        {roadRoute.features.length > 0 && <path className="atlas-estimated-route" d={streetOpacity ? streetRoutePath(roadRoute) : routePath(roadRoute) ?? ''}/>}
      </g>}
      {tripMarkers?.filter(marker => Number.isFinite(marker.latitude) && Number.isFinite(marker.longitude) && Math.abs(marker.latitude) <= 90 && Math.abs(marker.longitude) <= 180).map((marker, index) => {
        const point: Coordinate = [marker.longitude, marker.latitude];
        const back = geoDistance(camera.location, point) > Math.PI / 2 - .015;
        const opacity = back ? clipFade : 1;
        const [x, y] = morphPoint(point);
        return <g key={marker.id} data-trip-marker="true" data-trip-id={marker.id} transform={`translate(${x} ${y}) scale(${1 / scale})`} opacity={opacity}
          role="button" tabIndex={opacity >= .5 ? 0 : -1} aria-hidden={opacity < .5 || undefined} aria-label={`Open trip ${marker.title}`}
          onClick={() => { if (!suppressClick.current && opacity >= .5) onSelectTrip?.(marker.id); }}
          onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && opacity >= .5) { event.preventDefault(); onSelectTrip?.(marker.id); } }}>
          <circle className="atlas-trip-marker-halo" r="22"/><circle className="atlas-trip-marker" r="16" fill={marker.color}/><circle className="atlas-trip-marker-dot" r="4"/>
          {marker.coverUrl && <g className="atlas-trip-cover" aria-hidden="true">
            <clipPath id={`${key}-trip-${index}`}><circle r="16"/></clipPath>
            <image href={marker.coverUrl} x="-16" y="-16" width="32" height="32" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${key}-trip-${index})`}/>
            <circle className="atlas-trip-cover-rim" r="16"/>
          </g>}
        </g>;
      })}
      {clusters.map(cluster => {
        const active = cluster.photos.some(photo => photo.id === trackedLocation);
        return <g key={cluster.photos[0].id} data-marker="true" data-photo-id={cluster.photos[0].id} transform={`translate(${cluster.x} ${cluster.y}) scale(${1 / scale})`} opacity={cluster.opacity}
          role="button" tabIndex={cluster.opacity >= .5 ? 0 : -1} aria-hidden={cluster.opacity < .5 || undefined} aria-current={active || undefined}
          aria-label={cluster.photos.length === 1 ? `Show photo ${cluster.photos[0].placeName || cluster.photos[0].fileName}` : `Zoom to ${cluster.photos.length} photos`}
          onClick={() => { if (!suppressClick.current && cluster.opacity >= .5) choose(cluster.photos); }}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(cluster.photos); } }}>
          <circle r="17" fill="transparent"/><circle className="atlas-marker-shadow" r={cluster.photos.length > 1 ? 14 : 10}/>
          {active && <circle className="atlas-marker-highlight" r={cluster.photos.length > 1 ? 17 : 13}/>}
          <circle className="atlas-marker" r={cluster.photos.length > 1 ? 10 : 5.5}/>
          {cluster.photos.length > 1 && <text textAnchor="middle" dominantBaseline="central">{cluster.photos.length}</text>}
        </g>;
      })}
      {expandedPositions.map(({ photo, position }, index) => {
        const angle = index / expandedPositions.length * Math.PI * 2 - Math.PI / 2;
        const distance = Math.max(42, 54 / (2 * Math.sin(Math.PI / expandedPositions.length))) / scale;
        const [x, y] = separated ? position : [center[0] + Math.cos(angle) * distance, center[1] + Math.sin(angle) * distance];
        const clipId = `${key}-photo-${index}`;
        return <g key={photo.id}>
          {!separated && <line className="atlas-photo-leader" x1={position[0]} y1={position[1]} x2={x} y2={y}/>}
          <g className="atlas-photo-pin" data-marker="true" data-expanded-photo="true" transform={`translate(${x} ${y}) scale(${1 / scale})`}
            tabIndex={0} role="button" aria-label={`Show photo ${photo.fileName}`} aria-current={photo.id === trackedLocation || undefined}
            onClick={() => { if (!suppressClick.current) onSelectPhoto(photo); }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectPhoto(photo); } }}>
            <title>{photo.placeName || photo.fileName}</title>
            <clipPath id={clipId}><circle r="21"/></clipPath>
            {photo.id === trackedLocation && <circle className="atlas-marker-highlight" r="28"/>}
            <circle className="atlas-photo-pin-rim" r="24"/>
            <image href={`/api/media/${encodeURIComponent(photo.id)}?variant=thumb`} x="-21" y="-21" width="42" height="42" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`}/>
          </g>
        </g>;
      })}
    </svg>
    <div className="atlas-map-controls" aria-label="Map controls">
      <button type="button" onClick={() => buttonZoom(zoomStep)} aria-label="Zoom in" title="Zoom in"><Plus size={19}/></button>
      <button type="button" onClick={() => buttonZoom(1 / zoomStep)} aria-label="Zoom out" title="Zoom out"><Minus size={19}/></button>
      <button type="button" onClick={toggleProjection} aria-label={morph === 0 ? 'Show globe' : 'Show flat map'} aria-pressed={morph === 0} title={morph === 0 ? 'Show globe' : 'Show flat map'}><Globe2 size={18}/></button>
      <button type="button" onClick={() => { if (focusTripId && points.length) { onClearTrack?.(); focus(points); } else reset(); }}
        aria-label={focusTripId ? 'Fit all photo stops' : 'Fit world map'} title={focusTripId ? 'Fit all photo stops' : 'Fit world map'}><Maximize size={17}/></button>
    </div>
    {morph === 0 && <div className="atlas-map-attribution">
      {roadRoute.features.length > 0 && <a className="atlas-route-credit" href="https://project-osrm.org/" target="_blank" rel="noreferrer" title="Estimated driving route from photo stops">Estimated drive · OSRM</a>}
      <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a>
      <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a>
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>
    </div>}
    {chosen && chosen.photos.length > thumbnailLimit && <div className="atlas-map-popup-list" aria-label="Photos at this location" onKeyDown={event => { if (event.key === 'Escape') setChosen(null); }}>
      <button className="atlas-popup-close" type="button" onClick={() => setChosen(null)} aria-label="Close photos">×</button>
      {chosen.photos.map(photo => <button type="button" key={photo.id} onClick={() => { setChosen(null); onSelectPhoto(photo); }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/media/${encodeURIComponent(photo.id)}?variant=thumb`} alt=""/><span>{photo.placeName || photo.fileName}</span>
      </button>)}
    </div>}
    {loadFailed && <div role="status" className="atlas-map-error">Country outlines could not load.</div>}
  </div>;
}
