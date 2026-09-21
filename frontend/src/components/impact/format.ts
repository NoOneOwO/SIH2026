/**
 * AquaShield 3D — impact display helpers.
 *
 * One place for currency, count and range formatting plus the risk tone maps,
 * so a rupee figure or a risk colour can never be rendered two different ways
 * on two different screens.
 */

import type { ConfidenceLevel, RiskBand, SettlementStatus } from '../../types/impact';

/**
 * Indian short-scale currency: ₹1.2 Cr (crore = 10^7), ₹4.5 L (lakh = 10^5).
 * Money in the estimate payload is INR integers.
 */
export function formatInr(valueInr: number | null | undefined): string {
  if (valueInr == null || !Number.isFinite(valueInr)) return '—';
  const v = Math.abs(valueInr);
  if (v >= 1e12) return `₹${(valueInr / 1e12).toFixed(2)} lakh Cr`;
  if (v >= 1e7) return `₹${(valueInr / 1e7).toFixed(v >= 1e9 ? 0 : 1)} Cr`;
  if (v >= 1e5) return `₹${(valueInr / 1e5).toFixed(1)} L`;
  if (v >= 1e3) return `₹${(valueInr / 1e3).toFixed(0)}K`;
  return `₹${Math.round(valueInr)}`;
}

/** Compact human count: 12,400 → 12.4K. Never used for money. */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const v = Math.abs(value);
  if (v >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`;
  if (v >= 1e6) return `${(value / 1e6).toFixed(2)} M`;
  if (v >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toLocaleString('en-IN');
}

export function formatInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-IN');
}

/** "12,400–18,000" (or a single number when low === high). */
export function formatRange(
  range: { low: number; mid?: number; high: number },
  fmt: (v: number) => string = formatInt,
): string {
  if (range.low === range.high) return fmt(range.mid ?? range.low);
  return `${fmt(range.low)}–${fmt(range.high)}`;
}

export function formatDepth(depthM: number): string {
  return `${depthM.toFixed(2)} m`;
}

export function formatLeadTime(minutes: number | null): string {
  if (minutes == null) return 'not resolved';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

// ── Tones (single source of truth for risk colour language) ─────────────────

export const RISK_TEXT: Record<RiskBand, string> = {
  LOW: 'text-cmd-green',
  MODERATE: 'text-cmd-amber',
  HIGH: 'text-cmd-amber',
  EXTREME: 'text-cmd-red',
};

export const RISK_BG: Record<RiskBand, string> = {
  LOW: 'bg-cmd-green/15 border-cmd-green/40',
  MODERATE: 'bg-cmd-amber/15 border-cmd-amber/40',
  HIGH: 'bg-cmd-amber/20 border-cmd-amber/50',
  EXTREME: 'bg-cmd-red/20 border-cmd-red/50',
};

/** Hex used for Cesium point/label colours (globe layer + legend). */
export const RISK_HEX: Record<RiskBand, string> = {
  LOW: '#55C99A',
  MODERATE: '#D8B24C',
  HIGH: '#E8834A',
  EXTREME: '#D96B70',
};

export const STATUS_LABEL: Record<SettlementStatus, string> = {
  INUNDATED: 'Inundated (modelled)',
  'AT RISK': 'At risk — water adjacent',
  SAFE: 'Outside modelled water',
};

export const CONFIDENCE_TONE: Record<ConfidenceLevel, string> = {
  High: 'text-cmd-green border-cmd-green/40 bg-cmd-green/10',
  Medium: 'text-cmd-amber border-cmd-amber/40 bg-cmd-amber/10',
  Low: 'text-cmd-red border-cmd-red/40 bg-cmd-red/10',
};

/** Lowest acceptable confidence for a given risk band (drives UI honesty notes). */
export function needsCaveat(risk: RiskBand, confidence: ConfidenceLevel): boolean {
  return (risk === 'EXTREME' || risk === 'HIGH') && confidence === 'Low';
}
