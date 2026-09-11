/**
 * DamSafe Twin — CesiumJS 3D Digital Twin Viewer
 *
 * Consumes shared state from IncidentConsole.
 * Loads dam 3D tileset from API (Path A/B pipeline), animated water, village labels.
 * Syncs cameraTarget bidirectionally with the 2D MapLibre view.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Camera } from 'lucide-react';
import type { ImpactData } from '../../modules/incident-console/hooks';

interface DigitalTwinProps {
  timeMinutes: number;
  impactData: ImpactData | null;
  cameraTarget: { lon: number; lat: number; heightM: number } | null;
  onCameraChange: (target: { lon: number; lat: number; heightM: number }) => void;
}

const CAMERA_PRESETS = [
  { name: 'Dam Overview', lon: 70.85, lat: 22.83, height: 2000, heading: 0, pitch: -30 },
  { name: 'First Hit Village', lon: 70.82, lat: 22.78, height: 800, heading: 45, pitch: -45 },
  { name: 'Critical Bridge', lon: 70.80, lat: 22.80, height: 500, heading: 90, pitch: -60 },
  { name: 'District Command', lon: 70.83, lat: 22.82, height: 5000, heading: 0, pitch: -90 },
];

export default function DigitalTwin({ timeMinutes, impactData, cameraTarget, onCameraChange }: DigitalTwinProps) {
  const cesiumContainer = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const cesiumRef = useRef<any>(null);
  const entitiesRef = useRef<string[]>([]);
  const waterPrimitiveRef = useRef<any>(null);
  const tilesetRef = useRef<any>(null);
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [initDone, setInitDone] = useState(false);

  // ── Initialize Cesium once ────────────────────────────────────────────
  useEffect(() => {
    if (!cesiumContainer.current || viewerRef.current) return;
    let cancelled = false;

    import('cesium').then(async (Cesium) => {
      if (cancelled) return;
      cesiumRef.current = Cesium;

      const viewer = new Cesium.Viewer(cesiumContainer.current!, {
        baseLayer: Cesium.ImageryLayer.fromProviderAsync(
          Cesium.TileMapServiceImageryProvider.fromUrl(
            Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
          ),
        ),
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        selectionIndicator: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        vrButton: false,
        infoBox: false,
        shouldAnimate: true,
        requestRenderMode: false,
        maximumRenderTimeChange: Infinity,
      });

      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0f172a');

      // Set initial camera
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(70.85, 22.83, 2000),
        orientation: {
          heading: Cesium.Math.toRadians(0),
          pitch: Cesium.Math.toRadians(-30),
          roll: 0,
        },
        duration: 0,
      });

      // Track camera changes for bidirectional sync
      viewer.camera.changed.addEventListener(() => {
        const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
        const lon = Cesium.Math.toDegrees(carto.longitude);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        onCameraChange({ lon, lat, heightM: carto.height });
      });

      // Try to load dam 3D tileset from API
      try {
        const BASE = import.meta.env.VITE_API_BASE_URL || '';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (import.meta.env.DEV) headers['Authorization'] = 'Bearer dev-token';

        const res = await fetch(`${BASE}/api/v1/dams/10000000-0000-0000-0000-000000000001`, { headers });
        if (res.ok) {
          const damData = await res.json();
          // If a 3D model URL is available, load the tileset
          if (damData.model_3d_url) {
            try {
              const tileset = await Cesium.Cesium3DTileset.fromUrl(damData.model_3d_url);
              viewer.scene.primitives.add(tileset);
              await viewer.zoomTo(tileset);
              tilesetRef.current = tileset;
            } catch (tileErr) {
              console.warn('Failed to load 3D tileset:', tileErr);
            }
          }
        }
      } catch {
        // API not available — that's fine, we'll render without the 3D dam model
      }

      viewerRef.current = viewer;
      if (!cancelled) setInitDone(true);
    }).catch((err) => {
      console.error('Failed to load Cesium:', err);
    });

    return () => {
      cancelled = true;
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, []);

  // ── Sync camera from external changes ─────────────────────────────────
  useEffect(() => {
    if (!viewerRef.current || !cesiumRef.current || !cameraTarget) return;
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);

    // Only fly if significantly different
    if (Math.abs(lon - cameraTarget.lon) > 0.001 || Math.abs(lat - cameraTarget.lat) > 0.001) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(cameraTarget.lon, cameraTarget.lat, cameraTarget.heightM),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-30), roll: 0 },
        duration: 1.5,
      });
    }
  }, [cameraTarget]);

  // ── Render entities from impactData ───────────────────────────────────
  useEffect(() => {
    if (!viewerRef.current || !cesiumRef.current || !impactData) return;
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;

    // Remove old entities
    entitiesRef.current.forEach((id) => {
      try { viewer.entities.removeById(id); } catch {}
    });
    entitiesRef.current = [];

    const addEntity = (entity: any) => {
      const added = viewer.entities.add(entity);
      if (added?.id) entitiesRef.current.push(added.id);
      return added;
    };

    // ── Dam marker ──────────────────────────────────────────────────────
    addEntity({
      id: 'dam-marker',
      name: impactData.dam.name,
      position: Cesium.Cartesian3.fromDegrees(impactData.dam.lon, impactData.dam.lat, impactData.dam.height_m),
      point: {
        pixelSize: 14,
        color: Cesium.Color.fromCssColorString('#1e40af'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: `🛡️ ${impactData.dam.name}`,
        font: '13px sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        scaleByDistance: new Cesium.NearFarScalar(1000, 1, 20000, 0.5),
      },
    });

    // ── Village markers ─────────────────────────────────────────────────
    impactData.villages.forEach((v, i) => {
      const flooded = v.flooded;
      const remaining = Math.max(0, v.arrival_time_min - timeMinutes);
      const colorHex = flooded ? { green: '#22c55e', yellow: '#eab308', orange: '#f97316', red: '#ef4444' }[v.hazard_class] : '#94a3b8';

      addEntity({
        id: `village-${v.id}`,
        name: v.name,
        position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat),
        point: {
          pixelSize: flooded ? 10 : 8,
          color: Cesium.Color.fromCssColorString(colorHex),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text: `${v.name}\nPop: ${v.population.toLocaleString()}\n${flooded ? '🔴 FLOODED' : `⏱ T+${remaining}m`}`,
          font: '11px sans-serif',
          fillColor: flooded ? Cesium.Color.fromCssColorString(colorHex) : Cesium.Color.fromCssColorString('#475569'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 10),
          scaleByDistance: new Cesium.NearFarScalar(500, 1.2, 15000, 0.4),
        },
      });
    });

    // ── Facility markers ────────────────────────────────────────────────
    const facilityIcons: Record<string, string> = {
      hospital: '🏥', school: '🏫', substation: '⚡', telecom_tower: '📡', police_station: '🚔',
    };
    impactData.facilities.forEach((f) => {
      addEntity({
        id: `facility-${f.id}`,
        name: f.name,
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat),
        label: {
          text: `${facilityIcons[f.kind] || '📍'} ${f.name}`,
          font: '10px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#64748b'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 8),
          scaleByDistance: new Cesium.NearFarScalar(500, 1, 12000, 0.3),
        },
      });
    });

    // ── Water surface polygon ───────────────────────────────────────────
    // Remove old water entity
    try { viewer.entities.removeById('water-surface'); } catch {}

    if (timeMinutes > 0 && impactData.floodExtent) {
      const { center: c, radiusDeg } = impactData.floodExtent;
      const r = radiusDeg;
      addEntity({
        id: 'water-surface',
        name: 'Flood Water Surface',
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray([
            c[0], c[1],
            c[0] - r, c[1] - r * 0.5,
            c[0] - r * 1.3, c[1] - r * 0.15,
            c[0] - r * 0.9, c[1] + r * 0.35,
            c[0] + r * 0.1, c[1] + r * 0.1,
          ]),
          material: Cesium.Color.fromCssColorString('#3b82f6').withAlpha(0.3),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#2563eb').withAlpha(0.6),
          height: 0.5,
        },
      });
    }

  }, [impactData, timeMinutes]);

  // ── Camera preset flyTo ───────────────────────────────────────────────
  const flyToPreset = useCallback((index: number) => {
    if (!viewerRef.current || !cesiumRef.current) return;
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    const preset = CAMERA_PRESETS[index];
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(preset.lon, preset.lat, preset.height),
      orientation: {
        heading: Cesium.Math.toRadians(preset.heading),
        pitch: Cesium.Math.toRadians(preset.pitch),
        roll: 0,
      },
      duration: 2,
    });
    setSelectedPreset(index);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Camera Presets */}
      <div className="shrink-0 bg-white/90 backdrop-blur-sm rounded-lg px-3 py-2 shadow-md flex items-center gap-2 z-10 relative">
        <Camera className="w-4 h-4 text-slate-500" />
        <span className="text-xs font-medium text-slate-600">Presets:</span>
        {CAMERA_PRESETS.map((preset, i) => (
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

      {/* CesiumJS Container */}
      <div ref={cesiumContainer} className="flex-1 w-full" style={{ minHeight: 0 }} />

      {/* Legend */}
      <div className="shrink-0 flex items-center gap-5 text-[11px] text-slate-500 bg-white/90 backdrop-blur-sm rounded-lg px-3 py-1.5 shadow-md relative z-10 mt-2">
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-blue-700" /> Dam</div>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-slate-400" /> Village (safe)</div>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-red-600" /> Village (flooded)</div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-2.5 rounded bg-blue-400 opacity-50" /> Water surface</div>
      </div>
    </div>
  );
}
