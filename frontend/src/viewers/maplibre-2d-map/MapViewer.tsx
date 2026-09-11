/**
 * DamSafe Twin — MapLibre 2D Map Viewer
 *
 * Consumes shared state from IncidentConsole. Does NOT own time/layer/simRun state.
 * Reads impactData from the shared hook, renders layers accordingly.
 */

import { useEffect, useRef, useCallback } from 'react';
import type { ImpactData, VillageData, RoadData, FacilityData } from '../../modules/incident-console/hooks';

interface MapViewerProps {
  center?: [number, number];
  zoom?: number;
  layer?: 'extent' | 'depth' | 'hazard' | 'arrival';
  timeMinutes: number;
  impactData: ImpactData | null;
  cameraTarget: { lon: number; lat: number; heightM: number } | null;
  onCameraChange: (target: { lon: number; lat: number; heightM: number }) => void;
}

const HAZARD_COLORS: Record<string, string> = {
  green: '#22c55e',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
};

const ROAD_COLORS: Record<string, string> = {
  safe: '#22c55e',
  restricted: '#eab308',
  impassable: '#ef4444',
};

const FACILITY_ICONS: Record<string, string> = {
  hospital: '🏥',
  school: '🏫',
  substation: '⚡',
  telecom_tower: '📡',
  police_station: '🚔',
};

export default function MapViewer({
  center = [70.85, 22.83],
  zoom = 11,
  layer = 'depth',
  timeMinutes,
  impactData,
  cameraTarget,
  onCameraChange,
}: MapViewerProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const maplibRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const sourcesAdded = useRef(false);
  const isFlyingRef = useRef(false);

  // ── Initialize map once ────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current) return;
    let cancelled = false;

    import('maplibre-gl').then((maplibregl) => {
      if (cancelled) return;
      maplibRef.current = maplibregl;

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

      map.on('load', () => {
        if (cancelled) { map.remove(); return; }
        mapRef.current = map;

        // Track camera changes (skip if we initiated the move)
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
  }, []); // only once

  // ── Sync camera from external changes (with feedback loop guard) ──────
  useEffect(() => {
    if (!mapRef.current || !cameraTarget) return;
    const map = mapRef.current;
    const c = map.getCenter();
    if (Math.abs(c.lng - cameraTarget.lon) > 0.001 || Math.abs(c.lat - cameraTarget.lat) > 0.001) {
      isFlyingRef.current = true;
      map.flyTo({ center: [cameraTarget.lon, cameraTarget.lat], zoom: 12, duration: 1000 });
      setTimeout(() => { isFlyingRef.current = false; }, 1200);
    }
  }, [cameraTarget]);

  // ── Render all data layers ────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !maplibRef.current || !impactData) return;
    const map = mapRef.current;
    if (!map.loaded()) return;
    const maplibregl = maplibRef.current;

    // Clear old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const addMarker = (el: HTMLElement, lngLat: [number, number], popup?: string) => {
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat(lngLat)
        .addTo(map);
      if (popup) {
        marker.setPopup(new maplibregl.Popup({ offset: 15 }).setHTML(popup));
      }
      markersRef.current.push(marker);
    };

    // ── Dam marker ──────────────────────────────────────────────────────
    const damEl = document.createElement('div');
    damEl.innerHTML = `<div style="background:#1e40af;color:white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);">🛡️</div>`;
    addMarker(damEl, [impactData.dam.lon, impactData.dam.lat],
      `<div style="font-weight:600">${impactData.dam.name}</div><div style="font-size:12px;color:#666">Height: ${impactData.dam.height_m}m</div>`
    );

    // ── Village markers ─────────────────────────────────────────────────
    impactData.villages.forEach((v) => {
      const flooded = v.flooded;
      const color = flooded ? HAZARD_COLORS[v.hazard_class] : '#94a3b8';
      const size = flooded ? 12 + v.depth_m * 4 : 10;

      const el = document.createElement('div');
      el.style.cssText = `
        width:${size}px;height:${size}px;background:${color};border-radius:50%;
        border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3);
        opacity:${flooded ? 1 : 0.7};transition:all 0.3s;cursor:pointer;
      `;
      el.title = `${v.name} — Pop: ${v.population.toLocaleString()}`;
      addMarker(el, [v.lon, v.lat],
        `<div style="font-weight:600">${v.name}</div>
         <div style="font-size:11px;color:#666">Pop: ${v.population.toLocaleString()}</div>
         <div style="font-size:11px;margin-top:4px">
           ${flooded
             ? `<span style="color:${HAZARD_COLORS[v.hazard_class]};font-weight:600">FLOODED</span> — Depth: ${v.depth_m.toFixed(1)}m`
             : `Arrival: T+${v.arrival_time_min} min`
           }
         </div>`
      );
    });

    // ── Facility markers ────────────────────────────────────────────────
    impactData.facilities.forEach((f) => {
      const el = document.createElement('div');
      el.style.cssText = 'font-size:18px;cursor:pointer;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3))';
      el.textContent = FACILITY_ICONS[f.kind] || '📍';
      addMarker(el, [f.lon, f.lat],
        `<div style="font-weight:600">${f.name}</div><div style="font-size:11px;color:#666;text-transform:capitalize">${f.kind.replace('_', ' ')}</div>`
      );
    });

    // ── Shelter markers ─────────────────────────────────────────────────
    impactData.shelters.forEach((s) => {
      const el = document.createElement('div');
      el.style.cssText = 'font-size:16px;cursor:pointer;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3))';
      el.textContent = '🏠';
      addMarker(el, [s.lon, s.lat],
        `<div style="font-weight:600">${s.name}</div><div style="font-size:11px;color:#666">Capacity: ${s.capacity.toLocaleString()}</div>`
      );
    });

    // ── Flood extent overlay (dynamic polygon) ──────────────────────────
    // Remove old flood layer/source if present
    if (map.getLayer('flood-extent')) map.removeLayer('flood-extent');
    if (map.getSource('flood-extent')) map.removeSource('flood-extent');

    if (impactData.floodExtent && timeMinutes > 0) {
      const { center: c, radiusDeg } = impactData.floodExtent;
      const r = radiusDeg;
      const coords: [number, number][] = [
        [c[0], c[1]],
        [c[0] - r, c[1] - r * 0.5],
        [c[0] - r * 1.3, c[1] - r * 0.15],
        [c[0] - r * 0.9, c[1] + r * 0.35],
        [c[0] + r * 0.1, c[1] + r * 0.1],
        [c[0], c[1]],
      ];

      map.addSource('flood-extent', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [coords] },
            properties: {},
          }],
        },
      });

      const layerPaint: Record<string, any> = {
        'fill-color': layer === 'hazard'
          ? ['interpolate', ['linear'], ['get', 'depth'], 0, '#3b82f6', 1, '#eab308', 2, '#f97316', 3, '#ef4444']
          : '#3b82f6',
        'fill-opacity': Math.min(0.45, timeMinutes / 80),
      };

      map.addLayer({
        id: 'flood-extent',
        type: 'fill',
        source: 'flood-extent',
        paint: layerPaint,
      });
    }

  }, [impactData, layer, timeMinutes]);

  // ── Legend overlay ─────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-full">
      {/* Legend */}
      <div className="absolute bottom-4 right-4 z-10 bg-white/90 backdrop-blur-sm rounded-lg px-3 py-2 shadow-md text-[11px]">
        <div className="font-semibold text-slate-700 mb-1.5">Legend</div>
        <div className="space-y-1">
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-blue-700" /> Dam</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-slate-400" /> Village (safe)</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-red-500" /> Village (flooded)</div>
          <div className="flex items-center gap-2"><div className="w-4 h-3 rounded bg-blue-400 opacity-50" /> Flood extent</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-green-500" /> Road safe</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-yellow-500" /> Road restricted</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-red-500" /> Road impassable</div>
        </div>
      </div>

      <div ref={mapContainer} className="w-full h-full" />
    </div>
  );
}
