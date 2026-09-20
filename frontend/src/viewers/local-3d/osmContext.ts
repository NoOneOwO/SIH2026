/**
 * OSM context for the exact-terrain dam view (Local3DView).
 *
 * Fetches real surroundings around the dam from OpenStreetMap via the
 * Overpass API (no key, CORS-open) and converts everything into the GLB
 * local frame: x = metres east of the dam anchor, z = metres south.
 *
 *   - buildings: footprint rings + height (OSM height tag → levels*3.2 → 5 m default)
 *   - trees:     natural=tree nodes
 *   - roads:     highway ways (arterial → service), decimated
 *
 * Counts are capped and sorted nearest-dam-first so a rural dam site stays
 * fast. A failed fetch resolves to null — the terrain + flood still render.
 */

export interface OSMBuilding {
  /** Local-metre footprint ring [x, z][] (closed or open — we close it). */
  ring: Array<[number, number]>;
  heightM: number;
  /** Centroid (local metres) — used for ground drape + flood sampling. */
  cx: number;
  cz: number;
}

export interface OSMRoad {
  pts: Array<[number, number]>;
  kind: string;
}

export interface OSMContext {
  buildings: OSMBuilding[];
  trees: Array<[number, number]>;
  roads: OSMRoad[];
  truncated: boolean;
}

export const OSM_MAX_BUILDINGS = 600;
/** Public Overpass mirrors, tried in order (main instance throttles under load). */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];
export const OSM_MAX_TREES = 2500;
export const OSM_MAX_ROAD_PTS = 9000;
/** Half-size of the context box (degrees ≈ ±5.5 km). */
export const OSM_HALF_DEG = 0.05;

const ROAD_KINDS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|track';

/** POST the query to each mirror in turn; returns the first valid JSON payload. */
async function fetchOverpassJson(ql: string, signal?: AbortSignal): Promise<any> {
  let lastErr: unknown = new Error('Overpass unreachable');
  for (const url of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(ql),
        signal,
      });
      if (!res.ok) {
        lastErr = new Error(`Overpass ${res.status}`);
        continue;
      }
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        // Overload answers 200 with an HTML error page — reject it too.
        if (json != null && typeof json === 'object' && Array.isArray(json.elements)) return json;
        lastErr = new Error('Overpass busy (non-JSON answer)');
      } catch {
        lastErr = new Error('Overpass busy (non-JSON answer)');
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

function parseHeight(tags: Record<string, string | undefined>): number {
  const raw = tags.height?.replace(/[^0-9.]/g, '');
  const h = raw ? Number(raw) : NaN;
  if (Number.isFinite(h) && h > 1 && h < 300) return h;
  const levels = tags['building:levels'] ? Number(tags['building:levels']) : NaN;
  if (Number.isFinite(levels) && levels > 0 && levels < 60) return levels * 3.2;
  return 5;
}

export async function fetchOSMContext(
  damLon: number,
  damLat: number,
  signal?: AbortSignal,
): Promise<OSMContext | null> {
  const s = damLat - OSM_HALF_DEG;
  const w = damLon - OSM_HALF_DEG;
  const n = damLat + OSM_HALF_DEG;
  const e = damLon + OSM_HALF_DEG;
  const ql = `[out:json][timeout:25];(way["building"](${s},${w},${n},${e});node["natural"="tree"](${s},${w},${n},${e});way["highway"~"^(${ROAD_KINDS})$"](${s},${w},${n},${e}););out geom;`;

  const json = await fetchOverpassJson(ql, signal);
  const elements: any[] = json.elements;

  const cosLat = Math.max(Math.cos((damLat * Math.PI) / 180), 1e-6);
  const toX = (lon: number) => (lon - damLon) * 111320 * cosLat;
  const toZ = (lat: number) => (damLat - lat) * 110540;

  const buildings: OSMBuilding[] = [];
  const trees: Array<[number, number]> = [];
  const roads: OSMRoad[] = [];
  let roadPts = 0;

  for (const el of elements) {
    if (el.type === 'node' && el.tags?.natural === 'tree') {
      if (typeof el.lon === 'number' && typeof el.lat === 'number') {
        trees.push([toX(el.lon), toZ(el.lat)]);
      }
    } else if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) {
      if (el.tags?.building) {
        const ring = el.geometry
          .filter((g: any) => typeof g?.lon === 'number' && typeof g?.lat === 'number')
          .map((g: any) => [toX(g.lon), toZ(g.lat)] as [number, number]);
        if (ring.length >= 3) {
          let cx = 0;
          let cz = 0;
          for (const [x, z] of ring) {
            cx += x;
            cz += z;
          }
          buildings.push({ ring, heightM: parseHeight(el.tags ?? {}), cx: cx / ring.length, cz: cz / ring.length });
        }
      } else if (el.tags?.highway) {
        const pts = el.geometry
          .filter((g: any) => typeof g?.lon === 'number' && typeof g?.lat === 'number')
          .map((g: any) => [toX(g.lon), toZ(g.lat)] as [number, number]);
        if (pts.length >= 2 && roadPts < OSM_MAX_ROAD_PTS) {
          // Decimate long ways so the drape stays cheap.
          const keep: Array<[number, number]> = [];
          const step = Math.max(1, Math.floor(pts.length / 200));
          for (let i = 0; i < pts.length; i += step) keep.push(pts[i]);
          if (keep[keep.length - 1] !== pts[pts.length - 1]) keep.push(pts[pts.length - 1]);
          roads.push({ pts: keep, kind: String(el.tags.highway) });
          roadPts += keep.length;
        }
      }
    }
  }

  // Nearest-dam-first so caps keep the structures that matter for the breach.
  const dist2 = (x: number, z: number) => x * x + z * z;
  buildings.sort((a, b) => dist2(a.cx, a.cz) - dist2(b.cx, b.cz));
  trees.sort((a, b) => dist2(a[0], a[1]) - dist2(b[0], b[1]));

  const truncated = buildings.length > OSM_MAX_BUILDINGS || trees.length > OSM_MAX_TREES;
  return {
    buildings: buildings.slice(0, OSM_MAX_BUILDINGS),
    trees: trees.slice(0, OSM_MAX_TREES),
    roads,
    truncated,
  };
}
