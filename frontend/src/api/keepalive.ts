/**
 * Temporary Render keepalive (demo period only — delete after).
 *
 * The Render free tier sleeps after inactivity, so the first visitor would
 * otherwise stare at failing API calls during a ~50s cold start. This module:
 *   1. pings the backend the moment the site opens (long timeout + retries),
 *   2. re-pings every KEEPALIVE_INTERVAL_MS while the tab is visible,
 *   3. publishes backend state for the TopBar status pill.
 *
 * Set KEEPALIVE_ENABLED = false (or delete this module + its TopBar hook)
 * once the backend moves to a non-sleeping host.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export const KEEPALIVE_ENABLED = true;
const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000; // re-ping every 10 min while visible
const WAKE_TIMEOUT_MS = 100_000; // Render cold starts need up to ~60s+
const PING_TIMEOUT_MS = 60_000;
const MAX_WAKE_ATTEMPTS = 4;

export type BackendState = 'unknown' | 'waking' | 'online' | 'offline';

let state: BackendState = 'unknown';
const listeners = new Set<(s: BackendState) => void>();
let started = false;

function setState(s: BackendState) {
  if (state === s) return;
  state = s;
  listeners.forEach((fn) => fn(s));
}

export function subscribeBackendState(fn: (s: BackendState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => {
    listeners.delete(fn);
  };
}

async function pingOnce(timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // /health is unauthenticated; vite dev proxies it to localhost:8000.
    const res = await fetch(`${BASE_URL}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget wake sequence with backoff. Resolves when online (or gives up). */
export async function wakeBackend(): Promise<boolean> {
  if (!KEEPALIVE_ENABLED) return true;
  setState('waking');
  for (let attempt = 1; attempt <= MAX_WAKE_ATTEMPTS; attempt++) {
    const ok = await pingOnce(attempt === 1 ? WAKE_TIMEOUT_MS : PING_TIMEOUT_MS);
    if (ok) {
      setState('online');
      return true;
    }
    // Brief backoff between attempts (cold start may still be booting).
    await new Promise((r) => setTimeout(r, 8000));
  }
  setState('offline');
  return false;
}

/** Start wake-once + visible-tab heartbeat. Idempotent — call from main.tsx. */
export function startKeepalive(): void {
  if (!KEEPALIVE_ENABLED || started) return;
  started = true;
  wakeBackend();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    pingOnce(PING_TIMEOUT_MS).then((ok) => setState(ok ? 'online' : 'offline'));
  }, KEEPALIVE_INTERVAL_MS);
}
