/**
 * AquaShield 3D — Local 3D Dam View (true 3D, NO globe).
 *
 * Renders only the dam site + nearby terrain as a real 3D mesh in Three.js:
 *   - Textured terrain GLB from the terrain-pipeline (real DEM + satellite)
 *     served same-origin from /terrain/<slug>.glb
 *   - OrbitControls (rotate / zoom / pan), dam marker pin at the true
 *     dam coordinates, height readout.
 *   - Real surroundings composited from OpenStreetMap (Overpass, keyless):
 *     extruded buildings, instanced trees, draped streets — all sampled
 *     against the flood grid, so inundated structures light up red live.
 *
 * Nothing else renders — no globe sphere, no world tiles, no map SDK.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { DamPoint } from '../../data/india-dams';
import { fetchOSMContext, type OSMContext } from './osmContext';

/** Flood overlay: sim-grid arrival/depth painted onto the mesh via vertex
 * colors (multiplied with the satellite texture). The scene is updated
 * incrementally — never destroyed/recreated per timestep.
 *
 * Two grid bindings are supported:
 *  - proportional (legacy sandbox): sim grid spans the whole GLB mesh;
 *  - geo (LISFLOOD-FP): result grid is a UTM metric crop around the dam;
 *    mesh vertices (local metres: x=east, z=south of the dam anchor) are
 *    mapped through `geo`. Vertices outside the crop stay dry.
 */
export interface FloodGeo {
  west: number;   // UTM easting of grid left edge (metres)
  north: number;  // UTM northing of grid top edge (metres)
  cell: number;   // cell size (metres)
  damEasting: number;   // UTM anchor both frames share (dam cell)
  damNorthing: number;
}
export interface FloodOverlay {
  key: string; // unique per run — re-init colors when it changes
  arrival: Float32Array; // sim rows*cols, minutes since breach, -1 = dry
  depth: Float32Array; // sim rows*cols, max depth m (fallback when no frames)
  rows: number;
  cols: number;
  tMin: number; // current timeline position
  visible: boolean;
  /** Geo-aware LISFLOOD binding (absent = legacy proportional mapping). */
  geo?: FloodGeo;
  /** Sandbox sim-domain bounds [west, south, east, north] in degrees
   * (backend `bbox_wsen`). Lets the God's Eye globe drape the same grids
   * as a terrain-following imagery overlay — no mesh required. */
  bboxWsen?: [number, number, number, number];
  /** Per-frame depth grids for time animation (row-major rows*cols each). */
  frames?: Float32Array[];
  /** Frame timestamps (minutes). */
  frameTimesMin?: number[];
  /** Valley flow path (lon/lat) traced from the dam — drawn as a line. */
  flowPath?: Array<[number, number]>;
  /** Water-surface opacity (default 0.78). */
  opacity?: number;
  /** Terrain mesh visibility (default true). */
  terrainVisible?: boolean;
}

interface Local3DViewProps {
  dam: DamPoint;
  /** e.g. "Tehri_Dam" → loads /terrain/Tehri_Dam.glb */
  slug: string;
  hazardColor: string;
  onShowMap: () => void;
  onClose: () => void;
  flood?: FloodOverlay | null;
  /** Slow 360° camera drift (used behind the sandbox AI transition). */
  autoOrbit?: boolean;
  /** Cinematic simulation mode: glide the camera in close, lock user input,
   * and keep the terrain slowly spinning until turned off. */
  cinematic?: boolean;
  /** Continuous slow spin (sandbox/simulation ambience). */
  spin?: boolean;
  /** Spin speed for autoRotate (default 0.7; cinematic/sandbox use faster). */
  spinSpeed?: number;
}

interface ModelMeta {
  elevation_min_m: number;
  elevation_max_m: number;
  lat: number;
  lon: number;
  bbox_radius_km: number;
  sources: { dem: string; texture: string };
  mesh_grid?: { rows: number; cols: number };
  vertical_exaggeration?: number;
}

interface ModelTransform {
  center_elevation_m: number;
  vertical_exaggeration: number;
}

/** Depth → water-surface color (matches the on-screen legend). */
export function waterColor(d: number): [number, number, number] {
  if (d < 0.3) return [0.45, 0.75, 1.0];
  if (d < 1.0) return [0.35, 0.95, 1.0];
  if (d < 2.5) return [1.0, 0.62, 0.25];
  return [1.0, 0.28, 0.28];
}

/** Dry asphalt tone by OSM highway class (linear RGB for vertex colors). */
export function roadDryColor(kind: string): [number, number, number] {
  if (/motorway|trunk/.test(kind)) return [1, 1, 1];
  if (/primary|secondary/.test(kind)) return [0.89, 0.91, 0.94];
  if (/tertiary|unclassified|residential/.test(kind)) return [0.8, 0.83, 0.88];
  return [0.58, 0.64, 0.69];
}

/** Map a row-major mesh vertex to the sim grid (nearest resample). */
function simCellForVertex(v: number, meshRows: number, meshCols: number,
                          simRows: number, simCols: number): number {
  const mr = Math.floor(v / meshCols);
  const mc = v % meshCols;
  const sr = Math.min(simRows - 1, Math.round((mr * (simRows - 1)) / Math.max(meshRows - 1, 1)));
  const sc = Math.min(simCols - 1, Math.round((mc * (simCols - 1)) / Math.max(meshCols - 1, 1)));
  return sr * simCols + sc;
}

/** Geo-aware cell lookup for LISFLOOD result grids.
 * GLB local frame: x = metres east of dam anchor, z = metres south. */
function geoCellForVertex(x: number, z: number, geo: FloodGeo,
                          simRows: number, simCols: number): number {
  const sc = Math.round(((geo.damEasting + x) - geo.west) / geo.cell);
  const sr = Math.round((geo.north - (geo.damNorthing - z)) / geo.cell);
  if (sc < 0 || sr < 0 || sc >= simCols || sr >= simRows) return -1;
  return sr * simCols + sc;
}

/** Depth grid active at the current timeline position.
 * With animation frames: the latest frame at/before tMin (real LISFLOOD
 * time slices). Without: the max-depth grid (legacy behaviour). */
function depthAtTime(F: FloodOverlay): Float32Array {
  if (F.frames?.length && F.frameTimesMin?.length === F.frames.length) {
    let pick = F.frames[0];
    for (let k = 0; k < F.frames.length; k++) {
      if (F.frameTimesMin[k] <= F.tMin + 1e-9) pick = F.frames[k];
      else break;
    }
    return pick;
  }
  return F.depth;
}

/** Depth → tint (multiplied over the satellite texture). */
export function depthTint(d: number): [number, number, number] {
  if (d < 0.05) return [1, 1, 1];
  if (d < 0.3) return [0.45, 0.75, 1.0];
  if (d < 1.0) return [0.35, 0.95, 1.0];
  if (d < 2.5) return [1.0, 0.62, 0.25];
  return [1.0, 0.28, 0.28];
}

function makeLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(8,15,30,0.85)';
  const r = 28;
  ctx.beginPath();
  ctx.roundRect(6, 20, 500, 88, r);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 44px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 66);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(900, 225, 1);
  sprite.renderOrder = 999;
  return sprite;
}

export default function Local3DView({ dam, slug, hazardColor, onShowMap, onClose, flood, autoOrbit, cinematic, spin, spinSpeed }: Local3DViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  // Scene handles shared with the water/HUD effects (scene itself is never rebuilt).
  const sceneRef = useRef<{
    scene: THREE.Scene; camera: THREE.PerspectiveCamera; terrain: THREE.Mesh;
    pin: THREE.Mesh; beam: THREE.Mesh; water: THREE.Mesh | null;
    flow: THREE.LineSegments | null;
  } | null>(null);
  const savedCamRef = useRef<{ pos: THREE.Vector3; tgt: THREE.Vector3 } | null>(null);
  const [hover, setHover] = useState<{ elevM: number | null; depthM: number } | null>(null);
  const hoverKeyRef = useRef<string>('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [meta, setMeta] = useState<ModelMeta | null>(null);
  const [xf, setXf] = useState<ModelTransform | null>(null);
  const [error, setError] = useState<string>('');
  // Flood paint state (mesh + material refs survive across timeline updates)
  const paintRef = useRef<{
    mesh: THREE.Mesh;
    colorAttr: THREE.BufferAttribute | null;
    count: number;
  } | null>(null);
  const applyRef = useRef<(() => void) | null>(null);
  const metaRef = useRef<ModelMeta | null>(null);
  metaRef.current = meta;
  const xfRef = useRef<ModelTransform | null>(null);
  xfRef.current = xf;
  const floodRef = useRef<FloodOverlay | null | undefined>(null);
  floodRef.current = flood;

  // ── OSM surroundings (buildings / trees / streets) ────────────────
  // Regular-grid elevation cache: the GLB terrain is a row-major mesh, so
  // ground height is a bilinear lookup (no per-point raycasts).
  const gridRef = useRef<{
    rows: number; cols: number;
    minX: number; maxX: number; minZ: number; maxZ: number;
    ys: Float32Array;
  } | null>(null);
  const ctxRef = useRef<{
    group: THREE.Group; bld: THREE.Group; tree: THREE.Group; road: THREE.Group;
    bldMeshes: Array<{ mesh: THREE.Mesh; cx: number; cz: number }>;
    roadSegs: Array<{ ax: number; az: number; bx: number; bz: number; kind: string }>;
    roadColorAttr: THREE.BufferAttribute | null;
    dryMat: THREE.Material; floodMat: THREE.Material;
  } | null>(null);
  const [ctx, setCtx] = useState<OSMContext | null>(null);
  const [ctxStatus, setCtxStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [showBld, setShowBld] = useState(true);
  const [showTrees, setShowTrees] = useState(true);
  const [showRoads, setShowRoads] = useState(true);
  const showBldRef = useRef(showBld);
  showBldRef.current = showBld;
  const showTreesRef = useRef(showTrees);
  showTreesRef.current = showTrees;
  const showRoadsRef = useRef(showRoads);
  showRoadsRef.current = showRoads;
  const [structStats, setStructStats] = useState({ bTotal: 0, bFlood: 0, trees: 0, roadsKm: 0 });

  // Snapshot the terrain elevation grid once the mesh + meta are both in.
  // Powers O(1) ground-height lookups for draping buildings/trees/roads.
  const captureGrid = useCallback(() => {
    const S = sceneRef.current;
    const mg = metaRef.current?.mesh_grid;
    if (!S?.terrain || !mg || gridRef.current) return;
    const pos = S.terrain.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || pos.count !== mg.rows * mg.cols) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const ys = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      ys[i] = pos.getY(i);
    }
    gridRef.current = { rows: mg.rows, cols: mg.cols, minX, maxX, minZ, maxZ, ys };
  }, []);

  /** Bilinear ground height (exaggerated GLB frame) at local (x, z). */
  const groundAt = useCallback((x: number, z: number): number | null => {
    const G = gridRef.current;
    if (!G) return null;
    if (x < G.minX || x > G.maxX || z < G.minZ || z > G.maxZ) return null;
    const fx = ((x - G.minX) / Math.max(G.maxX - G.minX, 1e-6)) * (G.cols - 1);
    const fz = ((z - G.minZ) / Math.max(G.maxZ - G.minZ, 1e-6)) * (G.rows - 1);
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const x1 = Math.min(G.cols - 1, x0 + 1);
    const z1 = Math.min(G.rows - 1, z0 + 1);
    const tx = fx - x0;
    const tz = fz - z0;
    const y00 = G.ys[z0 * G.cols + x0];
    const y10 = G.ys[z0 * G.cols + x1];
    const y01 = G.ys[z1 * G.cols + x0];
    const y11 = G.ys[z1 * G.cols + x1];
    return (y00 * (1 - tx) + y10 * tx) * (1 - tz) + (y01 * (1 - tx) + y11 * tx) * tz;
  }, []);

  /** Flood state at a local (x, z): same grid binding as the water mesh. */
  const sampleFlood = useCallback((x: number, z: number): { wet: boolean; depth: number } => {
    const F = floodRef.current;
    const mg = metaRef.current?.mesh_grid;
    const dry = { wet: false, depth: 0 };
    if (!F?.visible || !mg) return dry;
    let i = -1;
    if (F.geo) {
      i = geoCellForVertex(x, z, F.geo, F.rows, F.cols);
    } else {
      const G = gridRef.current;
      if (!G) return dry;
      const mc = Math.max(0, Math.min(mg.cols - 1,
        Math.round(((x - G.minX) / Math.max(G.maxX - G.minX, 1e-6)) * (mg.cols - 1))));
      const mr = Math.max(0, Math.min(mg.rows - 1,
        Math.round(((z - G.minZ) / Math.max(G.maxZ - G.minZ, 1e-6)) * (mg.rows - 1))));
      const sr = Math.min(F.rows - 1, Math.round((mr * (F.rows - 1)) / Math.max(mg.rows - 1, 1)));
      const sc = Math.min(F.cols - 1, Math.round((mc * (F.cols - 1)) / Math.max(mg.cols - 1, 1)));
      i = sr * F.cols + sc;
    }
    if (i < 0) return dry;
    const a = F.arrival[i];
    const d = depthAtTime(F)[i];
    const wet = a >= 0 && a <= F.tMin && d > 0.05;
    return { wet, depth: wet ? d : 0 };
  }, []);

  /** Re-tint surroundings for the current timeline minute (no rebuild). */
  const updateContextFlood = useCallback(() => {
    const C = ctxRef.current;
    if (!C) return;
    let bFlood = 0;
    for (const b of C.bldMeshes) {
      const s = sampleFlood(b.cx, b.cz);
      b.mesh.material = s.wet ? C.floodMat : C.dryMat;
      if (s.wet) bFlood++;
    }
    if (C.roadColorAttr) {
      const arr = C.roadColorAttr.array as Float32Array;
      for (let k = 0; k < C.roadSegs.length; k++) {
        for (const [px, pz, off] of [
          [C.roadSegs[k].ax, C.roadSegs[k].az, k * 6],
          [C.roadSegs[k].bx, C.roadSegs[k].bz, k * 6 + 3],
        ] as Array<[number, number, number]>) {
          const s = sampleFlood(px, pz);
          const c = s.wet ? waterColor(s.depth) : roadDryColor(C.roadSegs[k].kind);
          arr[off] = c[0];
          arr[off + 1] = c[1];
          arr[off + 2] = c[2];
        }
      }
      C.roadColorAttr.needsUpdate = true;
    }
    setStructStats((p) => (p.bFlood === bFlood ? p : { ...p, bFlood }));
  }, [sampleFlood]);

  // Re-paint whenever flood state, meta, or model readiness changes.
  // The scene itself is never rebuilt — only the color attribute updates.
  useEffect(() => {
    applyRef.current?.();
    captureGrid();
    updateContextFlood();
  }, [flood, meta, status, captureGrid, updateContextFlood]);

  // Spin toggle: ambient rotation during sandbox/simulation runs.
  // The render loop calls controls.update() every frame, so flipping
  // autoRotate orbits without rebuilding the scene.
  useEffect(() => {
    const C = controlsRef.current;
    if (!C) return;
    if (cinematic) return; // cinematic effect owns rotation while active
    C.autoRotate = !!(autoOrbit || spin);
    C.autoRotateSpeed = spin && !autoOrbit ? (spinSpeed ?? 2.2) : 0.7;
  }, [autoOrbit, cinematic, spin, spinSpeed]);

  // ── Cinematic simulation mode ────────────────────────────────
  // Glide in close over the terrain, lock user input, and keep spinning.
  // Restores the exact previous camera when turned off.
  useEffect(() => {
    const S = sceneRef.current;
    const C = controlsRef.current;
    if (!S || !C || status !== 'ready') return;
    if (cinematic) {
      if (!savedCamRef.current) {
        savedCamRef.current = { pos: S.camera.position.clone(), tgt: C.target.clone() };
      }
      const box = new THREE.Box3().setFromObject(S.terrain);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const dist = THREE.MathUtils.clamp(Math.max(size.x, size.z) * 0.42, 900, 16000);
      const toPos = new THREE.Vector3(
        center.x + dist * 0.55, center.y + dist * 0.62, center.z + dist * 0.55,
      );
      const fromPos = S.camera.position.clone();
      const fromTgt = C.target.clone();
      C.enabled = false; // locked: the shot belongs to the simulation
      C.autoRotate = true;
      C.autoRotateSpeed = 0.9;
      const t0 = performance.now();
      let raf = 0;
      let dead = false;
      const step = () => {
        if (dead) return;
        const k = Math.min(1, (performance.now() - t0) / 1400);
        const e = 1 - Math.pow(1 - k, 3);
        S.camera.position.lerpVectors(fromPos, toPos, e);
        C.target.lerpVectors(fromTgt, center, e);
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => { dead = true; cancelAnimationFrame(raf); };
    }
    // Release: restore the exact pre-cinematic framing.
    const sv = savedCamRef.current;
    savedCamRef.current = null;
    C.enabled = true;
    C.autoRotate = !!autoOrbit;
    if (sv) {
      S.camera.position.copy(sv.pos);
      C.target.copy(sv.tgt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cinematic, status]);

  // Terrain visibility toggle (LISFLOOD water-only inspection).
  useEffect(() => {
    const S = sceneRef.current;
    if (S?.terrain) S.terrain.visible = flood?.terrainVisible !== false;
  }, [flood?.terrainVisible, status]);

  // ── Animated water surface ─────────────────────────────────────
  // A live mesh draped over the terrain: every mesh vertex wet at the
  // current timeline position rises by its computed flood depth. Rebuilt
  // only when the run, visibility, minute, model, or transform changes —
  // the vertex tint underneath keeps working as a fallback.
  const floodKey = flood?.key ?? '';
  const floodVisible = !!flood?.visible;
  const floodTMin = flood ? Math.round(flood.tMin) : -1;
  useEffect(() => {
    const S = sceneRef.current;
    if (S?.water) {
      S.scene.remove(S.water);
      S.water.geometry.dispose();
      (S.water.material as THREE.Material).dispose();
      S.water = null;
    }
    if (S?.pin) {
      (S.pin.material as THREE.MeshBasicMaterial).color.set(floodVisible ? '#ef4444' : hazardColor);
    }
    if (!S || !floodVisible || !flood || status !== 'ready') return;
    const mg = metaRef.current?.mesh_grid;
    if (!mg) return;
    const exagg = xf?.vertical_exaggeration ?? meta?.vertical_exaggeration ?? 1;
    const tg = S.terrain.geometry as THREE.BufferGeometry;
    const pos = tg.getAttribute('position') as THREE.BufferAttribute;
    const idxAttr = tg.getIndex();
    if (!idxAttr || pos.count !== mg.rows * mg.cols) return;
    const { rows: meshRows, cols: meshCols } = mg;
    const { rows: simRows, cols: simCols, arrival, tMin } = flood;
    const D = depthAtTime(flood);
    const n = pos.count;
    const wet = new Uint8Array(n);
    const wpos = new Float32Array(pos.array); // copy terrain positions
    const wcol = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      let i = -1;
      if (flood.geo) {
        i = geoCellForVertex(pos.getX(v), pos.getZ(v), flood.geo, simRows, simCols);
      } else {
        i = simCellForVertex(v, meshRows, meshCols, simRows, simCols);
      }
      const d = i >= 0 ? D[i] : 0;
      const a = i >= 0 ? arrival[i] : -1;
      const isWet = a >= 0 && a <= tMin && d > 0.05;
      if (isWet) {
        wet[v] = 1;
        wpos[v * 3 + 1] += d * exagg + 1.0; // ride above the terrain skin
        const c = waterColor(d);
        wcol[v * 3] = c[0]; wcol[v * 3 + 1] = c[1]; wcol[v * 3 + 2] = c[2];
      } else {
        wcol[v * 3] = wcol[v * 3 + 1] = wcol[v * 3 + 2] = 1;
      }
    }
    // Keep only fully-wet faces for a clean shoreline.
    const srcIdx = idxAttr.array as ArrayLike<number>;
    const keep: number[] = [];
    for (let f = 0; f < srcIdx.length; f += 3) {
      if (wet[srcIdx[f]] && wet[srcIdx[f + 1]] && wet[srcIdx[f + 2]]) {
        keep.push(srcIdx[f], srcIdx[f + 1], srcIdx[f + 2]);
      }
    }
    if (!keep.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(wcol, 3));
    g.setIndex(keep);
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, opacity: 0.78,
      roughness: 0.12, metalness: 0.05, depthWrite: false,
      side: THREE.DoubleSide, emissive: new THREE.Color('#0a2a4a'), emissiveIntensity: 0.3,
    });
    const water = new THREE.Mesh(g, m);
    water.renderOrder = 5;
    water.frustumCulled = false;
    S.scene.add(water);
    S.water = water;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floodKey, floodVisible, floodTMin, meta, xf, status, hazardColor]);

  // ── Valley flow-path line ────────────────────────────────────
  // Drapes the backend-traced steepest-descent path (dam → valley) over the
  // terrain so the expected flood route reads before/during the run.
  const flowKey = flood?.flowPath ? `${flood.key}:flow` : '';
  useEffect(() => {
    const S = sceneRef.current;
    if (S?.flow) {
      S.scene.remove(S.flow);
      S.flow.geometry.dispose();
      (S.flow.material as THREE.Material).dispose();
      S.flow = null;
    }
    const path = flood?.flowPath;
    if (!S || !flood?.visible || !path?.length || status !== 'ready') return;
    const cosLat = Math.max(Math.cos((dam.lat * Math.PI) / 180), 1e-6);
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const box = new THREE.Box3().setFromObject(S.terrain);
    const topY = box.max.y + 2000;
    const segs: number[] = [];
    let prev: THREE.Vector3 | null = null;
    for (const [lon, lat] of path) {
      const x = (lon - dam.lon) * 111320 * cosLat;
      const z = (dam.lat - lat) * 110540;
      ray.set(new THREE.Vector3(x, topY, z), down);
      const hits = ray.intersectObject(S.terrain, false);
      if (!hits.length) {
        prev = null;
        continue;
      }
      const p = hits[0].point.clone();
      p.y += 12; // ride just above the skin
      if (prev) segs.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
      prev = p;
    }
    if (!segs.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3));
    const line = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.9, depthTest: false }),
    );
    line.renderOrder = 7;
    line.frustumCulled = false;
    S.scene.add(line);
    S.flow = line;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowKey, floodVisible, status]);

  // ── Hover inspector: absolute elevation + live water depth ──────
  useEffect(() => {
    if (status !== 'ready') return;
    const el = containerRef.current?.querySelector('canvas');
    if (!el) return;
    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    let queued = false;
    const onMove = (e: PointerEvent) => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const S = sceneRef.current;
        if (!S) return;
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        ptr.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ptr.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        ray.setFromCamera(ptr, S.camera);
        const hits = ray.intersectObject(S.terrain, false);
        if (!hits.length || hits[0].face == null) {
          if (hoverKeyRef.current !== '') { hoverKeyRef.current = ''; setHover(null); }
          return;
        }
        const mg = metaRef.current?.mesh_grid;
        const v = hits[0].face.a;
        const py = (S.terrain.geometry.getAttribute('position') as THREE.BufferAttribute).getY(v);
        const exagg = xfRef.current?.vertical_exaggeration ?? metaRef.current?.vertical_exaggeration ?? 1;
        const center = xfRef.current?.center_elevation_m ?? null;
        const elevAbs = center == null ? null : center + py / exagg;
        let depthM = 0;
        const F = floodRef.current;
        if (F?.visible && mg) {
          const g = S.terrain.geometry.getAttribute('position') as THREE.BufferAttribute;
          let i = -1;
          if (F.geo) {
            i = geoCellForVertex(g.getX(v), g.getZ(v), F.geo, F.rows, F.cols);
          } else {
            i = simCellForVertex(v, mg.rows, mg.cols, F.rows, F.cols);
          }
          if (i >= 0 && F.arrival[i] >= 0 && F.arrival[i] <= F.tMin) {
            const d = depthAtTime(F)[i];
            if (d > 0.05) depthM = d;
          }
        }
        const key = `${Math.round(elevAbs ?? py)}|${depthM.toFixed(1)}`;
        if (key !== hoverKeyRef.current) {
          hoverKeyRef.current = key;
          setHover({ elevM: elevAbs == null ? null : Math.round(elevAbs), depthM: Math.round(depthM * 10) / 10 });
        }
      });
    };
    el.addEventListener('pointermove', onMove);
    const onLeave = () => { hoverKeyRef.current = ''; setHover(null); };
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, slug]);

  // ── OSM surroundings: fetch once the terrain is ready ────────────
  useEffect(() => {
    if (status !== 'ready') return;
    let dead = false;
    const ctrl = new AbortController();
    setCtxStatus('loading');
    fetchOSMContext(dam.lon, dam.lat, ctrl.signal).then((c) => {
      if (dead) return;
      if (!c || (!c.buildings.length && !c.trees.length && !c.roads.length)) {
        setCtx(null);
        setCtxStatus('empty');
        return;
      }
      setCtx(c);
      setCtxStatus('ready');
    }).catch(() => {
      if (!dead) {
        setCtx(null);
        setCtxStatus('error');
      }
    });
    return () => {
      dead = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, slug]);

  // ── OSM surroundings: build extruded buildings + trees + draped roads ──
  // Rebuilt only when the context payload changes (per dam); flood scrubbing
  // only re-tints via updateContextFlood.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ctx || status !== 'ready') return;

    // Clear a previous context group (slug switch without full unmount).
    if (ctxRef.current) {
      S.scene.remove(ctxRef.current.group);
      ctxRef.current.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      ctxRef.current.dryMat.dispose();
      ctxRef.current.floodMat.dispose();
      ctxRef.current = null;
    }

    const group = new THREE.Group();
    const bld = new THREE.Group();
    const tree = new THREE.Group();
    const road = new THREE.Group();
    group.add(bld, tree, road);

    const dryMat = new THREE.MeshStandardMaterial({ color: '#c7cfd6', roughness: 0.9, metalness: 0.05 });
    const floodMat = new THREE.MeshStandardMaterial({
      color: '#7f1d1d', emissive: new THREE.Color('#ef4444'), emissiveIntensity: 0.55, roughness: 0.7,
    });

    // Buildings: footprint → extruded block, draped on the terrain grid.
    const bldMeshes: Array<{ mesh: THREE.Mesh; cx: number; cz: number }> = [];
    for (const b of ctx.buildings) {
      const g = groundAt(b.cx, b.cz);
      if (g == null) continue;
      const shape = new THREE.Shape();
      b.ring.forEach(([x, z], i) => {
        if (i === 0) shape.moveTo(x, -z);
        else shape.lineTo(x, -z);
      });
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(2, b.heightM), bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); // footprint (x, -z) + depth → (x, +y, z)
      const mesh = new THREE.Mesh(geo, dryMat);
      mesh.position.y = g - 0.5; // sink the foundation slightly
      bld.add(mesh);
      bldMeshes.push({ mesh, cx: b.cx, cz: b.cz });
    }

    // Trees: two instanced draws (trunks + canopies) for the whole forest.
    let treeCount = 0;
    const treeBase: Array<{ x: number; z: number; g: number; s: number }> = [];
    for (const [x, z] of ctx.trees) {
      const g = groundAt(x, z);
      if (g == null) continue;
      treeBase.push({ x, z, g, s: 0.7 + (Math.abs(x * 13.7 + z * 7.3) % 10) / 10 });
    }
    if (treeBase.length) {
      const trunkG = new THREE.CylinderGeometry(0.7, 1.0, 5, 5);
      const canG = new THREE.ConeGeometry(3.6, 9.5, 6);
      const trunkM = new THREE.MeshLambertMaterial({ color: '#5b4232' });
      const canM = new THREE.MeshLambertMaterial({ color: '#2f6b3a' });
      const trunks = new THREE.InstancedMesh(trunkG, trunkM, treeBase.length);
      const cans = new THREE.InstancedMesh(canG, canM, treeBase.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      treeBase.forEach((t) => {
        pos.set(t.x, t.g + 2.5 * t.s, t.z);
        scl.setScalar(t.s);
        m.compose(pos, q, scl);
        trunks.setMatrixAt(treeCount, m);
        pos.set(t.x, t.g + 9.75 * t.s, t.z);
        m.compose(pos, q, scl);
        cans.setMatrixAt(treeCount, m);
        treeCount++;
      });
      trunks.instanceMatrix.needsUpdate = true;
      cans.instanceMatrix.needsUpdate = true;
      tree.add(trunks, cans);
    }

    // Roads: one LineSegments, draped +8 m; colors refresh with the flood.
    const roadSegs: Array<{ ax: number; az: number; bx: number; bz: number; kind: string }> = [];
    for (const r of ctx.roads) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const [ax, az] = r.pts[i];
        const [bx, bz] = r.pts[i + 1];
        if (groundAt(ax, az) == null || groundAt(bx, bz) == null) continue;
        roadSegs.push({ ax, az, bx, bz, kind: r.kind });
      }
    }
    let roadColorAttr: THREE.BufferAttribute | null = null;
    let roadsKm = 0;
    if (roadSegs.length) {
      const positions = new Float32Array(roadSegs.length * 6);
      const colors = new Float32Array(roadSegs.length * 6);
      roadSegs.forEach((sg, k) => {
        const ga = groundAt(sg.ax, sg.az)!;
        const gb = groundAt(sg.bx, sg.bz)!;
        positions.set([sg.ax, ga + 8, sg.az, sg.bx, gb + 8, sg.bz], k * 6);
        const c = roadDryColor(sg.kind);
        colors.set([...c, ...c], k * 6);
        roadsKm += Math.hypot(sg.bx - sg.ax, sg.bz - sg.az) / 1000;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      roadColorAttr = new THREE.BufferAttribute(colors, 3);
      g.setAttribute('color', roadColorAttr);
      road.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true })));
    }

    bld.visible = showBldRef.current;
    tree.visible = showTreesRef.current;
    road.visible = showRoadsRef.current;
    S.scene.add(group);
    ctxRef.current = { group, bld, tree, road, bldMeshes, roadSegs, roadColorAttr, dryMat, floodMat };
    setStructStats({ bTotal: bldMeshes.length, bFlood: 0, trees: treeCount, roadsKm: Math.round(roadsKm * 10) / 10 });
    updateContextFlood();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, status]);

  // Layer visibility toggles.
  useEffect(() => {
    const C = ctxRef.current;
    if (!C) return;
    C.bld.visible = showBld;
    C.tree.visible = showTrees;
    C.road.visible = showRoads;
  }, [showBld, showTrees, showRoads]);

  // Flood scrub → re-tint structures + roads ( minute granularity is enough).
  const floodCtxTMin = flood ? Math.round(flood.tMin) : -1;
  useEffect(() => {
    updateContextFlood();
  }, [flood?.key, flood?.visible, floodCtxTMin, updateContextFlood]);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    // Fresh dam → drop cached grid + surroundings (fetch effect re-fires on ready).
    gridRef.current = null;
    ctxRef.current = null;
    setCtx(null);
    setCtxStatus('idle');
    setStructStats({ bTotal: 0, bFlood: 0, trees: 0, roadsKm: 0 });
    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let raf = 0;

    // ── Renderer / scene / camera ──────────────────────────────────
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1526');
    scene.fog = new THREE.Fog('#0b1526', 30000, 90000);

    const camera = new THREE.PerspectiveCamera(
      55, container.clientWidth / container.clientHeight, 1, 500000,
    );

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // Explicit navigation: left-drag orbits, middle-drag (wheel press)
    // dollies/zooms, right-drag pans — the default dam-inspection feel.
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.autoRotateSpeed = 0.7; // gentle cinematic drift when autoOrbit is on
    controlsRef.current = controls;
    controls.maxPolarAngle = Math.PI * 0.495; // stay above the terrain plane
    controls.minDistance = 200;
    controls.maxDistance = 60000;

    // ── Lights (GLB uses PBR materials — needs real lights) ────────
    scene.add(new THREE.HemisphereLight(0xdfeaff, 0x3a2f22, 1.05));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(8000, 12000, 4000);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd2ff, 0.5);
    fill.position.set(-6000, 4000, -8000);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0x88bbff, 0.4); // cool cinematic rim
    rim.position.set(-9000, 5000, 9000);
    scene.add(rim);
    renderer.toneMappingExposure = 1.22;

    // ── Load model meta (elev range, site center, sources) ─────────
    fetch(`/terrain/${slug}.metadata.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (!disposed && m) setMeta(m); })
      .catch(() => {});
    // Placement transform: absolute center elevation + vertical exaggeration
    // (powers the hover height readout and water-surface scaling).
    fetch(`/terrain/${slug}.transform.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => { if (!disposed && t) setXf(t); })
      .catch(() => {});

    // Paint sim-grid flood state onto mesh vertices (nearest resample).
    // GLB vertices are row-major over meshRows×meshCols — same layout the
    // pipeline used, so vertex v ↔ (v / meshCols, v % meshCols).
    applyRef.current = () => {
      const P = paintRef.current;
      const F = floodRef.current;
      const mg = metaRef.current?.mesh_grid;
      if (!P || !mg || !P.colorAttr) return;
      const { colorAttr, count } = P;
      const { rows: meshRows, cols: meshCols } = mg;
      const arr = colorAttr.array as Float32Array;
      if (!F || !F.visible) {
        arr.fill(1);
      } else {
        const D = depthAtTime(F);
        const posAttr = P.mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        for (let v = 0; v < count; v++) {
          let i = -1;
          if (F.geo && posAttr) {
            i = geoCellForVertex(posAttr.getX(v), posAttr.getZ(v), F.geo, F.rows, F.cols);
          } else {
            const mr = Math.floor(v / meshCols);
            const mc = v % meshCols;
            const sr = Math.min(F.rows - 1, Math.round((mr * (F.rows - 1)) / Math.max(meshRows - 1, 1)));
            const sc = Math.min(F.cols - 1, Math.round((mc * (F.cols - 1)) / Math.max(meshCols - 1, 1)));
            i = sr * F.cols + sc;
          }
          const a = i >= 0 ? F.arrival[i] : -1;
          const wet = i >= 0 && a >= 0 && a <= F.tMin && D[i] > 0.05;
          const tint = wet ? depthTint(D[i]) : [1, 1, 1];
          arr[v * 3] = tint[0];
          arr[v * 3 + 1] = tint[1];
          arr[v * 3 + 2] = tint[2];
        }
      }
      colorAttr.needsUpdate = true;
    };

    // ── Load terrain GLB ───────────────────────────────────────────
    new GLTFLoader().load(
      `/terrain/${slug}.glb`,
      (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        scene.add(model);

        // ── Flood paint target: the terrain mesh ─────────────────
        // One white 'color' attribute (texture unchanged); flood tints
        // multiply over it per timeline scrub.
        const found: THREE.Object3D[] = [];
        model.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) found.push(o);
        });
        const terrain = (found[0] as THREE.Mesh | undefined) ?? null;
        if (terrain) {
          const geo = terrain.geometry as THREE.BufferGeometry;
          const count = geo.getAttribute('position').count;
          const attr = new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3);
          geo.setAttribute('color', attr);
          const mat = terrain.material as THREE.MeshStandardMaterial;
          mat.vertexColors = true;
          mat.needsUpdate = true;
          paintRef.current = { mesh: terrain, colorAttr: attr, count };
          applyRef.current?.();
        }

        const bbox = new THREE.Box3().setFromObject(model);
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.z);

        controls.target.copy(center);
        const dist = maxDim * 1.05;
        camera.position.set(center.x + dist * 0.75, center.y + dist * 0.62, center.z + dist * 0.75);
        camera.near = Math.max(1, dist / 1000);
        camera.far = dist * 20;
        camera.updateProjectionMatrix();
        controls.update();

        // ── Dam pin ────────────────────────────────────────────────
        // GLB local frame is centered on the dam site (x=east, y=up,
        // z=south), so the dam pin sits at local origin, draped on the
        // terrain via a downward raycast.
        const ray = new THREE.Raycaster();
        ray.set(new THREE.Vector3(0, center.y + size.y, 0), new THREE.Vector3(0, -1, 0));
        const hits = ray.intersectObject(model, true);
        const groundY = hits.length ? hits[0].point.y : center.y + size.y / 2;

        const pinColor = new THREE.Color(hazardColor);
        const pin = new THREE.Mesh(
          new THREE.SphereGeometry(maxDim * 0.012, 24, 16),
          new THREE.MeshBasicMaterial({ color: pinColor, depthTest: false, transparent: true }),
        );
        pin.position.set(0, groundY + maxDim * 0.02, 0);
        pin.renderOrder = 998;
        scene.add(pin);

        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(maxDim * 0.002, maxDim * 0.002, maxDim * 0.35, 8),
          new THREE.MeshBasicMaterial({ color: pinColor, transparent: true, opacity: 0.65, depthTest: false }),
        );
        beam.position.set(0, groundY + maxDim * 0.19, 0);
        beam.renderOrder = 997;
        scene.add(beam);

        const label = makeLabelSprite(`🛡️ ${dam.name}`);
        label.position.set(0, groundY + maxDim * 0.42, 0);
        scene.add(label);

        // Share handles with the water/HUD effects (built once per model).
        if (terrain) {
          sceneRef.current = { scene, camera, terrain, pin, beam, water: sceneRef.current?.water ?? null, flow: sceneRef.current?.flow ?? null };
          pin.userData.baseScale = 1;
        }

        setStatus('ready');
      },
      undefined,
      (err) => {
        if (disposed) return;
        console.error('Local3D GLB load failed:', err);
        setError('Could not load the local 3D model.');
        setStatus('error');
      },
    );

    const onResize = () => {
      if (!renderer || disposed) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    // Perf: single canvas only (the globe unmounts with the map view),
    // and pause rendering entirely when the tab is hidden.
    const clockStart = performance.now();
    const loop = () => {
      if (disposed) return;
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      const t = (performance.now() - clockStart) / 1000;
      const S = sceneRef.current;
      // Water shimmer: gentle opacity breathing + millimetre-scale swell.
      if (S?.water) {
        const m = S.water.material as THREE.MeshStandardMaterial;
        const base = Math.min(1, Math.max(0.05, floodRef.current?.opacity ?? 0.78));
        m.opacity = base + 0.06 * Math.sin(t * 2.0);
        S.water.position.y = Math.sin(t * 1.4) * 1.2;
      }
      // Dam pin heartbeat.
      if (S?.pin) {
        const s = 1 + 0.16 * Math.sin(t * 3.2);
        S.pin.scale.setScalar(s);
        const bm = S.beam.material as THREE.MeshBasicMaterial;
        bm.opacity = 0.45 + 0.2 * Math.sin(t * 3.2);
      }
      controls.update();
      renderer!.render(scene, camera);
    };
    loop();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      controlsRef.current = null;
      sceneRef.current = null;
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = (mesh as any).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      renderer?.dispose();
      container.innerHTML = '';
    };
  }, [slug, dam.name, hazardColor]);

  return (
    <div className="relative w-full h-full bg-[#0b1526]">
      <div ref={containerRef} className="w-full h-full cursor-crosshair" />

      {/* Header overlay */}
      <div className="absolute top-3 left-3 z-20 flex items-center gap-2 flex-wrap max-w-[60%]">
        <div className="px-3 py-1.5 bg-[#0A1218]/85 border border-cmd-border text-cmd-ink text-[10px] font-bold rounded-full">
          TRUE 3D — {dam.name} + surroundings
        </div>
        {meta && (
          <div className="px-3 py-1.5 bg-[#0A1218]/85 border border-cmd-border text-cmd-muted text-[10px] font-mono rounded-full tabular-nums">
            {meta.elevation_min_m.toFixed(0)}–{meta.elevation_max_m.toFixed(0)} m • ±{meta.bbox_radius_km} km
          </div>
        )}
        {/* OSM surroundings toggles */}
        {ctxStatus === 'loading' && (
          <div className="px-3 py-1.5 bg-[#0A1218]/85 border border-cmd-border text-cmd-muted text-[10px] rounded-full animate-pulse">
            Loading buildings • trees • streets…
          </div>
        )}
        {ctxStatus === 'ready' && (
          <>
            <button
              onClick={() => setShowBld((v) => !v)}
              title="Toggle OSM buildings (extruded, flood-aware)"
              className={`px-3 py-1.5 text-[10px] font-bold rounded-full border transition-colors ${showBld ? 'bg-cmd-teal/90 text-[#071018] border-cmd-teal' : 'bg-[#0A1218]/85 text-cmd-muted border-cmd-border hover:text-cmd-ink'}`}
            >
              🏠 {structStats.bTotal}
            </button>
            <button
              onClick={() => setShowTrees((v) => !v)}
              title="Toggle OSM trees"
              className={`px-3 py-1.5 text-[10px] font-bold rounded-full border transition-colors ${showTrees ? 'bg-cmd-teal/90 text-[#071018] border-cmd-teal' : 'bg-[#0A1218]/85 text-cmd-muted border-cmd-border hover:text-cmd-ink'}`}
            >
              🌳 {structStats.trees}
            </button>
            <button
              onClick={() => setShowRoads((v) => !v)}
              title="Toggle OSM streets (draped, flood-aware)"
              className={`px-3 py-1.5 text-[10px] font-bold rounded-full border transition-colors ${showRoads ? 'bg-cmd-teal/90 text-[#071018] border-cmd-teal' : 'bg-[#0A1218]/85 text-cmd-muted border-cmd-border hover:text-cmd-ink'}`}
            >
              🛣 {structStats.roadsKm} km
            </button>
          </>
        )}
        {ctxStatus === 'empty' && (
          <div className="px-3 py-1.5 bg-[#0A1218]/85 border border-cmd-border text-cmd-muted text-[10px] rounded-full">
            No mapped structures nearby
          </div>
        )}
        {ctxStatus === 'error' && (
          <div className="px-3 py-1.5 bg-[#0A1218]/85 border border-cmd-amber/50 text-cmd-amber text-[10px] rounded-full">
            Surroundings unavailable (OSM)
          </div>
        )}
        {flood?.visible && structStats.bFlood > 0 && (
          <div className="px-3 py-1.5 bg-[#7f1d1d]/90 border border-cmd-red text-white text-[10px] font-bold rounded-full tabular-nums">
            🏚 {structStats.bFlood} structure{structStats.bFlood === 1 ? '' : 's'} inundated
          </div>
        )}
      </div>
      <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
        <button
          onClick={onShowMap}
          className="px-3 py-1.5 bg-[#0A1218]/85 border border-cmd-border text-cmd-muted hover:text-cmd-ink text-[11px] font-semibold rounded-full transition-colors"
          title="Back to the satellite globe map"
        >
          Globe map
        </button>
        <button
          onClick={onClose}
          className="w-7 h-7 bg-[#0A1218]/85 border border-cmd-border text-cmd-muted text-sm font-bold rounded-full hover:text-cmd-ink transition-colors"
          title="Close 3D view"
        >
          ✕
        </button>
      </div>

      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#0b1526]/60">
          <div className="w-8 h-8 border-4 border-cmd-teal border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-cmd-muted">Building local 3D terrain…</p>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
          <p className="text-sm text-cmd-red">{error}</p>
          <button onClick={onShowMap} className="px-3 py-1.5 bg-cmd-panel2 border border-cmd-border text-cmd-ink text-xs font-semibold rounded-lg">
            Back to map
          </button>
        </div>
      )}

      {/* Cinematic vignette (pure CSS, pointer-transparent) */}
      <div
        className="absolute inset-0 z-10 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(4,10,24,0.42) 100%)' }}
      />

      {/* Hover inspector: absolute elevation + live water depth */}
      {hover && status === 'ready' && (
        <div className="absolute bottom-12 right-3 z-20 flex items-center gap-2 px-3 py-1.5 bg-[#0A1218]/90 text-cmd-ink text-[11px] font-mono rounded-full border border-cmd-border tabular-nums">
          <span>{hover.elevM != null ? `${hover.elevM.toLocaleString()} m` : '—'}</span>
          {flood?.visible ? (
            <span className={`font-bold ${hover.depthM > 0.05 ? 'text-cmd-teal' : 'text-cmd-muted'}`}>
              {hover.depthM > 0.05 ? `${hover.depthM} m` : 'dry'}
            </span>
          ) : (
            <span className="text-cmd-muted">hover terrain</span>
          )}
        </div>
      )}
      {flood?.visible && (
        <div className="absolute bottom-12 left-3 z-20 flex items-center gap-2 px-3 py-1.5 bg-[#0A1218]/85 text-cmd-muted text-[10px] rounded-full border border-cmd-border">
          <span className="font-semibold text-cmd-ink">Depth:</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#73bfff' }} />&lt;0.3m</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#59f2ff' }} />0.3–1m</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#ff9e40' }} />1–2.5m</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#ff4747' }} />&gt;2.5m</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#7f1d1d', border: '1px solid #ef4444' }} />🏠 inundated</span>
        </div>
      )}

      {/* Controls hint + data source */}
      <div className="absolute bottom-3 left-3 z-20 px-3 py-1.5 bg-[#0A1218]/85 text-cmd-muted text-[10px] rounded-full border border-cmd-border">
        Left-drag orbit • Middle-drag / scroll zoom • Right-drag pan
      </div>
      {meta && (
        <div className="absolute bottom-3 right-3 z-20 px-3 py-1.5 bg-[#0A1218]/85 text-cmd-muted text-[10px] font-mono rounded-full border border-cmd-border">
          DEM: {meta.sources.dem} • Imagery: {meta.sources.texture}
        </div>
      )}
    </div>
  );
}

