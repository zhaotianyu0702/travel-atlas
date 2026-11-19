'use client';

import { useEffect, useRef, useState } from 'react';
import type { Map as LibreMap, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import originalStyle from '../public/atlas-map-style.json';
import type { Coordinate, MapSize } from './atlas-camera';

type Props = {
  size: MapSize;
  center: Coordinate;
  zoom: number;
  opacity: number;
  onReadyChange?: (ready: boolean) => void;
};

// The old style's world.geojson is a small-scale coastline. At street scale,
// the paper background is land and OpenMapTiles supplies detailed water on top.
const detailedStyle = {
  ...originalStyle,
  projection: { type: 'mercator' },
  sources: { openmaptiles: originalStyle.sources.openmaptiles },
  layers: originalStyle.layers
    .filter(layer => layer.id !== 'atlas-land')
    .map(layer => layer.id === 'background'
      ? { ...layer, paint: { 'background-color': '#E7DCC6' } }
      : layer),
} as unknown as StyleSpecification;

export default function AtlasStreetMap({ size, center, zoom, opacity, onReadyChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const camera = useRef({ center, zoom });
  const callback = useRef(onReadyChange);
  const [ready, setReady] = useState(false);
  const [longitude, latitude] = center;
  useEffect(() => { callback.current = onReadyChange; }, [onReadyChange]);
  useEffect(() => {
    camera.current = { center: [longitude, latitude], zoom };
    map.current?.jumpTo({ center: [longitude, latitude], zoom, bearing: 0, pitch: 0 });
  }, [longitude, latitude, zoom]);

  useEffect(() => {
    let cancelled = false;
    let instance: LibreMap | null = null;
    void import('maplibre-gl').then(module => {
      if (cancelled || !host.current) return;
      module.setWorkerUrl('/atlas-maplibre-worker.mjs');
      instance = new module.Map({
        container: host.current,
        style: detailedStyle,
        center: camera.current.center,
        zoom: camera.current.zoom,
        bearing: 0,
        pitch: 0,
        interactive: false,
        attributionControl: false,
        renderWorldCopies: false,
        fadeDuration: 0,
        transformRequest: url => ({ url, referrerPolicy: 'no-referrer' }),
      });
      map.current = instance;
      const markReady = () => {
        if (!cancelled && instance?.isStyleLoaded() && instance.areTilesLoaded()) {
          setReady(true);
          callback.current?.(true);
          instance.off('idle', markReady);
        }
      };
      instance.on('idle', markReady);
    }).catch(() => { if (!cancelled) callback.current?.(false); });
    return () => {
      cancelled = true;
      map.current = null;
      instance?.remove();
      callback.current?.(false);
    };
  }, []);

  useEffect(() => { map.current?.resize(); }, [size.width, size.height]);

  return <div
    ref={host}
    className="atlas-street-map"
    data-street-ready={String(ready)}
    data-street-detail={ready ? 'rendered' : 'loading'}
    aria-hidden="true"
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none', opacity: ready ? opacity : 0 }}
  />;
}
