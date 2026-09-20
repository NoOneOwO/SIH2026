/**
 * God's Eye View — 3D situational globe for DamSafe Twin.
 *
 * Integrates the bilawalsidhu/gods-eye-view system into the GeoLibre-side
 * 3D view (Incident Console globe branch) as an upgrade of the Cesium twin:
 *
 *   Basemap ladder (keyless-first, like GEV):
 *     Esri World Imagery (default, no key) → OSM fallback →
 *     Cesium ion photorealistic/terrain when VITE_CESIUM_ION_TOKEN is set.
 *
 *   GEV operators ported:
 *     - Sensor styles (Normal / Night / NVG / Thermal / Noir), keys 1-5
 *     - Detection overlay (screen-space boxes + IDs), key D
 *     - Click-to-track anything + Follow + Cockpit chase, Esc releases
 *     - Fading trail behind the tracked contact
 *     - Tactical HUD strip (camera, layers, tracked telemetry), key H
 *     - Live layers: USGS earthquakes + OpenSky flights (both keyless)
 *     - Share link (camera + style + layers + tracked target), Reset globe
 *
 *   DamSafe mission layers (unchanged semantics):
 *     dam / village / facility markers + flood water polygon from
 *     impactData, synced bidirectionally with the 2D GeoLibre view via
 *     cameraTarget / onCameraChange.
 *
 * No private keys ever touch the browser — keyed feeds (AISStream, FIRMS,
 * TomTom, OpenAI voice) stay disabled until a server-side proxy exists.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Building2, Camera, Crosshair, Eye, Link2, LocateFixed, Plane, Radio, Radar, RotateCcw, Satellite, Zap } from 'lucide-react';
import type { ImpactData } from '../../modules/incident-console/hooks';
import { fetchOSMContextGeo } from '../local-3d/osmContext';
import {
  MAX_FLIGHTS,
  OPENSKY_MIN_INTERVAL_MS,
  USGS_REFRESH_MS,
  bboxAround,
  fetchFlights,
  fetchQuakes,
  quakeColor,
  type FlightPoint,
  type QuakePoint,
} from './godsEyeLayers';

interface GodEye3DProps {
  timeMinutes: number;
  impactData: ImpactData | null;
  cameraTarget: { lon: number; lat: number; heightM: number } | null;
  onCameraChange: (target: { lon: number; lat: number; heightM: number }) => void;
  /** Dam focus (drives presets, flights bbox, reset). Falls back to impactData / Machhu. */
  focusDam?: { lon: number; lat: number; name: string } | null;
}

type BasemapKind = 'esri' | 'osm' | 'ion';
type SensorKind = 'normal' | 'night' | 'nvg' | 'thermal' | 'noir';

const SENSORS: Record<SensorKind, { label: string; filter: string; tint: string }> = {
  normal: { label: 'Normal', filter: 'none', tint: 'transparent' },
  night: { label: 'Night', filter: 'brightness(0.72) saturate(0.75)', tint: 'rgba(10,30,80,0.18)' },
  nvg: {
    label: 'NVG',
    filter: 'grayscale(1) brightness(0.95) sepia(1) hue-rotate(62deg) saturate(3.2) contrast(1.05)',
    tint: 'rgba(20,120,40,0.10)',
  },
  thermal: {
    label: 'Thermal',
    filter: 'grayscale(1) invert(1) hue-rotate(185deg) saturate(2.4) contrast(1.25)',
    tint: 'rgba(120,20,0,0.08)',
  },
  noir: { label: 'Noir', filter: 'grayscale(1) contrast(1.12)', tint: 'transparent' },
};
const SENSOR_ORDER: SensorKind[] = ['normal', 'night', 'nvg', 'thermal', 'noir'];

const ESRI_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';

/** Dry asphalt tone by OSM highway class (CSS, for Cesium polylines). */
function roadCss(kind: string): string {
  if (/motorway|trunk/.test(kind)) return '#ffffff';
  if (/primary|secondary/.test(kind)) return '#e2e8f0';
  return '#94a3b8';
}

interface DetectBox {
  id: string;
  label: string;
  x: number;
  y: number;
}

export interface ShareState {
  c: [number, number, number];
  s: SensorKind;
  l: { quakes: boolean; flights: boolean; detect: boolean };
  t: string | null;
}

export function encodeShare(s: ShareState): string {
  return btoa(JSON.stringify(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShare(hash: string): ShareState | null {
  try {
    const b64 = hash.replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(atob(b64));
    if (Array.isArray(o?.c) && typeof o?.s === 'string' && o.s in SENSORS) return o as ShareState;
    return null;
  } catch {
    return null;
  }
}

export default function GodEye3D({ timeMinutes, impactData, cameraTarget, onCameraChange, focusDam }: GodEye3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const cesiumRef = useRef<any>(null);
  const clickHandlerRef = useRef<any>(null);
  const entitiesRef = useRef<string[]>([]);
  const flightIdsRef = useRef<string[]>([]);
  const quakeIdsRef = useRef<string[]>([]);
  const trailRef = useRef<any[]>([]);
  const trackedIdRef = useRef<string | null>(null);
  const lastHudRef = useRef(0);
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;

  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<BasemapKind>('esri');
  const [sensor, setSensor] = useState<SensorKind>('normal');
  const [showHud, setShowHud] = useState(true);
  const [showDetect, setShowDetect] = useState(true);
  const [quakesOn, setQuakesOn] = useState(true);
  const [flightsOn, setFlightsOn] = useState(false);
  const [tracked, setTracked] = useState<{ id: string; label: string; detail: string } | null>(null);
  const [follow, setFollow] = useState(false);
  // OSM surroundings around the current camera view (any land, on demand).
  const [surr, setSurr] = useState<{ b: number; t: number; r: number } | null>(null);
  const [surrLoading, setSurrLoading] = useState(false);
  const surrIdsRef = useRef<string[]>([]);
  const surrBusyRef = useRef(false);
  const [boxes, setBoxes] = useState<DetectBox[]>([]);
  const [hud, setHud] = useState({ lon: 0, lat: 0, h: 0, contacts: 0 });
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);

  const damLon = focusDam?.lon ?? impactData?.dam.lon ?? 70.85;
  const damLat = focusDam?.lat ?? impactData?.dam.lat ?? 22.83;
  const damName = focusDam?.name ?? impactData?.dam.name ?? 'Machhu Dam';
  const damLonRef = useRef(damLon);
  damLonRef.current = damLon;
  const damLatRef = useRef(damLat);
  damLatRef.current = damLat;

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(''), 3500);
  }, []);

  const removeIds = useCallback((ids: string[]) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    ids.forEach((id) => {
      try {
        viewer.entities.removeById(id);
      } catch {
        /* gone */
      }
    });
  }, []);

  /** HUD contact count = live entity registry size (single source of truth). */
  const refreshContactCount = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      const n = viewer.entities.values.length;
      setHud((h) => ({ ...h, contacts: n }));
    } catch {
      /* registry not ready */
    }
  }, []);

  // ── Basemap switching (Esri keyless → OSM fallback → ion when tokened) ──
  const applyBasemap = useCallback(async (kind: BasemapKind) => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) return;
    try {
      viewer.imageryLayers.removeAll();
      if (kind === 'esri') {
        const p = await Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_URL);
        viewer.imageryLayers.addImageryProvider(p);
      } else if (kind === 'osm') {
        viewer.imageryLayers.addImageryProvider(
          new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
        );
      } else {
        // ion: photorealistic stack — needs VITE_CESIUM_ION_TOKEN (personal use)
        const token = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
        if (!token) {
          flash('No Cesium ion token — add VITE_CESIUM_ION_TOKEN for the ion stack.');
          setBasemap('esri');
          await applyBasemap('esri');
          return;
        }
        Cesium.Ion.defaultAccessToken = token;
        const p = await Cesium.IonImageryProvider.fromAssetId(2);
        viewer.imageryLayers.addImageryProvider(p);
      }
      setBasemap(kind);
    } catch (e) {
      console.warn('Basemap switch failed:', e);
      if (kind !== 'osm') {
        flash('Basemap unreachable — fell back to OSM.');
        await applyBasemap('osm');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);

  // ── Initialize Cesium once ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;
    let cancelled = false;

    import('cesium').then(async (Cesium) => {
      if (cancelled || !containerRef.current) return;
      cesiumRef.current = Cesium;

      // Optional ion token → world terrain (photorealistic 3D). Keyless
      // installs keep the default ellipsoid and still render everything.
      const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
      let terrainProvider: any = undefined;
      if (ionToken) {
        Cesium.Ion.defaultAccessToken = ionToken;
        try {
          terrainProvider = await Cesium.createWorldTerrainAsync();
        } catch {
          terrainProvider = undefined;
        }
      }

      const restored = window.location.hash.startsWith('#gev=')
        ? decodeShare(window.location.hash.slice(5))
        : null;
      if (restored) {
        setSensor(restored.s);
        setQuakesOn(restored.l.quakes);
        setFlightsOn(restored.l.flights);
        setShowDetect(restored.l.detect);
      }

      const viewer = new Cesium.Viewer(containerRef.current, {
        baseLayer: Cesium.ImageryLayer.fromProviderAsync(
          Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_URL),
        ),
        terrainProvider,
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
      viewer.scene.globe.enableLighting = false;

      const startLon = restored?.c[0] ?? damLonRef.current;
      const startLat = restored?.c[1] ?? damLatRef.current;
      const startH = restored?.c[2] ?? 9000;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(startLon, startLat, startH),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
        duration: 0,
      });

      // Bidirectional sync with the 2D GeoLibre view; HUD readout throttled
      // to ~5 Hz so per-frame camera events don't re-render the overlay.
      viewer.camera.changed.addEventListener(() => {
        const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
        const lon = Cesium.Math.toDegrees(carto.longitude);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        onCameraChangeRef.current({ lon, lat, heightM: carto.height });
        const now = performance.now();
        if (now - lastHudRef.current < 200) return;
        lastHudRef.current = now;
        setHud((h) => ({ ...h, lon, lat, h: carto.height }));
      });

      // Click-to-track anything (GEV signature): lock camera, trail, metadata.
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandlerRef.current = handler;
      handler.setInputAction((movement: any) => {
        const picked = viewer.scene.pick(movement.position);
        const entity = picked?.id;
        if (entity?.id && entity?.description) {
          trackedIdRef.current = entity.id as string;
          setTracked({
            id: entity.id as string,
            label: entity.name ?? entity.id,
            detail: typeof entity.description.getValue === 'function'
              ? String(entity.description.getValue(Cesium.JulianDate.now()))
              : '',
          });
          trailRef.current = [];
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      // Detection overlay painter — projects contacts to screen space.
      let lastPaint = 0;
      viewer.scene.postRender.addEventListener(() => {
        const now = performance.now();
        if (now - lastPaint < 350) return;
        lastPaint = now;
        setBoxes((prev) => {
          void prev;
          const v = viewerRef.current;
          const C = cesiumRef.current;
          if (!v || !C) return [];
          const out: DetectBox[] = [];
          const scratch = new C.Cartesian2();
          const tryPush = (id: string, label: string, pos: any) => {
            if (!pos || out.length >= 60) return;
            const s = C.SceneTransforms.w2c(v.scene, pos, scratch);
            if (!s) return;
            const r = containerRef.current?.getBoundingClientRect();
            if (!r) return;
            if (s.x < 0 || s.y < 0 || s.x > r.width || s.y > r.height) return;
            out.push({ id, label, x: s.x, y: s.y });
          };
          const t = C.JulianDate.now();
          for (const e of v.entities.values) {
            if (out.length >= 60) break;
            if (!e?.id || typeof e.id !== 'string') continue;
            if (!(e.id.startsWith('village-') || e.id.startsWith('flight-') || e.id.startsWith('quake-'))) continue;
            try {
              const p = e.position?.getValue?.(t);
              if (p) tryPush(e.id, e.name ?? e.id, p);
            } catch {
              /* skip */
            }
          }
          return out;
        });
      });

      viewerRef.current = viewer;
      if (!cancelled) {
        setReady(true);
        if (restored?.t) {
          window.setTimeout(() => {
            const e = viewer.entities.getById(restored.t!);
            if (e) {
              trackedIdRef.current = restored.t;
              setTracked({ id: restored.t!, label: e.name ?? restored.t!, detail: '' });
              setFollow(true);
              viewer.trackedEntity = e;
            }
          }, 2500);
        }
      }
    }).catch((err) => console.error('Failed to load Cesium:', err));

    return () => {
      cancelled = true;
      try {
        clickHandlerRef.current?.destroy();
      } catch {
        /* already gone */
      }
      clickHandlerRef.current = null;
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
      trackedIdRef.current = null;
    };
  }, []);

  // ── Sync camera from external (GeoLibre 2D) changes ─────────────────
  useEffect(() => {
    if (!viewerRef.current || !cesiumRef.current || !cameraTarget) return;
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (viewer.trackedEntity) return; // don't fight an active track
    const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    if (Math.abs(lon - cameraTarget.lon) > 0.002 || Math.abs(lat - cameraTarget.lat) > 0.002) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(cameraTarget.lon, cameraTarget.lat, cameraTarget.heightM),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
        duration: 1.5,
      });
    }
  }, [cameraTarget]);

  // ── Mission entities from impactData (dam / villages / facilities / water) ──
  useEffect(() => {
    if (!viewerRef.current || !cesiumRef.current || !impactData) return;
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    removeIds(entitiesRef.current);
    entitiesRef.current = [];
    const add = (entity: any) => {
      const added = viewer.entities.add(entity);
      if (added?.id) entitiesRef.current.push(added.id as string);
    };

    add({
      id: 'dam-marker',
      name: impactData.dam.name,
      description: `Dam • height ${impactData.dam.height_m} m`,
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

    impactData.villages.forEach((v) => {
      const flooded = v.flooded;
      const remaining = Math.max(0, v.arrival_time_min - timeMinutes);
      const colorHex = flooded
        ? ({ green: '#22c55e', yellow: '#eab308', orange: '#f97316', red: '#ef4444' } as Record<string, string>)[v.hazard_class]
        : '#94a3b8';
      add({
        id: `village-${v.id}`,
        name: v.name,
        description: flooded
          ? `Village • FLOODED • depth ${v.depth_m.toFixed(1)} m • pop ${v.population.toLocaleString()}`
          : `Village • pop ${v.population.toLocaleString()} • arrival T+${remaining} min`,
        position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat),
        point: {
          pixelSize: flooded ? 10 : 8,
          color: Cesium.Color.fromCssColorString(colorHex),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text: `${v.name}\n${flooded ? '🔴 FLOODED' : `⏱ T+${remaining}m`}`,
          font: '11px sans-serif',
          fillColor: Cesium.Color.fromCssColorString(colorHex),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 10),
          scaleByDistance: new Cesium.NearFarScalar(500, 1.2, 15000, 0.4),
        },
      });
    });

    const icons: Record<string, string> = {
      hospital: '🏥', school: '🏫', substation: '⚡', telecom_tower: '📡', police_station: '🚔',
    };
    impactData.facilities.forEach((f) => {
      add({
        id: `facility-${f.id}`,
        name: f.name,
        description: `Facility • ${f.kind.replace('_', ' ')}`,
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat),
        label: {
          text: `${icons[f.kind] || '📍'} ${f.name}`,
          font: '10px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#cbd5e1'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 8),
          scaleByDistance: new Cesium.NearFarScalar(500, 1, 12000, 0.3),
        },
      });
    });

    try {
      viewer.entities.removeById('water-surface');
    } catch {
      /* none */
    }
    if (timeMinutes > 0 && impactData.floodExtent) {
      const { center: c, radiusDeg } = impactData.floodExtent;
      const r = radiusDeg;
      add({
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
    refreshContactCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impactData, timeMinutes]);

  // ── Live layer: USGS earthquakes (keyless, 5-min refresh) ───────────
  useEffect(() => {
    if (!ready) return;
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) return;
    if (!quakesOn) {
      removeIds(quakeIdsRef.current);
      quakeIdsRef.current = [];
      refreshContactCount();
      return;
    }
    let dead = false;
    const ctrl = new AbortController();
    const paint = async () => {
      try {
        const quakes: QuakePoint[] = await fetchQuakes(ctrl.signal);
        if (dead) return;
        removeIds(quakeIdsRef.current);
        quakeIdsRef.current = [];
        const ids: string[] = [];
        for (const q of quakes) {
          viewer.entities.add({
            id: `quake-${q.id}`,
            name: `M${q.mag.toFixed(1)} ${q.place}`,
            description: `Earthquake • M${q.mag.toFixed(1)} • depth ${q.depthKm.toFixed(0)} km • ${q.place}`,
            position: Cesium.Cartesian3.fromDegrees(q.lon, q.lat),
            point: {
              pixelSize: Math.min(16, 5 + q.mag * 1.6),
              color: Cesium.Color.fromCssColorString(quakeColor(q.mag)),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 1.5,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
          });
          ids.push(`quake-${q.id}`);
        }
        quakeIdsRef.current = ids;
        refreshContactCount();
      } catch (e) {
        if (!dead) flash(`Earthquake feed unavailable (${(e as Error).message}).`);
      }
    };
    paint();
    const t = window.setInterval(paint, USGS_REFRESH_MS);
    return () => {
      dead = true;
      ctrl.abort();
      window.clearInterval(t);
    };
  }, [ready, quakesOn, removeIds, refreshContactCount, flash]);

  // ── Live layer: OpenSky flights (keyless anon, governed ≤1 req/30 s) ──
  useEffect(() => {
    if (!ready) return;
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) return;
    if (!flightsOn) {
      removeIds(flightIdsRef.current);
      flightIdsRef.current = [];
      refreshContactCount();
      return;
    }
    let dead = false;
    const ctrl = new AbortController();
    const paint = async () => {
      try {
        const flights: FlightPoint[] = await fetchFlights(bboxAround(damLonRef.current, damLatRef.current), ctrl.signal);
        if (dead) return;
        removeIds(flightIdsRef.current);
        flightIdsRef.current = [];
        const ids: string[] = [];
        for (const f of flights) {
          const altFt = f.altitudeM == null ? '—' : `${Math.round(f.altitudeM * 3.281).toLocaleString()} ft`;
          viewer.entities.add({
            id: `flight-${f.icao24}`,
            name: `✈ ${f.callsign}`,
            description: `Flight ${f.callsign} • ${altFt}${f.velocityMs != null ? ` • ${Math.round(f.velocityMs * 1.944)} kt` : ''}`,
            position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, Math.max(500, f.altitudeM ?? 3000)),
            point: {
              pixelSize: 7,
              color: Cesium.Color.fromCssColorString('#fbbf24'),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.NONE,
            },
            label: {
              text: f.callsign,
              font: '9px sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#fde68a'),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: Cesium.VerticalOrigin.TOP,
              pixelOffset: new Cesium.Cartesian2(0, 8),
              scaleByDistance: new Cesium.NearFarScalar(1000, 1, 60000, 0.3),
            },
          });
          ids.push(`flight-${f.icao24}`);
        }
        flightIdsRef.current = ids;
        refreshContactCount();
      } catch (e) {
        if (!dead) flash(`Flight feed unavailable (${(e as Error).message}).`);
      }
    };
    paint();
    const t = window.setInterval(paint, Math.max(OPENSKY_MIN_INTERVAL_MS, 30_000));
    return () => {
      dead = true;
      ctrl.abort();
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, flightsOn]);

  // ── OSM surroundings: buildings / trees / streets around THIS view ──
  // Works on any land you zoom to — no dam model required.
  const clearSurroundings = useCallback(() => {
    removeIds(surrIdsRef.current);
    surrIdsRef.current = [];
    setSurr(null);
    refreshContactCount();
  }, [removeIds, refreshContactCount]);

  const loadSurroundings = useCallback(async () => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || surrBusyRef.current) return;
    if (surr) {
      clearSurroundings();
      return;
    }
    surrBusyRef.current = true;
    setSurrLoading(true);
    flash('Loading OSM surroundings around this view…');
    try {
      const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      const g = await fetchOSMContextGeo(lon, lat);
      if (!g || (!g.buildings.length && !g.trees.length && !g.roads.length)) {
        flash('No mapped buildings / trees / streets in this view.');
        return;
      }
      const ids: string[] = [];
      const bldMat = Cesium.Color.fromCssColorString('#c7cfd6').withAlpha(0.92);
      g.buildings.forEach((b, i) => {
        const flat: number[] = [];
        b.ring.forEach(([lo, la]) => flat.push(lo, la));
        viewer.entities.add({
          id: `surr-bld-${i}`,
          name: 'Building',
          description: `Building • ~${Math.round(b.heightM)} m • OpenStreetMap`,
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
            height: 0,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            extrudedHeight: Math.max(2, b.heightM),
            material: bldMat,
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('#475569'),
          },
        });
        ids.push(`surr-bld-${i}`);
      });
      const treeMat = Cesium.Color.fromCssColorString('#2f9e44');
      g.trees.slice(0, 800).forEach(([lo, la], i) => {
        viewer.entities.add({
          id: `surr-tree-${i}`,
          name: 'Tree',
          description: 'Tree • OpenStreetMap',
          position: Cesium.Cartesian3.fromDegrees(lo, la),
          point: {
            pixelSize: 5,
            color: treeMat,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        });
        ids.push(`surr-tree-${i}`);
      });
      g.roads.forEach((r, i) => {
        const flat: number[] = [];
        r.pts.forEach(([lo, la]) => flat.push(lo, la));
        viewer.entities.add({
          id: `surr-road-${i}`,
          name: `Street (${r.kind})`,
          description: `Street • ${r.kind} • OpenStreetMap`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(flat),
            clampToGround: true,
            width: 2,
            material: Cesium.Color.fromCssColorString(roadCss(r.kind)),
          },
        });
        ids.push(`surr-road-${i}`);
      });
      surrIdsRef.current = ids;
      const shown = Math.min(800, g.trees.length);
      setSurr({ b: g.buildings.length, t: shown, r: g.roads.length });
      refreshContactCount();
      flash(`Surroundings: ${g.buildings.length} buildings • ${shown} trees • ${g.roads.length} streets. Click again to clear.`);
    } catch (e) {
      flash(`Surroundings unavailable (${(e as Error).message}).`);
    } finally {
      surrBusyRef.current = false;
      setSurrLoading(false);
    }
  }, [surr, clearSurroundings, refreshContactCount, flash]);

  // ── Trail sampler for the tracked contact ───────────────────────────
  useEffect(() => {
    if (!ready || !tracked) return;
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    const t = window.setInterval(() => {
      const e = viewer.entities.getById(tracked.id);
      if (!e?.position) return;
      try {
        const p = e.position.getValue(Cesium.JulianDate.now());
        if (!p) return;
        trailRef.current = [...trailRef.current.slice(-48), p.clone()];
        try {
          viewer.entities.removeById('track-trail');
        } catch {
          /* none */
        }
        if (trailRef.current.length > 1) {
          viewer.entities.add({
            id: 'track-trail',
            polyline: {
              positions: [...trailRef.current],
              width: 2,
              material: Cesium.Color.fromCssColorString('#65BFA9').withAlpha(0.85),
              clampToGround: false,
            },
          });
        }
      } catch {
        /* skip frame */
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [ready, tracked]);

  // ── Follow / cockpit / release ──────────────────────────────────────
  const setTrackFollow = useCallback((on: boolean) => {
    const viewer = viewerRef.current;
    if (!viewer || !tracked) return;
    const e = viewer.entities.getById(tracked.id);
    if (!e) return;
    viewer.trackedEntity = on ? e : undefined;
    setFollow(on);
  }, [tracked]);

  const enterCockpit = useCallback(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || !tracked) return;
    const e = viewer.entities.getById(tracked.id);
    if (!e?.position) return;
    const p = e.position.getValue(Cesium.JulianDate.now());
    if (!p) return;
    const carto = Cesium.Cartographic.fromCartesian(p);
    viewer.trackedEntity = undefined;
    setFollow(false);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, Math.max(600, carto.height + 400)),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-75), roll: 0 },
      duration: 1.6,
    });
    flash('Cockpit view — riding the tracked contact.');
  }, [tracked, flash]);

  const releaseTrack = useCallback(() => {
    const viewer = viewerRef.current;
    if (viewer) {
      viewer.trackedEntity = undefined;
      try {
        viewer.entities.removeById('track-trail');
      } catch {
        /* none */
      }
    }
    trackedIdRef.current = null;
    trailRef.current = [];
    setTracked(null);
    setFollow(false);
  }, []);

  // ── Reset globe / share link ────────────────────────────────────────
  const resetGlobe = useCallback(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) return;
    releaseTrack();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(damLon, damLat, 9000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
      duration: 2,
    });
  }, [damLon, damLat, releaseTrack]);

  const shareLink = useCallback(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) return;
    const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    const s: ShareState = {
      c: [
        Cesium.Math.toDegrees(carto.longitude),
        Cesium.Math.toDegrees(carto.latitude),
        carto.height,
      ],
      s: sensor,
      l: { quakes: quakesOn, flights: flightsOn, detect: showDetect },
      t: tracked?.id ?? null,
    };
    const url = `${window.location.origin}${window.location.pathname}#gev=${encodeShare(s)}`;
    void navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => flash('Clipboard blocked — copy the URL manually.'),
    );
  }, [sensor, quakesOn, flightsOn, showDetect, tracked, flash]);

  // ── Keyboard: 1-5 sensors · H HUD · D detection · C cockpit · Esc out ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k >= '1' && k <= '5') setSensor(SENSOR_ORDER[Number(k) - 1]);
      else if (k === 'h') setShowHud((v) => !v);
      else if (k === 'd') setShowDetect((v) => !v);
      else if (k === 'c' && tracked) enterCockpit();
      else if (k === 'escape') releaseTrack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tracked, enterCockpit, releaseTrack]);

  const S = SENSORS[sensor];

  return (
    <div className="relative w-full h-full bg-[#0b1526] overflow-hidden">
      {/* Cesium canvas (sensor filter = GEV optics) */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ filter: S.filter }}
      />
      {/* Sensor tint wash */}
      <div className="absolute inset-0 pointer-events-none" style={{ background: S.tint }} />
      {/* Cinematic vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(4,10,24,0.42) 100%)' }}
      />

      {/* Detection overlay — screen-space boxes + IDs */}
      {showDetect && boxes.map((b) => (
        <div
          key={b.id}
          className="absolute pointer-events-none z-10"
          style={{ left: b.x - 14, top: b.y - 14 }}
        >
          <div className="w-7 h-7 border border-cmd-teal/80 rounded-[3px]" />
          <div className="mt-0.5 px-1 py-px bg-[#0A1218]/85 text-cmd-teal text-[9px] font-mono whitespace-nowrap rounded">
            {b.label}
          </div>
        </div>
      ))}

      {/* ── Tactical HUD ── */}
      {showHud && (
        <div className="absolute top-3 left-3 z-20 flex items-center gap-2">
          <div className="px-3 py-1.5 bg-[#0A1218]/85 border border-cmd-border text-cmd-ink text-[10px] font-bold rounded-full">
            👁 GOD'S EYE — {damName}
          </div>
          <div className="px-3 py-1.5 bg-[#0A1218]/85 border border-cmd-border text-cmd-muted text-[10px] font-mono rounded-full tabular-nums">
            {hud.lon.toFixed(3)}° {hud.lat.toFixed(3)}° • {hud.h >= 1000 ? `${(hud.h / 1000).toFixed(1)} km` : `${Math.round(hud.h)} m`} • {hud.contacts} contacts
          </div>
        </div>
      )}

      {/* ── Control rail ── */}
      <div className="absolute top-3 right-3 z-20 flex flex-col gap-1.5 items-end">
        <div className="flex gap-1.5">
          <button onClick={resetGlobe} title="Reset globe (dam overview)"
            className="p-2 rounded-lg border border-cmd-border bg-[#0A1218]/90 text-cmd-muted hover:text-cmd-ink hover:border-cmd-teal/40 transition-colors">
            <RotateCcw className="w-4 h-4" />
          </button>
          <button onClick={shareLink} title="Copy share link (camera + style + layers + target)"
            className="p-2 rounded-lg border border-cmd-border bg-[#0A1218]/90 text-cmd-muted hover:text-cmd-ink hover:border-cmd-teal/40 transition-colors">
            <Link2 className="w-4 h-4" />
          </button>
          <button onClick={() => setShowHud((v) => !v)} title="Toggle HUD (H)"
            className={`p-2 rounded-lg border bg-[#0A1218]/90 transition-colors ${showHud ? 'text-cmd-teal border-cmd-teal/50' : 'text-cmd-muted border-cmd-border hover:text-cmd-ink'}`}>
            <Radar className="w-4 h-4" />
          </button>
          <button onClick={() => setShowDetect((v) => !v)} title="Toggle detection overlay (D)"
            className={`p-2 rounded-lg border bg-[#0A1218]/90 transition-colors ${showDetect ? 'text-cmd-teal border-cmd-teal/50' : 'text-cmd-muted border-cmd-border hover:text-cmd-ink'}`}>
            <Crosshair className="w-4 h-4" />
          </button>
        </div>
        {copied && (
          <div className="px-2.5 py-1 bg-[#0A1218]/90 border border-cmd-teal/50 text-cmd-teal text-[10px] font-bold rounded-full">
            Share link copied
          </div>
        )}
        {notice && (
          <div className="px-2.5 py-1 bg-[#0A1218]/90 border border-cmd-amber/50 text-cmd-amber text-[10px] rounded-full max-w-64">
            {notice}
          </div>
        )}
      </div>

      {/* ── Sensor + basemap + layers bar ── */}
      <div className="absolute bottom-3 left-3 z-20 flex flex-wrap items-center gap-1.5 max-w-[70%]">
        <div className="flex items-center gap-1 px-2 py-1 bg-[#0A1218]/90 border border-cmd-border rounded-full">
          <Eye className="w-3.5 h-3.5 text-cmd-muted" />
          {SENSOR_ORDER.map((k, i) => (
            <button
              key={k}
              onClick={() => setSensor(k)}
              title={`${SENSORS[k].label} (${i + 1})`}
              className={`px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors ${
                sensor === k ? 'bg-cmd-teal/90 text-[#071018]' : 'text-cmd-muted hover:text-cmd-ink'
              }`}
            >
              {SENSORS[k].label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 px-2 py-1 bg-[#0A1218]/90 border border-cmd-border rounded-full">
          <Satellite className="w-3.5 h-3.5 text-cmd-muted" />
          {(['esri', 'osm', 'ion'] as BasemapKind[]).map((k) => (
            <button
              key={k}
              onClick={() => void applyBasemap(k)}
              className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase transition-colors ${
                basemap === k ? 'bg-cmd-teal/90 text-[#071018]' : 'text-cmd-muted hover:text-cmd-ink'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 px-2 py-1 bg-[#0A1218]/90 border border-cmd-border rounded-full">
          <button
            onClick={() => setQuakesOn((v) => !v)}
            title="USGS earthquakes, 24 h (keyless)"
            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors ${
              quakesOn ? 'bg-cmd-amber/90 text-[#071018]' : 'text-cmd-muted hover:text-cmd-ink'
            }`}
          >
            <Zap className="w-3 h-3" /> Quakes
          </button>
          <button
            onClick={() => setFlightsOn((v) => !v)}
            title={`Live flights near dam — OpenSky anon, ≤1 req/30 s, max ${MAX_FLIGHTS}`}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors ${
              flightsOn ? 'bg-cmd-amber/90 text-[#071018]' : 'text-cmd-muted hover:text-cmd-ink'
            }`}
          >
            <Plane className="w-3 h-3" /> Flights
          </button>
          <button
            onClick={() => void loadSurroundings()}
            title="Load real OSM buildings / trees / streets around the current view — works on any land"
            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors ${
              surr ? 'bg-cmd-teal/90 text-[#071018]' : 'text-cmd-muted hover:text-cmd-ink'
            }`}
          >
            <Building2 className="w-3 h-3" />
            {surrLoading ? '…' : surr ? `${surr.b}🏠 ${surr.t}🌳` : 'Surroundings'}
          </button>
        </div>
      </div>

      {/* ── Tracked contact card ── */}
      {tracked && (
        <div className="absolute bottom-3 right-3 z-20 w-72 bg-[#0A1218]/92 backdrop-blur border border-cmd-teal/40 rounded-xl p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-bold text-cmd-ink truncate">🎯 {tracked.label}</p>
              <p className="text-[10px] text-cmd-muted mt-0.5 leading-relaxed">{tracked.detail}</p>
            </div>
            <button onClick={releaseTrack} className="text-cmd-muted hover:text-cmd-ink text-sm px-1" title="Release (Esc)">✕</button>
          </div>
          <div className="flex gap-1.5 mt-2">
            <button
              onClick={() => setTrackFollow(!follow)}
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold transition-colors ${
                follow ? 'bg-cmd-teal/90 text-[#071018]' : 'border border-cmd-border text-cmd-muted hover:text-cmd-ink'
              }`}
            >
              <LocateFixed className="w-3 h-3" /> {follow ? 'Following' : 'Follow'}
            </button>
            <button
              onClick={enterCockpit}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold border border-cmd-border text-cmd-muted hover:text-cmd-ink transition-colors"
              title="Ride the contact (C)"
            >
              <Camera className="w-3 h-3" /> Cockpit
            </button>
          </div>
        </div>
      )}

      {/* Data-source footnote */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 hidden xl:flex items-center gap-1.5 text-[9px] text-cmd-muted/70 font-mono">
        <Radio className="w-3 h-3" />
        <span>Esri World Imagery • USGS • OpenSky anon — public data, may be delayed/incomplete; not for navigation or operational response</span>
      </div>

      {!ready && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#0b1526]/70">
          <div className="w-8 h-8 border-4 border-cmd-teal border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-cmd-muted">Opening God's Eye…</p>
        </div>
      )}
    </div>
  );
}
