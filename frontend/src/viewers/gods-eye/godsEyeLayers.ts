/**
 * God's Eye View — live situational layers (keyless-first).
 *
 * Ported layer pattern from bilawalsidhu/gods-eye-view into DamSafe Twin:
 * every layer is a separate module with its own fetcher, refresh budget,
 * and graceful degradation. All layers below work with NO api keys:
 *
 *   - Earthquakes: USGS all-day feed (GeoJSON, CORS-open)
 *   - Flights:     OpenSky anonymous states API (throttled, bbox-limited)
 *
 * Metered/keyed layers (AISStream vessels, NASA FIRMS fires, TomTom
 * traffic) are represented as disabled stubs — wire a server-side proxy
 * before enabling them (never expose private keys in the browser).
 */

export interface QuakePoint {
  id: string;
  lon: number;
  lat: number;
  mag: number;
  place: string;
  timeMs: number;
  depthKm: number;
}

export interface FlightPoint {
  icao24: string;
  callsign: string;
  lon: number;
  lat: number;
  altitudeM: number | null;
  velocityMs: number | null;
  headingDeg: number | null;
  onGround: boolean;
}

/** OpenSky anonymous: max ~1 request / 30 s per bbox or you get 429s. */
export const OPENSKY_MIN_INTERVAL_MS = 30_000;
/** USGS is cheap; 5 min refresh is plenty. */
export const USGS_REFRESH_MS = 5 * 60_000;
/** Cap rendered contacts so the globe stays fast. */
export const MAX_FLIGHTS = 120;
export const MAX_QUAKES = 150;

interface BBox {
  lamin: number;
  lomin: number;
  lamax: number;
  lomax: number;
}

/** ±degrees box around a dam for the OpenSky `states/all` bbox query. */
export function bboxAround(lon: number, lat: number, halfDeg = 4): BBox {
  return {
    lamin: Math.max(-90, lat - halfDeg),
    lomin: Math.max(-180, lon - halfDeg),
    lamax: Math.min(90, lat + halfDeg),
    lomax: Math.min(180, lon + halfDeg),
  };
}

export async function fetchQuakes(signal?: AbortSignal): Promise<QuakePoint[]> {
  const res = await fetch(
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    { signal },
  );
  if (!res.ok) throw new Error(`USGS ${res.status}`);
  const gj = await res.json();
  const feats: any[] = Array.isArray(gj?.features) ? gj.features : [];
  return feats
    .map((f) => {
      const c = f?.geometry?.coordinates;
      if (!Array.isArray(c) || c.length < 2) return null;
      return {
        id: String(f.id ?? `${c[0]},${c[1]}`),
        lon: Number(c[0]),
        lat: Number(c[1]),
        mag: Number(f?.properties?.mag ?? 0),
        place: String(f?.properties?.place ?? 'unknown'),
        timeMs: Number(f?.properties?.time ?? 0),
        depthKm: Number(c[2] ?? 0),
      } as QuakePoint;
    })
    .filter(Boolean)
    .sort((a, b) => (b as QuakePoint).mag - (a as QuakePoint).mag)
    .slice(0, MAX_QUAKES) as QuakePoint[];
}

export async function fetchFlights(bbox: BBox, signal?: AbortSignal): Promise<FlightPoint[]> {
  const q = new URLSearchParams({
    lamin: String(bbox.lamin),
    lomin: String(bbox.lomin),
    lamax: String(bbox.lamax),
    lomax: String(bbox.lomax),
  });
  const res = await fetch(`https://opensky-network.org/api/states/all?${q}`, { signal });
  if (res.status === 429) throw new Error('OpenSky rate limit (429) — backing off');
  if (!res.ok) throw new Error(`OpenSky ${res.status}`);
  const json = await res.json();
  const states: any[][] = Array.isArray(json?.states) ? json.states : [];
  return states
    .map((s) => ({
      icao24: String(s[0] ?? ''),
      callsign: String(s[1] ?? '').trim() || 'UNKNOWN',
      lon: Number(s[5]),
      lat: Number(s[6]),
      altitudeM: s[7] == null ? null : Number(s[7]),
      velocityMs: s[9] == null ? null : Number(s[9]),
      headingDeg: s[10] == null ? null : Number(s[10]),
      onGround: Boolean(s[8]),
    }))
    .filter((f) => Number.isFinite(f.lon) && Number.isFinite(f.lat) && !f.onGround)
    .sort((a, b) => (b.altitudeM ?? 0) - (a.altitudeM ?? 0))
    .slice(0, MAX_FLIGHTS);
}

/** Quake magnitude → pin color (matches the GEV legend language). */
export function quakeColor(mag: number): string {
  if (mag >= 6) return '#ef4444';
  if (mag >= 5) return '#f97316';
  if (mag >= 4) return '#eab308';
  return '#22c55e';
}
