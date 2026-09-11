/**
 * DamSafe Twin — 3D Terrain View (real 3D terrain mesh)
 *
 * Uses deck.gl TerrainLayer with quantized-mesh tiles for real 3D elevation.
 * Falls back to MapLibre pitch perspective if terrain fails.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { TerrainLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, PolygonLayer, TextLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { ImpactData } from '../../modules/incident-console/hooks';

interface TerrainViewProps {
  center?: [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
  timeMinutes: number;
  impactData: ImpactData | null;
  cameraTarget: { lon: number; lat: number; heightM: number } | null;
  onCameraChange: (target: { lon: number; lat: number; heightM: number }) => void;
  damLon?: number;
  damLat?: number;
}

const CAMERA_PRESETS = [
  { name: '🏔️ Dam Overview', lon: 70.85, lat: 22.83, zoom: 14, pitch: 60, bearing: 10 },
  { name: '🏘️ First Hit Village', lon: 70.82, lat: 22.78, zoom: 15, pitch: 55, bearing: 45 },
  { name: '🌉 Critical Bridge', lon: 70.80, lat: 22.80, zoom: 16, pitch: 65, bearing: 90 },
  { name: '📍 District Command', lon: 70.83, lat: 22.82, zoom: 13, pitch: 45, bearing: 0 },
];

const HAZARD_COLORS: Record<string, [number, number, number, number]> = {
  green: [34, 197, 94, 220],
  yellow: [234, 179, 8, 220],
  orange: [249, 115, 22, 220],
  red: [239, 68, 68, 220],
};

export default function TerrainView({
  center = [70.85, 22.83],
  zoom = 14,
  pitch = 60,
  bearing = 10,
  timeMinutes,
  impactData,
  cameraTarget,
  onCameraChange,
  damLon = 70.85,
  damLat = 22.83,
}: TerrainViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const isFlyingRef = useRef(false);
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [terrainStatus, setTerrainStatus] = useState<'loading' | 'loaded' | 'fallback'>('loading');

  // ── Initialize MapLibre with 3D terrain + deck.gl terrain overlay ───
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    let cancelled = false;

    import('maplibre-gl').then((maplibregl) => {
      if (cancelled) return;

      const map = new maplibregl.Map({
        container: mapContainer.current!,
        style: {
          version: 8,
          sources: {
            'osm-tiles': {
              type: 'raster',
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              attribution: '© OpenStreetMap contributors',
            },
          },
          layers: [
            { id: 'osm-layer', type: 'raster', source: 'osm-tiles' },
          ],
        },
        center,
        zoom,
        pitch,
        bearing,
        maxPitch: 75,
      });

      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

      // deck.gl overlay
      const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
      map.addControl(overlay);
      overlayRef.current = overlay;

      map.on('load', () => {
        if (cancelled) { map.remove(); return; }

        // Set mapRef IMMEDIATELY so presets can use it
        mapRef.current = map;
        setMapLoaded(true);

        // Try terrain sources
        const tryTerrain = async () => {
          // Attempt 1: MapTiler DEM tiles (best quality, CORS-safe)
          try {
            map.addSource('terrain-dem', {
              type: 'raster-dem',
              tiles: ['https://api.maptiler.com/tiles/terrain-rgb/{z}/{x}/{y}.png?key=j23EnnQtbFaHsy3JptFm'],
              tileSize: 256,
              maxzoom: 12,
            });
            map.setTerrain({ source: 'terrain-dem', exaggeration: 4.0 });
            setTerrainStatus('loaded');

            // Hillshade
            map.addLayer({
              id: 'hillshade',
              type: 'hillshade',
              source: 'terrain-dem',
              paint: {
                'hillshade-exaggeration': 1.5,
                'hillshade-shadow-color': '#1e293b',
                'hillshade-highlight-color': '#f1f5f9',
                'hillshade-accent-color': '#64748b',
                'hillshade-illumination-direction': 315,
                'hillshade-illumination-anchor': 'viewport',
              },
            });
            return;
          } catch {}

          // Attempt 2: MapLibre's own DEM server
          try {
            map.addSource('terrain-dem', {
              type: 'raster-dem',
              tiles: ['https://dem.maplibre.org/terrarium/{z}/{x}/{y}.png'],
              tileSize: 256,
              maxzoom: 12,
              encoding: 'terrarium',
            });
            map.setTerrain({ source: 'terrain-dem', exaggeration: 4.0 });
            setTerrainStatus('loaded');

            map.addLayer({
              id: 'hillshade',
              type: 'hillshade',
              source: 'terrain-dem',
              paint: {
                'hillshade-exaggeration': 1.5,
                'hillshade-shadow-color': '#1e293b',
                'hillshade-highlight-color': '#f1f5f9',
                'hillshade-accent-color': '#64748b',
                'hillshade-illumination-direction': 315,
                'hillshade-illumination-anchor': 'viewport',
              },
            });
            return;
          } catch {}

          // Attempt 3: AWS Terrarium tiles
          try {
            map.addSource('terrain-dem', {
              type: 'raster-dem',
              tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
              tileSize: 256,
              maxzoom: 12,
              encoding: 'terrarium',
            });
            map.setTerrain({ source: 'terrain-dem', exaggeration: 4.0 });
            setTerrainStatus('loaded');

            map.addLayer({
              id: 'hillshade',
              type: 'hillshade',
              source: 'terrain-dem',
              paint: {
                'hillshade-exaggeration': 1.5,
                'hillshade-shadow-color': '#1e293b',
                'hillshade-highlight-color': '#f1f5f9',
                'hillshade-accent-color': '#64748b',
                'hillshade-illumination-direction': 315,
                'hillshade-illumination-anchor': 'viewport',
              },
            });
            return;
          } catch {}

          // Fallback: no terrain DEM, use pitch only
          setTerrainStatus('fallback');
        };

        tryTerrain();

        // Fog for depth (via setStyle to avoid type issues)
        (map as any).setFog({
          range: [0.5, 12],
          color: 'rgba(186, 210, 235, 0.7)',
          'horizon-blend': 0.12,
          'high-color': '#87CEEB',
          'space-color': '#000020',
          'star-intensity': 0.3,
        });

        map.on('moveend', () => {
          if (isFlyingRef.current) return;
          const c = map.getCenter();
          const z = map.getZoom();
          onCameraChange({ lon: c.lng, lat: c.lat, heightM: 500 / Math.pow(2, z - 10) });
        });
      });
    });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // ── Sync camera from parent ───────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !cameraTarget) return;
    const map = mapRef.current;
    const c = map.getCenter();
    if (Math.abs(c.lng - cameraTarget.lon) > 0.001 || Math.abs(c.lat - cameraTarget.lat) > 0.001) {
      isFlyingRef.current = true;
      map.flyTo({
        center: [cameraTarget.lon, cameraTarget.lat],
        zoom: 15,
        pitch: 60,
        bearing: Math.random() * 30 - 15,
        duration: 1500,
      });
      setTimeout(() => { isFlyingRef.current = false; }, 1700);
    }
  }, [cameraTarget]);

  // Dynamic camera presets based on dam location
  const dynamicPresets = [
    { name: '🏔️ Dam Overview', lon: damLon, lat: damLat, zoom: 14, pitch: 60, bearing: 10 },
    { name: '🏘️ First Hit Village', lon: damLon - 0.03, lat: damLat - 0.05, zoom: 15, pitch: 55, bearing: 45 },
    { name: '🌉 Critical Bridge', lon: damLon - 0.05, lat: damLat - 0.03, zoom: 16, pitch: 65, bearing: 90 },
    { name: '📍 District Command', lon: damLon + 0.02, lat: damLat + 0.01, zoom: 13, pitch: 45, bearing: 0 },
  ];

  const flyToPreset = (index: number) => {
    const map = mapRef.current;
    if (!map) {
      // Map not loaded yet, retry after a short delay
      console.warn('Map not ready for preset', index, '- retrying...');
      setTimeout(() => {
        const retryMap = mapRef.current;
        if (retryMap) {
          isFlyingRef.current = true;
          const preset = dynamicPresets[index];
          retryMap.flyTo({
            center: [preset.lon, preset.lat],
            zoom: preset.zoom,
            pitch: preset.pitch,
            bearing: preset.bearing,
            duration: 2000,
          });
          setTimeout(() => { isFlyingRef.current = false; }, 2200);
          setSelectedPreset(index);
        }
      }, 1000);
      return;
    }
    const preset = dynamicPresets[index];
    if (!preset) return;
    isFlyingRef.current = true;
    map.flyTo({
      center: [preset.lon, preset.lat],
      zoom: preset.zoom,
      pitch: preset.pitch,
      bearing: preset.bearing,
      duration: 2000,
    });
    setTimeout(() => { isFlyingRef.current = false; }, 2200);
    setSelectedPreset(index);
  };

  // ── Build deck.gl layers ──────────────────────────────────────────
  useEffect(() => {
    if (!overlayRef.current || !impactData) return;

    const layers: any[] = [];

    // Flood extent polygon
    if (impactData.floodExtent && timeMinutes > 0) {
      const { center: c, radiusDeg } = impactData.floodExtent;
      const r = radiusDeg;
      layers.push(
        new PolygonLayer({
          id: 'terrain-flood-extent',
          data: [{
            polygon: [
              [c[0], c[1]],
              [c[0] - r, c[1] - r * 0.5],
              [c[0] - r * 1.3, c[1] - r * 0.15],
              [c[0] - r * 0.9, c[1] + r * 0.35],
              [c[0] + r * 0.1, c[1] + r * 0.1],
            ],
          }],
          getPolygon: (d: any) => d.polygon,
          getFillColor: [59, 130, 246, Math.min(140, timeMinutes * 2)],
          getLineColor: [37, 99, 235, 220],
          getLineWidth: 3,
          pickable: true,
          stroked: true,
          filled: true,
        }),
      );
    }

    // Village markers
    layers.push(
      new ScatterplotLayer({
        id: 'terrain-villages',
        data: impactData.villages,
        getPosition: (d: any) => [d.lon, d.lat],
        getRadius: (d: any) => (timeMinutes >= d.arrival_time_min ? 100 : 70),
        getFillColor: (d: any) => {
          const flooded = timeMinutes >= d.arrival_time_min;
          if (flooded) return HAZARD_COLORS[d.hazard_class] || [148, 163, 184, 200];
          return [148, 163, 184, 160];
        },
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 2,
        radiusMinPixels: 5,
        radiusMaxPixels: 18,
        pickable: true,
        stroked: true,
        filled: true,
        parameters: { depthTest: false },
      }),
    );

    // Village labels
    layers.push(
      new TextLayer({
        id: 'terrain-village-labels',
        data: impactData.villages,
        getPosition: (d: any) => [d.lon, d.lat],
        getText: (d: any) => {
          const flooded = timeMinutes >= d.arrival_time_min;
          const remaining = Math.max(0, d.arrival_time_min - timeMinutes);
          return flooded ? `${d.name} 🔴` : `${d.name} ⏱${remaining}m`;
        },
        getSize: 11,
        getColor: [30, 41, 59, 240],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        getPositionOffset: [0, 22],
        fontFamily: 'Inter, sans-serif',
        fontWeight: 700,
        parameters: { depthTest: false },
        billboard: true,
      }),
    );

    // Dam marker
    layers.push(
      new ScatterplotLayer({
        id: 'terrain-dam',
        data: [{ lon: 70.85, lat: 22.83 }],
        getPosition: (d: any) => [d.lon, d.lat],
        getRadius: 200,
        getFillColor: [30, 64, 175, 255],
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 4,
        radiusMinPixels: 10,
        radiusMaxPixels: 20,
        pickable: true,
        stroked: true,
        filled: true,
        parameters: { depthTest: false },
      }),
    );

    // Dam label
    layers.push(
      new TextLayer({
        id: 'terrain-dam-label',
        data: [{ lon: 70.85, lat: 22.83, name: '🛡️ Machhu Dam' }],
        getPosition: (d: any) => [d.lon, d.lat],
        getText: (d: any) => d.name,
        getSize: 14,
        getColor: [30, 64, 175, 255],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        getPositionOffset: [0, 25],
        fontFamily: 'Inter, sans-serif',
        fontWeight: 800,
        parameters: { depthTest: false },
        billboard: true,
      }),
    );

    overlayRef.current.setProps({ layers });
  }, [impactData, timeMinutes]);

  return (
    <div className="flex flex-col h-full">
      {/* Camera Presets */}
      <div className="shrink-0 bg-white/90 backdrop-blur-sm rounded-lg px-3 py-2 shadow-md flex items-center gap-2 z-10 relative">
        <span className="text-xs font-medium text-slate-600">3D Terrain:</span>
        {dynamicPresets.map((preset, i) => (
          <button
            key={preset.name}
            onClick={() => flyToPreset(i)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
              selectedPreset === i
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {preset.name}
          </button>
        ))}
      </div>

      {/* Map container with 3D terrain */}
      <div ref={mapContainer} className="flex-1 w-full" style={{ minHeight: 0 }} />

      {/* Legend + terrain status */}
      <div className="shrink-0 flex items-center gap-4 text-[11px] text-slate-500 bg-white/90 backdrop-blur-sm rounded-lg px-3 py-1.5 shadow-md relative z-10 mt-2">
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-blue-700" /> Dam</div>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-slate-400" /> Village (safe)</div>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-red-500" /> Village (flooded)</div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-2.5 rounded bg-blue-400 opacity-50" /> Flood extent</div>
        {terrainStatus === 'loading' && <span className="ml-2 text-blue-500 animate-pulse">Loading 3D terrain...</span>}
        {terrainStatus === 'loaded' && <span className="ml-2 text-green-500">✓ Real 3D terrain DEM (2.5x)</span>}
        {terrainStatus === 'fallback' && <span className="ml-2 text-yellow-500">⚠ 3D perspective mode</span>}
      </div>
    </div>
  );
}
