/**
 * AquaShield 3D — Incident Console
 *
 * Auto-detects GeoLibre:
 *   - If GeoLibre is running → embed it with all 138 dams loaded via ?data= GeoJSON
 *   - If GeoLibre is NOT running → render inline MapLibre GL JS with:
 *     • Esri World Imagery satellite basemap + labels
 *     • 3D terrain DEM (hillshade)
 *     • Flood extent overlay with time slider
 *     • Before/After layer swipe
 *
 * Both modes show the dam sidebar with search + data panel overlay.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, Users, Droplets, AlertTriangle, PanelLeftClose, PanelLeft, Globe, Search, Layers, Play, Pause, RotateCcw, Building, Mountain, Focus, FlaskConical, Box, MapPin } from 'lucide-react';
import { INDIA_DAMS, DamPoint } from '../../data/india-dams';
import { sandboxApi } from '../../api/client';
import Local3DView, { type FloodOverlay } from '../../viewers/local-3d/Local3DView';
import SandboxPanel from './SandboxPanel';
import SandboxTransition from './SandboxTransition';
import LisfloodPanel from '../../components/lisflood/LisfloodPanel';
import { FEATURES } from '../../config';

// Local true-3D terrain models: discovered via /terrain/manifest.json
// (curated by 3d-assets/terrain-pipeline/curate.py — only dams with a
// clean real-DEM reconstruction are listed; everything else is globe).

const GEOLIBRE_BASE = 'http://localhost:5175';
const DAMS_GEOJSON_URL = 'http://localhost:3000/india-dams.geojson';

/** Decode base64 float32 grids (sandbox/LISFLOOD payloads). */
function b64ToF32Console(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** Great-circle distance in km (waypoint readouts). */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function classifyHazard(dam: DamPoint) {  const heightScore = Math.min(dam.height_m / 300, 1);
  const capacityScore = Math.min(dam.capacity_mcm / 15000, 1);
  const composite = heightScore * 0.6 + capacityScore * 0.4;

  if (composite > 0.7) return {
    level: 'EXTREME' as const, color: '#dc2626', bgColor: '#fef2f2',
    description: 'Catastrophic breach potential — massive downstream inundation',
    downstreamPopEstimate: Math.round(dam.capacity_mcm * 85),
  };
  if (composite > 0.45) return {
    level: 'HIGH' as const, color: '#ea580c', bgColor: '#fff7ed',
    description: 'Significant breach risk — major downstream impact',
    downstreamPopEstimate: Math.round(dam.capacity_mcm * 55),
  };
  if (composite > 0.2) return {
    level: 'MODERATE' as const, color: '#ca8a04', bgColor: '#fefce8',
    description: 'Moderate risk — localized flooding expected',
    downstreamPopEstimate: Math.round(dam.capacity_mcm * 30),
  };
  return {
    level: 'LOW' as const, color: '#16a34a', bgColor: '#f0fdf4',
    description: 'Lower risk — limited downstream consequences',
    downstreamPopEstimate: Math.round(dam.capacity_mcm * 15),
  };
}

function formatNumber(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatType(type: string) {
  const map: Record<string, string> = {
    concrete_gravity: 'Concrete Gravity', concrete_arch: 'Concrete Arch',
    earthfill: 'Earthfill', rockfill: 'Rockfill', earthen: 'Earthen',
    masonry: 'Masonry', barrage: 'Barrage',
  };
  return map[type] || type;
}

// ── Generate simulated flood polygon around a dam ──────────────────
function generateFloodPolygon(dam: DamPoint, progress: number): GeoJSON.Feature {
  // Flood expands downstream and laterally over time
  const kmPerDeg = 111;
  const downstreamKm = (dam.capacity_mcm / 500) * progress * 2;
  const lateralKm = downstreamKm * 0.35;
  const segments = 24;
  const coords: [number, number][] = [];

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const rx = (lateralKm / kmPerDeg) * Math.cos(angle) * (1 + 0.5 * Math.sin(angle * 2));
    const ry = (downstreamKm / kmPerDeg) * Math.sin(angle) * (1 + 0.3 * Math.cos(angle * 3));
    coords.push([dam.lon + rx, dam.lat + ry * 0.7]);
  }
  coords.push(coords[0]);

  return {
    type: 'Feature',
    properties: { dam_id: dam.id, progress },
    geometry: { type: 'Polygon', coordinates: [coords] },
  };
}

// ── Inline MapLibre: Satellite + 3D Terrain + Flood Simulation ────
function InlineMapLibre({ onDamClick, selectedDam, onMapReady, focusPoint }: {
  onDamClick: (d: DamPoint) => void; selectedDam: DamPoint | null;
  onMapReady: (map: any) => void;
  focusPoint?: { lon: number; lat: number; label: string; damlon: number; damlat: number } | null;
}) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [floodProgress, setFloodProgress] = useState(0);
  const [floodPlaying, setFloodPlaying] = useState(false);
  const [showFlood, setShowFlood] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showBuildings, setShowBuildings] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const defaultZoomRef = useRef<{ min: number; max: number } | null>(null);

  const floodIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── City waypoint (Evacuation Planner links): amber dot + dashed dam link
  useEffect(() => {
    const apply = () => {
      const map = mapRef.current;
      if (!map || !map.getSource || !map.isStyleLoaded?.()) return false;
      try {
        for (const l of ['city-focus-dot', 'city-focus-line']) {
          if (map.getLayer(l)) map.removeLayer(l);
        }
        if (map.getSource('city-focus')) map.removeSource('city-focus');
        if (!focusPoint) return true;
        map.addSource('city-focus', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', geometry: { type: 'Point', coordinates: [focusPoint.lon, focusPoint.lat] }, properties: { label: focusPoint.label } },
              { type: 'Feature', geometry: { type: 'LineString', coordinates: [[focusPoint.damlon, focusPoint.damlat], [focusPoint.lon, focusPoint.lat]] }, properties: {} },
            ],
          },
        });
        map.addLayer({
          id: 'city-focus-line', type: 'line', source: 'city-focus',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: { 'line-color': '#65BFA9', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 },
        });
        map.addLayer({
          id: 'city-focus-dot', type: 'circle', source: 'city-focus',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: { 'circle-radius': 9, 'circle-color': '#D8B24C', 'circle-stroke-color': '#071018', 'circle-stroke-width': 2 },
        });
        return true;
      } catch {
        return false;
      }
    };
    if (!apply()) {
      const t = setTimeout(apply, 2500);
      return () => clearTimeout(t);
    }
  }, [focusPoint]);

  // ── Dam-focus mode: globe stops rendering, only dam + nearby area ──
  // MapLibre has no globe.show=false (that's Cesium-only). Instead we flip
  // the projection globe→mercator (the globe sphere is gone entirely) and
  // lock maxBounds/minZoom around the dam so no out-of-area tiles ever load.
  const FOCUS_HALF_DEG = 0.055; // ~6 km each way
  const enterFocusMode = useCallback((dam: DamPoint) => {
    const map = mapRef.current;
    if (!map) return;
    try {
      if (!defaultZoomRef.current) {
        defaultZoomRef.current = { min: map.getMinZoom(), max: map.getMaxZoom() };
      }
      map.setProjection({ type: 'mercator' });
      map.setMaxBounds([
        [dam.lon - FOCUS_HALF_DEG, dam.lat - FOCUS_HALF_DEG],
        [dam.lon + FOCUS_HALF_DEG, dam.lat + FOCUS_HALF_DEG],
      ]);
      map.setMinZoom(11.5);
      map.setMaxZoom(17);
      map.flyTo({
        center: [dam.lon, dam.lat], zoom: 13.5, pitch: 65, bearing: 30,
        duration: 2500, essential: true,
      });
      setFocusMode(true);
    } catch (e) { console.warn('Focus mode:', e); }
  }, []);

  const exitFocusMode = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      map.setMaxBounds(null);
      if (defaultZoomRef.current) {
        map.setMinZoom(defaultZoomRef.current.min);
        map.setMaxZoom(defaultZoomRef.current.max);
      }
      map.setProjection({ type: 'globe' });
      map.flyTo({
        center: [78.5, 21.5], zoom: 3.4, pitch: 35, bearing: -17,
        duration: 2500, essential: true,
      });
      setFocusMode(false);
    } catch (e) { console.warn('Exit focus:', e); }
  }, []);

  // Auto-focus whenever a dam is picked (sidebar list or map dot click).
  // The globe initializes async — retry until the map exists.
  useEffect(() => {
    if (!selectedDam) return;
    let tries = 0;
    const id = setInterval(() => {
      tries++;
      if (mapRef.current) {
        enterFocusMode(selectedDam);
        clearInterval(id);
      } else if (tries > 15) {
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [selectedDam, enterFocusMode]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    import('maplibre-gl').then((maplibregl) => {
      const mgl = (maplibregl as any).Map ? maplibregl : (maplibregl as any).default || maplibregl;
      // @ts-ignore — CSS side-effect import not typed
      import('maplibre-gl/dist/maplibre-gl.css').catch(() => {});

      // ── Map style: satellite + terrain DEM (must be in style!) ──
      const style: any = {
        version: 8,
        name: 'AquaShield Satellite 3D',
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          // Esri World Imagery — high-res satellite basemap
          satellite: {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            ],
            tileSize: 256,
            attribution: '© Esri, Maxar, Earthstar Geographics',
            maxzoom: 18,
          },
          // Terrain DEM — Terrarium encoding from AWS elevation-tiles
          // CRITICAL: encoding='terrarium' prevents zigzag spikes & deformed landmarks
          'terrain-dem': {
            type: 'raster-dem',
            tiles: [
              'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
            maxzoom: 14,
            encoding: 'terrarium',
          },
        },
        layers: [
          { id: 'satellite', type: 'raster', source: 'satellite' },
        ],

      };

      const map = new (mgl.Map || mgl)({
        container: mapContainer.current!,
        style,
        center: [78.5, 21.5],
        zoom: 3.4,
        pitch: 35,
        bearing: -17,
        maxPitch: 75,
        fadeDuration: 0,
        antialias: true,
      });



      map.addControl(new mgl.NavigationControl({ visualizePitch: true }), 'top-right');
      map.addControl(new mgl.ScaleControl(), 'bottom-left');
      map.addControl(new mgl.AttributionControl({ compact: true }), 'bottom-right');

      map.on('load', () => {
        // ── 3D Globe ──────────────────────────────────────────
        map.setProjection({ type: 'globe' });
        // Lift the earth above screen centre (bottom padding shifts the
        // visual centre upward) and default-frame India.
        try { map.setPadding({ top: 0, bottom: 200, left: 0, right: 0 }); } catch {}

        // ── 3D Terrain (works partially on globe) ───────────────
        map.setTerrain({ source: 'terrain-dem', exaggeration: 1.0 });

        // ── Hillshade layer ──────────────────────────────────────
        map.addLayer({
          id: 'hillshade-layer',
          type: 'hillshade',
          source: 'terrain-dem',
          paint: {
            'hillshade-exaggeration': 0.8,
            'hillshade-shadow-color': '#1a1040',
            'hillshade-highlight-color': '#ffe8c8',
            'hillshade-accent-color': '#2a6fa7',
          },
        }, 'satellite');

        // ── Labels layer (togglable) ─────────────────────────────
        map.addSource('labels', {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          maxzoom: 18,
        });
        map.addLayer({
          id: 'labels-layer',
          type: 'raster',
          source: 'labels',
          paint: { 'raster-opacity': 0.85 },
        });

        // ── Dam markers ──────────────────────────────────────────
        const features = INDIA_DAMS.map((dam) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [dam.lon, dam.lat] },
          properties: {
            id: dam.id, name: dam.name, state: dam.state, river: dam.river,
            height_m: dam.height_m, capacity_mcm: dam.capacity_mcm,
            type: dam.type, year_built: dam.year_built,
            hazard_color: classifyHazard(dam).color,
          },
        }));

        map.addSource('dams', { type: 'geojson', data: { type: 'FeatureCollection', features } });

        // Glow halo
        map.addLayer({
          id: 'dams-glow', type: 'circle', source: 'dams',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'height_m'], 30, 8, 300, 22],
            'circle-color': ['get', 'hazard_color'],
            'circle-opacity': 0.25,
            'circle-blur': 2,
            'circle-pitch-alignment': 'map',
            'circle-pitch-scale': 'map',
          },
        });

        // Solid dot
        map.addLayer({
          id: 'dams-dots', type: 'circle', source: 'dams',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'height_m'], 30, 4, 300, 12],
            'circle-color': ['get', 'hazard_color'],
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 2,
            'circle-opacity': 0.95,
            'circle-pitch-alignment': 'map',
            'circle-pitch-scale': 'map',
          },
        });

        // Labels
        map.addLayer({
          id: 'dams-labels', type: 'symbol', source: 'dams',
          layout: {
            'text-field': ['to-string', ['get', 'name']],
            'text-size': 11,
            'text-offset': [0, 1.8],
            'text-anchor': 'top',
            'text-allow-overlap': false,
            'text-pitch-alignment': 'map',
          },
          paint: {
            'text-color': '#fff',
            'text-halo-color': 'rgba(0,0,0,0.7)',
            'text-halo-width': 2,
          },
        });

        // ── Flood overlay ────────────────────────────────────────
        map.addSource('flood-extent', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'flood-fill', type: 'fill', source: 'flood-extent',
          paint: {
            'fill-color': [
              'interpolate', ['linear'], ['get', 'progress'],
              0, 'rgba(59,130,246,0.1)',
              0.3, 'rgba(59,130,246,0.25)',
              0.6, 'rgba(37,99,235,0.4)',
              1, 'rgba(30,64,175,0.55)',
            ],
            'fill-opacity': 0.7,
          },
        });
        map.addLayer({
          id: 'flood-outline', type: 'line', source: 'flood-extent',
          paint: {
            'line-color': '#3b82f6',
            'line-width': 2,
            'line-opacity': 0.8,
          },
        });

        // ── Click handler ────────────────────────────────────────
        map.on('click', 'dams-dots', (e: any) => {
          if (!e.features?.length) return;
          const dam = INDIA_DAMS.find(d => d.id === e.features[0].properties.id);
          if (dam) { onDamClick(dam); e.preventDefault(); }
        });
        map.on('mouseenter', 'dams-dots', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'dams-dots', () => { map.getCanvas().style.cursor = ''; });
      });
      mapRef.current = map;
      onMapReady(map);
    });

    return () => { mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />

      {/* ── Focus badge ──────────────────────────────────────────── */}
      {focusMode && selectedDam && (
        <div className="absolute top-3 left-3 z-20 px-3 py-1.5 bg-slate-900/90 text-white text-[10px] font-bold rounded-full shadow-md">
          ◉ Focus: {selectedDam.name} — globe rendering off
        </div>
      )}

      {/* ── Map controls overlay ───────────────────────────────────── */}
      <div className="absolute top-3 right-14 z-20 flex flex-col gap-2">
        {/* Dam-focus toggle: dam + nearby areas only, globe stops rendering */}
        <button onClick={() => { if (focusMode) exitFocusMode(); else if (selectedDam) enterFocusMode(selectedDam); }}
          disabled={!focusMode && !selectedDam}
          className={`p-2 rounded-lg border border-cmd-border bg-[#0A1218]/90 transition-colors ${
            focusMode ? 'text-cmd-teal border-cmd-teal/50'
            : selectedDam ? 'text-cmd-muted hover:text-cmd-ink hover:border-cmd-teal/40'
            : 'text-cmd-muted/40 cursor-not-allowed'
          }`}
          title={focusMode ? 'Exit focus — show full globe' : 'Focus: dam + nearby areas only (globe off)'}>
          <Focus className="w-4 h-4" />
        </button>

        {/* Labels toggle */}
        <button onClick={() => { const next = !showLabels; setShowLabels(next); const map = mapRef.current; if (map && map.getLayer && map.getLayer("labels-layer")) { map.setLayoutProperty("labels-layer", "visibility", next ? "visible" : "none"); } }}
          className={`p-2 rounded-lg border border-cmd-border bg-[#0A1218]/90 transition-colors ${showLabels ? 'text-cmd-teal border-cmd-teal/50' : 'text-cmd-muted hover:text-cmd-ink'}`}
          title="Toggle place labels">
          <Layers className="w-4 h-4" />
        </button>

        {/* Buildings/Terrain toggle */}
        <button onClick={() => {
    const next = !showBuildings;
    setShowBuildings(next);
    const map = mapRef.current;
    if (!map) return;
    try {
      // Destroy current map and create a fresh one (clean WebGL context)
      map.remove();
      mapRef.current = null;

      import('maplibre-gl').then((maplibregl) => {
        const mgl = (maplibregl as any).Map ? maplibregl : (maplibregl as any).default || maplibregl;
        import('maplibre-gl/dist/maplibre-gl.css').catch(() => {});

        const container = mapContainer.current;  // React ref persists after map.remove()
        if (!container) { console.error('No container found'); return; }

        const style = next ? {
          version: 8, name: 'AquaShield Buildings',
          glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
          sources: {
            satellite: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18 },
            buildings: { type: 'vector', tiles: ['https://api.maptiler.com/tiles/v3/{z}/{x}/{y}.pbf?key=ApGvqBRr1WbzGPnokdoZ'], maxzoom: 15 },
          },
          layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
        } : {
          version: 8, name: 'AquaShield Satellite 3D',
          glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
          sources: {
            satellite: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18 },
            'terrain-dem': { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 14, encoding: 'terrarium' },
          },
          layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
        };

        const newMap = new (mgl.Map || mgl)({
          container, style,
          center: next ? [72.88, 19.08] : [78.5, 21.5],
          zoom: next ? 15.5 : 3.4, pitch: next ? 65 : 35, bearing: next ? -30 : -17,
          maxPitch: 75, fadeDuration: 0, antialias: true,
        });

        newMap.addControl(new mgl.NavigationControl({ visualizePitch: true }), 'top-right');
        newMap.addControl(new mgl.ScaleControl(), 'bottom-left');
        newMap.addControl(new mgl.AttributionControl({ compact: true }), 'bottom-right');

        newMap.on('load', () => {
          if (next) {
            newMap.addLayer({ id: '3d-buildings', type: 'fill-extrusion', source: 'buildings', 'source-layer': 'building', minzoom: 13,
              paint: { 'fill-extrusion-color': '#3498db', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 1 } });
            console.log('Fresh map: 3D buildings layer added');
          } else {
            newMap.setProjection({ type: 'globe' });
            newMap.setTerrain({ source: 'terrain-dem', exaggeration: 1.0 });
            newMap.addLayer({ id: 'hillshade-layer', type: 'hillshade', source: 'terrain-dem', paint: { 'hillshade-exaggeration': 0.8, 'hillshade-shadow-color': '#1a1040', 'hillshade-highlight-color': '#ffe8c8', 'hillshade-accent-color': '#2a6fa7' } }, 'satellite');
            newMap.addSource('labels', { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18 });
            newMap.addLayer({ id: 'labels-layer', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.85 } });
            // Re-add dam markers
            const features = INDIA_DAMS.map((dam) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [dam.lon, dam.lat] }, properties: { id: dam.id, name: dam.name, state: dam.state, river: dam.river, height_m: dam.height_m, capacity_mcm: dam.capacity_mcm, type: dam.type, year_built: dam.year_built, hazard_color: classifyHazard(dam).color } }));
            newMap.addSource('dams', { type: 'geojson', data: { type: 'FeatureCollection', features } });
            newMap.addLayer({ id: 'dams-glow', type: 'circle', source: 'dams', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'height_m'], 30, 8, 300, 22], 'circle-color': ['get', 'hazard_color'], 'circle-opacity': 0.25, 'circle-blur': 2, 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map' } });
            newMap.addLayer({ id: 'dams-dots', type: 'circle', source: 'dams', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'height_m'], 30, 4, 300, 12], 'circle-color': ['get', 'hazard_color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': 0.95, 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map' } });
            newMap.addLayer({ id: 'dams-labels', type: 'symbol', source: 'dams', layout: { 'text-field': ['to-string', ['get', 'name']], 'text-size': 11, 'text-offset': [0, 1.8], 'text-anchor': 'top', 'text-allow-overlap': false, 'text-pitch-alignment': 'map' }, paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,0.7)', 'text-halo-width': 2 } });
            console.log('Fresh map: Globe + terrain + dams restored');
          }
        });

        mapRef.current = newMap;
        onMapReady(newMap);
      });
    } catch (e) { console.warn('Buildings toggle:', e); }
  }}
          className={`p-2 rounded-lg border border-cmd-border bg-[#0A1218]/90 transition-colors ${showBuildings ? 'text-cmd-teal border-cmd-teal/50' : 'text-cmd-muted hover:text-cmd-ink'}`}
          title={showBuildings ? "Switch to 3D terrain view" : "Switch to 3D buildings view"}>
          {showBuildings ? <Mountain className="w-4 h-4" /> : <Building className="w-4 h-4" />}
        </button>

        {/* Flood toggle */}
        <button onClick={() => { console.log("Flood click! current=" + showFlood); setShowFlood(!showFlood); if (!showFlood) setFloodProgress(0.5); }}
          className={`p-2 rounded-lg border border-cmd-border bg-[#0A1218]/90 transition-colors ${showFlood ? 'text-cmd-teal border-cmd-teal/50' : 'text-cmd-muted hover:text-cmd-ink'}`}
          title="Toggle flood extent overlay">
          <Droplets className="w-4 h-4" />
        </button>
      </div>

      {/* ── Flood time slider ──────────────────────────────────────── */}
      {showFlood && (
        <div className="absolute bottom-6 left-4 right-4 z-20 bg-[#0A1218]/92 backdrop-blur border border-cmd-border rounded-xl p-3">
          <div className="flex items-center gap-3 mb-2">
            <button onClick={() => { setFloodPlaying(!floodPlaying); }}
              className="p-1.5 rounded-lg bg-cmd-teal/90 text-[#071018] transition-colors">
              {floodPlaying ? <Pause className="w-3.5 h-3.5" strokeWidth={2.25} /> : <Play className="w-3.5 h-3.5" strokeWidth={2.25} />}
            </button>
            <button onClick={() => { setFloodPlaying(false); setFloodProgress(0); }}
              className="p-1.5 rounded-lg border border-cmd-border text-cmd-muted hover:text-cmd-ink transition-colors">
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <div className="flex-1">
              <input
                type="range" min="0" max="100" value={Math.round(floodProgress * 100)}
                onChange={(e) => { setFloodProgress(Number(e.target.value) / 100); setFloodPlaying(false); }}
                className="w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-[#65BFA9] bg-cmd-track"
              />
            </div>
            <span className="text-xs font-mono font-bold text-cmd-ink w-16 text-right tabular-nums">
              T+{Math.round(floodProgress * 120)} min
            </span>
          </div>
          <div className="flex items-center gap-4 text-[10px] text-cmd-muted">
            <span className="tabular-nums">Progress: {Math.round(floodProgress * 100)}%</span>
            <span className="tabular-nums">Flood extent radius: ~{((selectedDam || INDIA_DAMS[0]).capacity_mcm / 500 * floodProgress * 2).toFixed(1)} km</span>
            <span className="ml-auto text-cmd-teal font-semibold">
              {selectedDam ? selectedDam.name : 'Demo: Machhu Dam'} flood simulation
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────
export default function IncidentConsole() {
  const [selectedDam, setSelectedDam] = useState<DamPoint | null>(null);
  // focusedDam drives the 3D/map view; selectedDam drives the details panel.
  // Closing the panel clears selectedDam but leaves the 3D view in place.
  const [focusedDam, setFocusedDam] = useState<DamPoint | null>(null);
  const [forceMap, setForceMap] = useState(false); // user override: globe instead of local 3D
  const [sandboxOpen, setSandboxOpen] = useState(false);
  // Cinematic AI handoff: terrain keeps orbiting behind the transition card
  // until the sequence completes and the real sandbox panel opens.
  const [sandboxTransition, setSandboxTransition] = useState(false);
  const [flood, setFlood] = useState<FloodOverlay | null>(null);
  // LISFLOOD-FP panel (deep-link entry only — the standalone button was
  // removed; the sandbox flow is the primary simulation path).
  const [lisfloodOpen, setLisfloodOpen] = useState(false);
  // Sandbox engine activity (drives the floating "AI is predicting" label).
  const [sandboxBusy, setSandboxBusy] = useState(false);
  // Background-preloaded sandbox results (fired the moment Run Sandbox is hit).
  const [sandboxPreload, setSandboxPreload] = useState<{ cases: any; run: any } | null>(null);
  // Water plays WHILE the thinking card shows: the moment preloaded results
  // land, paint them on the terrain and advance the timeline behind the card.
  const thinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const thinkingRef = useRef(false);
  const thinkTRef = useRef(0);
  // Globe-first flow: after the globe settles on a dam, offer the 3D view.
  const [globeReady3D, setGlobeReady3D] = useState(false);
  // Focused downstream city (from Evacuation Planner): marker + distance card.
  const [cityFocus, setCityFocus] = useState<{
    name: string; lon: number; lat: number;
    damlon: number; damlat: number; depth: string; arr: string;
  } | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const [modelManifest, setModelManifest] = useState<Record<string, { file: string; name: string }> | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [geolibreOnline, setGeolibreOnline] = useState<boolean | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [geolibreReady, setGeolibreReady] = useState(false);
  const mapLibreRef = useRef<any>(null);

  // Local-3D model manifest (curated; keyed by dam id, exact match).
  useEffect(() => {
    fetch('/terrain/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m) setModelManifest(m); })
      .catch(() => {});
  }, []);

  const resolveModelSlug = useCallback((dam: DamPoint): string | null => {
    if (modelManifest && modelManifest[dam.id]) return modelManifest[dam.id].file;
    return null;
  }, [modelManifest]);

  // Check if GeoLibre is running
  useEffect(() => {
    const check = () => {
      fetch(GEOLIBRE_BASE, { mode: 'no-cors' })
        .then(() => setGeolibreOnline(true))
        .catch(() => setGeolibreOnline(false));
    };
    check();
    const interval = setInterval(check, 10000);
    return () => clearInterval(interval);
  }, []);

  // Listen for GeoLibre 'ready' event
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'ready' && event.data?.source === 'geolibre-embed') {
        setGeolibreReady(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Fly to exact dam location
  const flyToDam = useCallback((dam: DamPoint) => {
    if (mapLibreRef.current) {
      mapLibreRef.current.flyTo({
        center: [dam.lon, dam.lat],
        zoom: 13.5,
        pitch: 65,
        bearing: 30,
        duration: 3000,
        essential: true,
      });
    }

    if (iframeRef.current?.contentWindow) {
      const msg = {
        v: 1,
        type: 'setView',
        payload: { center: [dam.lon, dam.lat], zoom: 13.5, duration: 3000 },
        requestId: 'dam-' + dam.id + '-' + Date.now(),
      };
      const target = GEOLIBRE_BASE;
      const send = () => {
        try { iframeRef.current?.contentWindow?.postMessage(msg, target); } catch {}
      };
      send();
      const timers = [setTimeout(send, 1000), setTimeout(send, 2000), setTimeout(send, 4000)];
      setTimeout(() => timers.forEach(clearTimeout), 5000);
    }
  }, []);

  // Warm the 3D terrain in the HTTP cache so the later 3D view opens fast.
  const preloadTerrain = useCallback((dam: DamPoint) => {
    const entry = modelManifest?.[dam.id];
    if (!entry) return;
    const slug = entry.file;
    [`/terrain/${slug}.glb`, `/terrain/${slug}.metadata.json`, `/terrain/${slug}.transform.json`].forEach((u) => {
      fetch(u, { cache: 'force-cache' }).catch(() => {});
    });
  }, [modelManifest]);

  const handleDamClick = useCallback((dam: DamPoint, opts?: { direct3D?: boolean }) => {
    setSelectedDam(dam);
    setFocusedDam(dam);
    setCityFocus(null);
    // Globe-first: the earth zooms to the dam, then the 3D button appears.
    // Deep links with direct=1 (simulation shares) skip straight to 3D.
    setForceMap(!opts?.direct3D);
    setGlobeReady3D(false);
    setSandboxOpen(false);
    setSandboxTransition(false);
    setSandboxPreload(null);
    setLisfloodOpen(false);
    setFlood(null);
    flyToDam(dam);
    // The globe initializes async — retry the flight until the map exists.
    [900, 2200, 4500].forEach((ms) => {
      window.setTimeout(() => flyToDam(dam), ms);
    });
    preloadTerrain(dam);
    window.setTimeout(() => setGlobeReady3D(true), 3400);
  }, [flyToDam, preloadTerrain]);

  // Fire-and-forget sandbox preload: generate + likely-case run start the
  // moment Run Sandbox is hit, while the handoff card shows AI thinking.
  const fireSandboxPreload = useCallback((dam: DamPoint) => {
    setSandboxPreload(null);
    (async () => {
      try {
        const gen: any = await sandboxApi.generate(dam.id, 7, 10);
        const likely = gen?.likely ?? gen?.cases?.likely ?? null;
        const scenario = likely ?? {
          dam_id: dam.id, label: 'likely', reservoir_level_m: 0,
          breach_location: 'dam', breach_width_m: 80, breach_depth_m: 20,
          breach_severity: 'major', initial_release_m3: 25_000_000,
          roughness: 0.05, rainfall_factor: 1.0,
          duration_min: 180, timestep_s: 60, seed: 7,
        };
        const run = await sandboxApi.run(dam.id, scenario, 96);
        setSandboxPreload({ cases: gen, run });
      } catch {
        // Panel falls back to its manual run controls.
      }
    })();
  }, []);

  const handleRunSandbox = useCallback(() => {
    if (!focusedDam) return;
    setLisfloodOpen(false);
    setFlood(null);
    setForceMap(false); // overlays need the 3D mesh
    fireSandboxPreload(focusedDam);
    setSandboxTransition(true);
  }, [focusedDam, fireSandboxPreload]);

  // Deep-link: /incident?dam=d4 auto-selects (also used for screenshots).
  // &sandbox=1 opens the sandbox; &demo=1 auto-loads the offline Tehri demo.
  // &lisflood=1 opens the LISFLOOD-FP panel; &job=<id> loads a completed run.
  // &direct=1 skips the globe-first step (simulation share links).
  // &globeCity=<name>&clon=&clat=&damlon=&damlat=&depth=&arr= focuses a city.
  const [autoDemo, setAutoDemo] = useState(false);
  const [deepJobId, setDeepJobId] = useState<string | null>(null);
  const deepLinkedRef = useRef(false);
  // Declutter: the dam index slides away while a simulation panel owns the
  // viewport; the floating button brings it back.
  useEffect(() => {
    if (sandboxOpen || lisfloodOpen) setSidebarOpen(false);
  }, [sandboxOpen, lisfloodOpen]);

  // Thinking-playback: paint preloaded water while the handoff card shows.
  useEffect(() => {
    const run = sandboxPreload?.run;
    if (!run || !sandboxTransition || thinkingRef.current) return;
    thinkingRef.current = true;
    try {
      const n = run.grid;
      const arrival = b64ToF32Console(run.grids.arrival_min_b64);
      const depth = b64ToF32Console(run.grids.maxdepth_m_b64);
      const maxT = run.summary?.sim_minutes ?? 180;
      const key = `think-${Date.now()}`;
      thinkTRef.current = 0;
      setFlood({ key, arrival, depth, rows: n, cols: n, tMin: 0, visible: true });
      thinkTimerRef.current = setInterval(() => {
        thinkTRef.current = Math.min(maxT, thinkTRef.current + Math.max(1, maxT / 24));
        const t = thinkTRef.current;
        setFlood({ key, arrival, depth, rows: n, cols: n, tMin: t, visible: true });
      }, 500);
    } catch {
      thinkingRef.current = false;
    }
    return () => {
      if (thinkTimerRef.current) clearInterval(thinkTimerRef.current);
      thinkTimerRef.current = null;
      thinkingRef.current = false;
    };
  }, [sandboxPreload, sandboxTransition]);
  useEffect(() => {
    if (deepLinkedRef.current) return;
    deepLinkedRef.current = true;
    const q = new URLSearchParams(window.location.search);
    const id = q.get('dam');
    if (!id) return;
    const dam = INDIA_DAMS.find((d) => d.id === id);
    if (!dam) return;
    const direct = q.get('direct') === '1' || q.get('lisflood') === '1' || q.get('sandbox') === '1';
    handleDamClick(dam, { direct3D: direct });
    if (FEATURES.sandboxFlood && q.get('sandbox') === '1') {
      setSandboxOpen(true);
      setSelectedDam(null);
      if (q.get('demo') === '1') setAutoDemo(true);
    }
    if (FEATURES.lisflood && q.get('lisflood') === '1') {
      setLisfloodOpen(true);
      setSelectedDam(null);
      if (q.get('job')) setDeepJobId(q.get('job'));
    }
  }, [handleDamClick]);

  // City focus links (Evacuation Planner → globe): re-run on query change.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const name = q.get('globeCity');
    const clon = Number(q.get('clon'));
    const clat = Number(q.get('clat'));
    if (!name || !Number.isFinite(clon) || !Number.isFinite(clat)) {
      setCityFocus(null);
      return;
    }
    setForceMap(true);
    setCityFocus({
      name,
      lon: clon,
      lat: clat,
      damlon: Number(q.get('damlon')) || 70.85,
      damlat: Number(q.get('damlat')) || 22.83,
      depth: q.get('depth') || '—',
      arr: q.get('arr') || '—',
    });
    const send = (center: [number, number], zoom: number) => {
      if (mapLibreRef.current) {
        try {
          mapLibreRef.current.flyTo({ center, zoom, pitch: 60, bearing: 0, duration: 2600, essential: true });
        } catch {}
      }
      if (iframeRef.current?.contentWindow) {
        try {
          iframeRef.current.contentWindow.postMessage({
            v: 1, type: 'setView',
            payload: { center, zoom, duration: 2600 },
            requestId: 'city-' + Date.now(),
          }, GEOLIBRE_BASE);
        } catch {}
      }
    };
    send([clon, clat], 11);
    const t = setTimeout(() => send([clon, clat], 11), 1500);
    return () => clearTimeout(t);
  }, [location.search]);

  const hazard = selectedDam ? classifyHazard(selectedDam) : null;

  const filteredDams = searchQuery
    ? INDIA_DAMS.filter(d =>
        d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.state.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.river.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : INDIA_DAMS.sort((a, b) => b.height_m - a.height_m);

  const geolibreSrc = `${GEOLIBRE_BASE}/?embed=1&maponly&data=${encodeURIComponent(DAMS_GEOJSON_URL)}`;

  return (
    <div className="flex h-full w-full relative overflow-hidden">
      {/* Dam sidebar */}
      {sidebarOpen && (
        <div className="w-72 bg-[#0A1218]/95 backdrop-blur border-r border-cmd-border flex flex-col shrink-0 z-10"
          onClick={(e) => e.stopPropagation()}>
          <div className="p-4 border-b border-cmd-border">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-cmd-teal" strokeWidth={1.75} />
                <h3 className="text-sm font-bold text-cmd-ink">India Dam Index</h3>
              </div>
              <button onClick={() => setSidebarOpen(false)} className="p-1.5 rounded-md text-cmd-muted hover:text-cmd-ink hover:bg-white/[0.06]">
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-cmd-muted mb-3 tabular-nums">
              {INDIA_DAMS.length} dams • Satellite + 3D Terrain
            </p>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-cmd-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text" placeholder="Search dams..." value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-2 text-xs bg-cmd-panel border border-cmd-border rounded-lg text-cmd-ink placeholder:text-cmd-muted/60 focus:outline-none focus:border-cmd-teal/60"
              />
            </div>
          </div>

          <div className="px-4 py-3 border-b border-cmd-border">
            <p className="text-[10px] uppercase tracking-[0.14em] text-cmd-muted font-bold mb-2">Height Distribution</p>
            {[
              { label: 'Mega (>200m)', color: '#D96B70', count: INDIA_DAMS.filter(d => d.height_m > 200).length },
              { label: 'Large (150-200m)', color: '#D8B24C', count: INDIA_DAMS.filter(d => d.height_m >= 150 && d.height_m <= 200).length },
              { label: 'Medium (100-150m)', color: '#D8B24C', count: INDIA_DAMS.filter(d => d.height_m >= 100 && d.height_m < 150).length },
              { label: 'Standard (50-100m)', color: '#65BFA9', count: INDIA_DAMS.filter(d => d.height_m >= 50 && d.height_m < 100).length },
              { label: 'Small (<50m)', color: '#91A2AD', count: INDIA_DAMS.filter(d => d.height_m < 50).length },
            ].map(({ label, color, count }) => (
              <div key={label} className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-xs text-cmd-muted flex-1">{label}</span>
                <span className="text-xs font-bold text-cmd-ink tabular-nums">{count}</span>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {filteredDams.map((dam) => (
              <button key={dam.id} onClick={() => handleDamClick(dam)}
                className={`w-full flex items-center gap-2 text-left p-2 rounded-xl transition-colors mb-1 border ${
                  selectedDam?.id === dam.id
                    ? 'bg-cmd-tealdim border-cmd-teal/30'
                    : 'border-transparent hover:bg-white/[0.04] hover:border-cmd-border'
                }`}>
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: classifyHazard(dam).color }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-cmd-ink truncate flex items-center gap-1.5">
                    <span className="truncate">{dam.name}</span>
                    {modelManifest?.[dam.id] && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-md bg-cmd-teal/15 text-cmd-teal text-[9px] font-bold shrink-0">
                        <Box className="w-2.5 h-2.5" />3D
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] text-cmd-muted">{dam.state} • {dam.river}</p>
                </div>
                <span className="text-xs font-bold text-cmd-muted shrink-0 tabular-nums">{dam.height_m}m</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Map area */}
      <div className="flex-1 relative" style={{ boxShadow: 'inset 0 0 60px -30px rgba(101,191,169,0.25)' }}>
        {!sidebarOpen && (
          <button onClick={() => setSidebarOpen(true)}
            className="absolute top-3 left-3 z-20 p-2 bg-[#0A1218]/90 border border-cmd-border rounded-lg hover:border-cmd-teal/40 transition-colors" title="Show dam list">
            <PanelLeft className="w-4 h-4 text-cmd-muted" />
          </button>
        )}

        <div className="absolute top-3 right-14 z-20">
          {geolibreOnline === null ? (
            <div className="px-3 py-1.5 bg-[#0A1218]/90 border border-cmd-amber/40 text-cmd-amber text-[10px] font-bold rounded-full animate-pulse">Checking GeoLibre...</div>
          ) : geolibreOnline ? (
            <div className="px-3 py-1.5 bg-[#0A1218]/90 border border-cmd-border text-cmd-ink text-[10px] font-bold rounded-full">
              <span className="text-cmd-green">●</span> GeoLibre 3D Earth {geolibreReady ? '(Ready)' : '(Loading...)'}
            </div>
          ) : (
            <div className="px-3 py-1.5 bg-[#0A1218]/90 border border-cmd-border text-cmd-ink text-[10px] font-bold rounded-full"><span className="text-cmd-green">●</span> Satellite + 3D Terrain</div>
          )}
        </div>

        {/* Floating AI activity label while the sandbox engine is computing */}
        {FEATURES.sandboxFlood && sandboxOpen && sandboxBusy && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-4 py-2 rounded-full border border-cmd-teal/40 bg-[#0A1218]/92">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cmd-teal opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cmd-teal" />
            </span>
            <span className="text-[11px] font-bold text-cmd-ink tracking-wide">AI IS PREDICTING</span>
            <span className="text-[10px] text-cmd-muted">running the water simulation</span>
          </div>
        )}

        {focusedDam && resolveModelSlug(focusedDam) && !forceMap ? (
          <>
            <Local3DView
              dam={focusedDam}
              slug={resolveModelSlug(focusedDam)!}
              hazardColor={focusedDam.id === selectedDam?.id ? hazard?.color ?? '#2563eb' : classifyHazard(focusedDam).color}
              onShowMap={() => setForceMap(true)}
              onClose={() => { setFocusedDam(null); setSandboxOpen(false); setSandboxTransition(false); setLisfloodOpen(false); setFlood(null); }}
              flood={flood}
              autoOrbit={sandboxTransition}
              cinematic={FEATURES.lisflood && lisfloodOpen}
              spin={sandboxOpen || lisfloodOpen}
              spinSpeed={2.4}
            />
            {FEATURES.sandboxFlood && sandboxTransition && !sandboxOpen && (
              <SandboxTransition
                damName={focusedDam.name}
                onDone={() => { setSandboxTransition(false); setSandboxOpen(true); setSelectedDam(null); }}
              />
            )}
            {FEATURES.sandboxFlood && sandboxOpen && (
              <SandboxPanel
                dam={focusedDam}
                autoDemo={autoDemo}
                onFlood={setFlood}
                onBusyChange={setSandboxBusy}
                initialCases={sandboxPreload?.cases}
                initialRun={sandboxPreload?.run}
                initialTMin={thinkTRef.current}
                onClose={() => { setSandboxOpen(false); setFlood(null); setAutoDemo(false); setSandboxBusy(false); setSandboxPreload(null); }}
              />
            )}
            {FEATURES.lisflood && lisfloodOpen && (
              <LisfloodPanel
                dam={focusedDam}
                onFlood={setFlood}
                onClose={() => { setLisfloodOpen(false); setFlood(null); }}
                initialJobId={deepJobId}
              />
            )}
          </>
        ) : geolibreOnline ? (
          <iframe
            ref={iframeRef}
            src={geolibreSrc}
            className="w-full h-full border-0"
            style={{ minHeight: 'calc(100vh - 3.5rem)' }}
            allow="accelerometer; camera; geolocation; clipboard-write"
            title="GeoLibre 3D Earth"
          />
        ) : geolibreOnline === false ? (
          <InlineMapLibre onDamClick={handleDamClick} selectedDam={selectedDam} onMapReady={(m) => { mapLibreRef.current = m; }}
            focusPoint={cityFocus ? { lon: cityFocus.lon, lat: cityFocus.lat, label: cityFocus.name, damlon: cityFocus.damlon, damlat: cityFocus.damlat } : null} />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-cmd-bg">
            <div className="w-8 h-8 border-4 border-cmd-teal border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {/* Simulation entry + 3D entry live at map level (visible over 3D and globe) */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2">
          {FEATURES.sandboxFlood && focusedDam && !sandboxOpen && !sandboxTransition && !lisfloodOpen && (globeReady3D || !forceMap) && (
            <button
              onClick={handleRunSandbox}
              className="flex items-center gap-2 px-5 py-2 bg-cmd-panel2 border border-cmd-border text-cmd-ink text-[11px] font-bold rounded-full hover:border-cmd-teal/50 transition-colors"
              title="Pre-compute the likely breach case, then open the scenario sandbox"
            >
              <FlaskConical className="w-3.5 h-3.5 text-cmd-teal" strokeWidth={1.75} />
              Run Sandbox
            </button>
          )}
        </div>
        {focusedDam && resolveModelSlug(focusedDam) && forceMap && globeReady3D && !sandboxOpen && !sandboxTransition && !lisfloodOpen && (
          <button
            onClick={() => setForceMap(false)}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-5 py-2.5 rounded-full bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-xs font-bold transition-colors"
            style={{ boxShadow: '0 0 28px -8px rgba(101,191,169,0.55)' }}
            title="Open the preloaded 3D terrain"
          >
            <Mountain className="w-4 h-4" strokeWidth={2} />
            View 3D Terrain
          </button>
        )}
        {/* Focused city card (Evacuation Planner links) — outside the dam branch */}
        {cityFocus && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2.5 rounded-xl border border-cmd-teal/40 bg-[#0A1218]/92 backdrop-blur">
            <MapPin className="w-4 h-4 text-cmd-teal shrink-0" strokeWidth={2} />
            <div className="text-xs">
              <span className="font-bold text-cmd-ink">{cityFocus.name}</span>
              <span className="text-cmd-muted font-mono tabular-nums">
                {' '}• {haversineKm(cityFocus.damlat, cityFocus.damlon, cityFocus.lat, cityFocus.lon).toFixed(1)} km from dam
                {' '}• depth {cityFocus.depth} • arrival {cityFocus.arr}
              </span>
            </div>
            <button onClick={() => { setCityFocus(null); navigate('/incident', { replace: true }); }}
              className="p-1 rounded-md text-cmd-muted hover:text-cmd-ink" title="Clear waypoint">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Dam data panel */}
      {selectedDam && (
        <div className="absolute right-0 top-0 bottom-0 w-80 bg-[#0A1218]/95 backdrop-blur border-l border-cmd-border z-20 flex flex-col"
          onClick={(e) => e.stopPropagation()}>
          <div className="p-4 overflow-y-auto flex-1">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-lg font-bold text-cmd-ink">{selectedDam.name}</h3>
                <p className="text-sm text-cmd-muted">{selectedDam.state} • {selectedDam.river} River</p>
              </div>
              <button onClick={() => setSelectedDam(null)}
                className="p-1.5 rounded-md text-cmd-muted hover:text-cmd-ink hover:bg-white/[0.06]">
                <X className="w-4 h-4" />
              </button>
            </div>

            {hazard && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-cmd-border bg-cmd-panel2 text-xs font-bold mb-3"
                style={{ color: hazard.color }}>
                <AlertTriangle className="w-3 h-3" /> {hazard.level} RISK
              </div>
            )}

            <div className="grid grid-cols-2 gap-2.5 mb-3">
              {[
                { label: 'Height', value: `${selectedDam.height_m} m` },
                { label: 'Capacity', value: `${selectedDam.capacity_mcm.toLocaleString()} MCM` },
                { label: 'Type', value: formatType(selectedDam.type) },
                { label: 'Year Built', value: selectedDam.year_built > 0 ? String(selectedDam.year_built) : `${Math.abs(selectedDam.year_built)} BC` },
                { label: 'Latitude', value: selectedDam.lat.toFixed(4) },
                { label: 'Longitude', value: selectedDam.lon.toFixed(4) },
              ].map(({ label, value }) => (
                <div key={label} className="bg-cmd-panel border border-cmd-border/70 rounded-lg p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-cmd-muted font-semibold">{label}</p>
                  <p className="text-sm font-bold text-cmd-ink tabular-nums">{value}</p>
                </div>
              ))}
            </div>

            {hazard && (
              <div className="border-t border-cmd-border pt-3 mt-3">
                <p className="text-[10px] uppercase tracking-[0.14em] text-cmd-muted font-bold mb-2">Downstream Impact Estimate</p>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <Users className="w-4 h-4 text-cmd-amber" strokeWidth={1.75} />
                    <div>
                      <p className="text-sm font-bold text-cmd-ink tabular-nums">{formatNumber(hazard.downstreamPopEstimate)}</p>
                      <p className="text-[10px] text-cmd-muted">Est. population at risk</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Droplets className="w-4 h-4 text-cmd-teal" strokeWidth={1.75} />
                    <div>
                      <p className="text-sm font-bold text-cmd-ink tabular-nums">{(selectedDam.capacity_mcm * 0.001).toFixed(1)} km³</p>
                      <p className="text-[10px] text-cmd-muted">Flood volume potential</p>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-cmd-muted mt-2 leading-relaxed">{hazard.description}</p>
              </div>
            )}

            <div className="border-t border-cmd-border pt-3 mt-3">
              <button onClick={() => flyToDam(selectedDam)}
                className="w-full px-3 py-2 bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-xs font-bold rounded-lg transition-colors">
                Fly to Dam on Satellite Map
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

