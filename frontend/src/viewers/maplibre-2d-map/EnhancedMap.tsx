/**
 * DamSafe Twin — Enhanced 2D Map with deck.gl
 *
 * Uses the GeoLibre stack: MapLibre GL JS (base) + deck.gl (WebGL overlay).
 * deck.gl provides GPU-accelerated layers for flood visualization:
 * - ScatterplotLayer for villages with dynamic radius/color
 * - HeatmapLayer for hazard intensity
 * - ArcLayer for evacuation routes
 * - PolygonLayer for flood extent with gradient fill
 */

import { useEffect, useRef, useMemo, useState } from 'react';
import { ScatterplotLayer, PolygonLayer, TextLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { INDIA_DAMS } from '../../data/india-dams';
import type { ImpactData, VillageData } from '../../modules/incident-console/hooks';

interface EnhancedMapProps {
  center?: [number, number];
  zoom?: number;
  layer?: 'extent' | 'depth' | 'hazard' | 'arrival';
  timeMinutes: number;
  impactData: ImpactData | null;
  cameraTarget: { lon: number; lat: number; heightM: number } | null;
  onCameraChange: (target: { lon: number; lat: number; heightM: number }) => void;
  onDamClick?: (dam: any) => void;
}

const HAZARD_COLORS: Record<string, [number, number, number, number]> = {
  green: [34, 197, 94, 200],
  yellow: [234, 179, 8, 200],
  orange: [249, 115, 22, 200],
  red: [239, 68, 68, 200],
};

const ROAD_COLORS: Record<string, [number, number, number]> = {
  safe: [34, 197, 94],
  restricted: [234, 179, 8],
  impassable: [239, 68, 68],
};

export default function EnhancedMap({
  center = [70.85, 22.83],
  zoom = 11,
  layer = 'depth',
  timeMinutes,
  impactData,
  cameraTarget,
  onCameraChange,
  onDamClick,
}: EnhancedMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const deckRef = useRef<any>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const isFlyingRef = useRef(false); // prevents camera feedback loop
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);

  // ── Initialize MapLibre + deck.gl overlay ─────────────────────────────
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
          layers: [{ id: 'osm-layer', type: 'raster', source: 'osm-tiles' }],
        },
        center,
        zoom,
      });

      map.addControl(new maplibregl.NavigationControl(), 'top-right');
      map.addControl(new maplibregl.ScaleControl(), 'bottom-right');

      // Create deck.gl MapboxOverlay — renders layers ON the MapLibre canvas
      const overlay = new MapboxOverlay({
        interleaved: false,
        layers: [],
      });
      map.addControl(overlay);
      overlayRef.current = overlay;

      map.on('load', () => {
        if (cancelled) { map.remove(); return; }
        mapRef.current = map;

        map.on('moveend', () => {
          // Skip if we initiated this move programmatically
          if (isFlyingRef.current) return;
          const c = map.getCenter();
          const z = map.getZoom();
          onCameraChange({ lon: c.lng, lat: c.lat, heightM: 500 / Math.pow(2, z - 10) });
        });
      });
    });

    return () => {
      cancelled = true;
      if (overlayRef.current && mapRef.current) {
        try { mapRef.current.removeControl(overlayRef.current); } catch {}
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // ── Sync camera from external changes (with feedback loop guard) ──────
  useEffect(() => {
    if (!mapRef.current || !cameraTarget) return;
    const map = mapRef.current;
    const c = map.getCenter();
    if (Math.abs(c.lng - cameraTarget.lon) > 0.001 || Math.abs(c.lat - cameraTarget.lat) > 0.001) {
      isFlyingRef.current = true;
      map.flyTo({
        center: [cameraTarget.lon, cameraTarget.lat],
        zoom: 12,
        duration: 1000,
      });
      // Reset flag after flyTo completes
      setTimeout(() => { isFlyingRef.current = false; }, 1200);
    }
  }, [cameraTarget]);

  // ── Build deck.gl layers from impactData ──────────────────────────────
  const deckLayers = useMemo(() => {
    if (!impactData || !ScatterplotLayer || !PolygonLayer || !TextLayer) return [];

    const layers: any[] = [];

    // ── Flood extent polygon (GeoLibre-style gradient) ────────────────
    if (impactData.floodExtent && timeMinutes > 0) {
      const { center: c, radiusDeg } = impactData.floodExtent;
      const r = radiusDeg;
      layers.push(
        new PolygonLayer({
          id: 'flood-extent',
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
          getFillColor: layer === 'hazard'
            ? [59, 130, 246, Math.min(150, timeMinutes * 2)]
            : [59, 130, 246, Math.min(120, timeMinutes * 1.5)],
          getLineColor: [37, 99, 235, 200],
          getLineWidth: 2,
          pickable: true,
          stroked: true,
          filled: true,
        }),
      );
    }

    // ── Village scatterplot (size/color by hazard) ────────────────────
    layers.push(
      new ScatterplotLayer({
        id: 'villages',
        data: impactData.villages,
        getPosition: (d: VillageData) => [d.lon, d.lat],
        getRadius: (d: VillageData) => {
          const flooded = timeMinutes >= d.arrival_time_min;
          return flooded ? 120 + d.depth_m * 40 : 80;
        },
        getFillColor: (d: VillageData) => {
          const flooded = timeMinutes >= d.arrival_time_min;
          if (flooded) return HAZARD_COLORS[d.hazard_class] || [148, 163, 184, 200];
          return [148, 163, 184, 150];
        },
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 2,
        radiusMinPixels: 4,
        radiusMaxPixels: 20,
        pickable: true,
        stroked: true,
        filled: true,
        wireframe: false,
        antialiasing: true,
        parameters: { depthTest: false },
      }),
    );

    // ── Village name labels ───────────────────────────────────────────
    layers.push(
      new TextLayer({
        id: 'village-labels',
        data: impactData.villages,
        getPosition: (d: VillageData) => [d.lon, d.lat],
        getText: (d: VillageData) => {
          const flooded = timeMinutes >= d.arrival_time_min;
          return flooded ? `${d.name} 🔴` : `${d.name}`;
        },
        getSize: 10,
        getColor: [51, 65, 85, 220],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        getPositionOffset: [0, 20],
        fontFamily: 'Inter, sans-serif',
        fontWeight: 600,
        parameters: { depthTest: false },
      }),
    );

    // ── Dam marker ────────────────────────────────────────────────────
    layers.push(
      new ScatterplotLayer({
        id: 'dam-marker',
        data: [impactData.dam],
        getPosition: (d: any) => [d.lon, d.lat],
        getRadius: 160,
        getFillColor: [30, 64, 175, 255],
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 3,
        radiusMinPixels: 8,
        radiusMaxPixels: 16,
        pickable: true,
        stroked: true,
        filled: true,
        parameters: { depthTest: false },
      }),
    );

    // ── Facility markers ──────────────────────────────────────────────
    const facilityColors: Record<string, [number, number, number, number]> = {
      hospital: [220, 38, 38, 220],
      school: [34, 197, 94, 220],
      substation: [234, 179, 8, 220],
      telecom_tower: [147, 51, 234, 220],
      police_station: [37, 99, 235, 220],
    };
    layers.push(
      new ScatterplotLayer({
        id: 'facilities',
        data: impactData.facilities,
        getPosition: (d: any) => [d.lon, d.lat],
        getRadius: 60,
        getFillColor: (d: any) => facilityColors[d.kind] || [148, 163, 184, 200],
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 2,
        radiusMinPixels: 4,
        radiusMaxPixels: 8,
        pickable: true,
        stroked: true,
        filled: true,
        parameters: { depthTest: false },
      }),
    );

    // ── Heatmap layer (hazard intensity) ──────────────────────────────
    if (layer === 'hazard' && timeMinutes > 10) {
      layers.push(
        new HeatmapLayer({
          id: 'hazard-heatmap',
          data: impactData.villages.filter((v) => timeMinutes >= v.arrival_time_min),
          getPosition: (d: VillageData) => [d.lon, d.lat],
          getWeight: (d: VillageData) => d.hazard_index * d.population / 1000,
          radiusPixels: 80,
          intensity: 1,
          threshold: 0.1,
          colorRange: [
            [59, 130, 246, 80],
            [34, 197, 94, 120],
            [234, 179, 8, 160],
            [249, 115, 22, 200],
            [239, 68, 68, 220],
          ],
          aggregation: 'SUM',
          parameters: { depthTest: false },
        }),
      );
    }        // ── India Dams — all known dam locations from GRanD ──────────────
    layers.push(
      new ScatterplotLayer({
        id: 'india-dams',
        data: INDIA_DAMS,
        getPosition: (d: any) => [d.lon, d.lat],
        getRadius: (d: any) => {
          if (d.height_m > 150) return 250;
          if (d.height_m > 100) return 180;
          if (d.height_m > 50) return 120;
          return 80;
        },
        getFillColor: (d: any) => {
          if (d.height_m > 200) return [220, 38, 38, 220];   // red — mega dam
          if (d.height_m > 150) return [249, 115, 22, 220];  // orange — large
          if (d.height_m > 100) return [234, 179, 8, 220];   // yellow — medium
          if (d.height_m > 50)  return [59, 130, 246, 200];   // blue — standard
          return [107, 114, 128, 180];                         // gray — small
        },
        getLineColor: [255, 255, 255, 200],
        getLineWidth: 1,
        radiusMinPixels: 3,
        radiusMaxPixels: 12,
        pickable: true,
        stroked: true,
        filled: true,
        parameters: { depthTest: false },
        onClick: (info: any) => {
          if (info.object && onDamClick) {
            onDamClick(info.object);
          }
        },
        getCursor: 'pointer',
      }),
    );

    // ── India Dams labels ────────────────────────────────────────────
    layers.push(
      new TextLayer({
        id: 'india-dam-labels',
        data: INDIA_DAMS.filter((d) => d.height_m > 100),
        getPosition: (d: any) => [d.lon, d.lat],
        getText: (d: any) => d.name,
        getSize: 8,
        getColor: [30, 41, 59, 200],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        getPositionOffset: [0, 12],
        fontFamily: 'Inter, sans-serif',
        fontWeight: 500,
        parameters: { depthTest: false },
      }),
    );

    return layers;
  }, [impactData, timeMinutes, layer]);

  // ── Push layers to the MapboxOverlay ────────────────────────────────────
  useEffect(() => {
    if (overlayRef.current) {
      overlayRef.current.setProps({
        layers: deckLayers,
        getTooltip: ({ object }: any) => {
          if (!object) return null;
          // Dam tooltips
          if (object.height_m !== undefined && object.river) {
            return {
              html: `<div style="font-family:Inter,sans-serif;padding:6px 10px;max-width:220px;">
                <div style="font-weight:700;font-size:13px;color:#1e293b;">${object.name}</div>
                <div style="font-size:11px;color:#64748b;margin-top:2px;">${object.state} • ${object.river} River</div>
                <div style="display:flex;gap:12px;margin-top:4px;">
                  <span style="font-size:11px;"><b>${object.height_m}m</b> height</span>
                  <span style="font-size:11px;"><b>${object.capacity_mcm.toLocaleString()}</b> MCM</span>
                </div>
                <div style="font-size:10px;color:#94a3b8;margin-top:3px;">${object.type.replace(/_/g,' ')} • ${object.year_built > 0 ? object.year_built : Math.abs(object.year_built)+' BC'}</div>
              </div>`,
              style: { borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' },
            };
          }
          return null;
        },
      });
    }
  }, [deckLayers]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />

      {/* Zoom controls + Search */}
      <div className="absolute top-4 left-4 z-10 flex gap-2 items-start">
        <div className="flex gap-2">
          <button
            onClick={() => {
              isFlyingRef.current = true;
              mapRef.current?.flyTo({ center: [82.0, 22.0], zoom: 4.5, duration: 1500 });
              setTimeout(() => { isFlyingRef.current = false; }, 1700);
            }}
            className="bg-white/90 backdrop-blur-sm rounded-lg px-3 py-1.5 shadow-md text-xs font-medium text-slate-700 hover:bg-white transition-colors"
          >
            🇮🇳 Zoom to India
          </button>
          <button
            onClick={() => {
              isFlyingRef.current = true;
              mapRef.current?.flyTo({ center: [70.85, 22.83], zoom: 11, duration: 1500 });
              setTimeout(() => { isFlyingRef.current = false; }, 1700);
            }}
            className="bg-white/90 backdrop-blur-sm rounded-lg px-3 py-1.5 shadow-md text-xs font-medium text-slate-700 hover:bg-white transition-colors"
          >
            🛡️ Dam Site
          </button>
        </div>

        {/* Dam Search */}
        <div className="relative">
          <div className="flex items-center bg-white/90 backdrop-blur-sm rounded-lg shadow-md">
            <span className="pl-2.5 text-slate-400 text-sm">🔍</span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                const q = e.target.value;
                setSearchQuery(q);
                if (q.length >= 2) {
                  const results = INDIA_DAMS.filter((d) =>
                    d.name.toLowerCase().includes(q.toLowerCase()) ||
                    d.state.toLowerCase().includes(q.toLowerCase()) ||
                    d.river.toLowerCase().includes(q.toLowerCase())
                  ).slice(0, 8);
                  setSearchResults(results);
                } else {
                  setSearchResults([]);
                }
              }}
              placeholder="Search dams..."
              className="bg-transparent text-xs text-slate-700 placeholder-slate-400 px-2 py-1.5 w-44 focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); setSearchResults([]); }}
                className="pr-2 text-slate-400 hover:text-slate-600 text-xs"
              >
                ✕
              </button>
            )}
          </div>
          {searchResults.length > 0 && (
            <div className="absolute top-full left-0 mt-1 w-72 bg-white rounded-lg shadow-lg border border-slate-200 max-h-64 overflow-y-auto">
              {searchResults.map((dam) => (
                <button
                  key={dam.id}
                  onClick={() => {
                    isFlyingRef.current = true;
                    mapRef.current?.flyTo({
                      center: [dam.lon, dam.lat],
                      zoom: 9,
                      duration: 1500,
                    });
                    setTimeout(() => { isFlyingRef.current = false; }, 1700);
                    setSearchQuery(dam.name);
                    setSearchResults([]);
                    if (onDamClick) onDamClick(dam);
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-slate-50 flex items-center justify-between border-b border-slate-100 last:border-0"
                >
                  <div>
                    <div className="text-xs font-semibold text-slate-800">{dam.name}</div>
                    <div className="text-[10px] text-slate-500">{dam.state} • {dam.river} • {dam.height_m}m</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{
                        backgroundColor: dam.height_m > 200 ? '#dc2626' :
                          dam.height_m > 150 ? '#f97316' :
                          dam.height_m > 100 ? '#eab308' :
                          dam.height_m > 50 ? '#3b82f6' : '#9ca3af',
                      }}
                    />
                    <span className="text-[10px] text-slate-400">{dam.year_built > 0 ? dam.year_built : 'Ancient'}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 right-4 z-10 bg-white/90 backdrop-blur-sm rounded-lg px-3 py-2 shadow-md text-[11px]">
        <div className="font-semibold text-slate-700 mb-1.5">GeoLibre Enhanced</div>
        <div className="space-y-1">
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-blue-700" /> Case Study Dam</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-slate-400" /> Village (safe)</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-red-500" /> Village (flooded)</div>
          <div className="flex items-center gap-2"><div className="w-4 h-3 rounded bg-blue-400 opacity-50" /> Flood extent</div>
          <div className="border-t border-slate-200 pt-1 mt-1">
            <div className="font-medium text-slate-600 mb-0.5">India Dams (GRanD)</div>
            <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-red-600" /> Mega (&gt;200m)</div>
            <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-orange-500" /> Large (150-200m)</div>
            <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-yellow-400" /> Medium (100-150m)</div>
            <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-blue-500" /> Standard (50-100m)</div>
            <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-gray-400" /> Small (&lt;50m)</div>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-2 rounded" style={{ background: 'linear-gradient(90deg, #3b82f6, #22c55e, #eab308, #f97316, #ef4444)' }} /> Heatmap
          </div>
        </div>
      </div>
    </div>
  );
}
