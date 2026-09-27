/**
 * Shared, normalized API base URL — every API module imports this.
 *
 * VITE_API_BASE_URL must be scheme + host ONLY (e.g. https://damsafe-api.onrender.com);
 * the code appends /api/v1 to every path itself. Common misconfigurations used to
 * surface as mysterious "Failed to fetch" errors and a red "Backend offline" pill
 * in production, so they are repaired here instead:
 *   - stray whitespace / wrapping quotes   → trimmed
 *   - trailing slash                       → stripped
 *   - accidental /api/v1 suffix            → stripped (double-prefix 404s)
 */
function normalize(raw: string | undefined): string {
  let v = (raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!v) return '';
  v = v.replace(/\/+$/, '');
  v = v.replace(/\/api\/v1$/, '');
  return v;
}

export const BASE_URL = normalize(import.meta.env.VITE_API_BASE_URL);
