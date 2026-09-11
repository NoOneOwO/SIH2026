/**
 * AquaShield 3D — Evacuation Planner
 * Village-wise evacuation priority list, road passability, and shelter allocation.
 */

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { Users, MapPin, Car, Home, ExternalLink } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

// Demo reference dam for distance readouts (Machhu/Morbi case-study geography).
const DEMO_DAM = { name: 'Machhu Dam (demo)', lon: 70.85, lat: 22.83 };

const MOCK_PRIORITIES = [
  { village_name: 'Bhalbhal', population: 5000, arrival_time_min: 20, hazard_class: 'red', priority_score: 285.7, depth_m: 3.2, velocity_ms: 4.1, lon: 70.95, lat: 22.75 },
  { village_name: 'Jhinjhuwa', population: 3500, arrival_time_min: 25, hazard_class: 'red', priority_score: 168.0, depth_m: 2.8, velocity_ms: 3.5, lon: 70.88, lat: 22.7 },
  { village_name: 'Makkerha', population: 4200, arrival_time_min: 30, hazard_class: 'orange', priority_score: 152.4, depth_m: 2.1, velocity_ms: 2.8, lon: 71.05, lat: 22.72 },
  { village_name: 'Tankara', population: 15000, arrival_time_min: 35, hazard_class: 'orange', priority_score: 491.4, depth_m: 1.8, velocity_ms: 2.2, lon: 70.754, lat: 22.659 },
  { village_name: 'Muli', population: 12000, arrival_time_min: 40, hazard_class: 'yellow', priority_score: 320.0, depth_m: 1.2, velocity_ms: 1.5, lon: 71.478, lat: 22.635 },
  { village_name: 'Morbi City', population: 210000, arrival_time_min: 45, hazard_class: 'yellow', priority_score: 5250.0, depth_m: 0.8, velocity_ms: 1.0, lon: 70.835, lat: 22.812 },
  { village_name: 'Wankaner', population: 30000, arrival_time_min: 60, hazard_class: 'green', priority_score: 450.0, depth_m: 0.3, velocity_ms: 0.5, lon: 70.933, lat: 22.618 },
  { village_name: 'Halvad', population: 25000, arrival_time_min: 90, hazard_class: 'green', priority_score: 222.2, depth_m: 0.1, velocity_ms: 0.2, lon: 70.793, lat: 23.013 },
];

const MOCK_ROADS = [
  { name: 'NH-27 (Morbi-Rajkot)', status: 'safe', depth_m: 0.0, t: 0 },
  { name: 'SH-6 (Morbi-Tankara)', status: 'restricted', depth_m: 0.4, t: 0 },
  { name: 'Morbi-Wankaner Road', status: 'safe', depth_m: 0.1, t: 0 },
];

const SHELTERS = [
  { name: 'Morbi Stadium', capacity: 5000, distance_km: 2.5 },
  { name: 'Government School Complex', capacity: 2000, distance_km: 3.1 },
  { name: 'Community Hall Tankara', capacity: 1500, distance_km: 8.2 },
];

const HAZARD_TONE: Record<string, string> = {
  red: 'border-cmd-red/50 text-cmd-red',
  orange: 'border-cmd-amber/40 text-cmd-amber',
  yellow: 'border-cmd-amber/40 text-cmd-amber',
  green: 'border-cmd-green/40 text-cmd-green',
};

const HAZARD_BAR: Record<string, string> = {
  red: '#D96B70', orange: '#D8B24C', yellow: '#D8B24C', green: '#55C99A',
};

export default function EvacuationPlanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState<'priority' | 'arrival' | 'population'>('priority');

  /** Jump to the globe: waypoint on the village + distance-from-dam card. */
  const focusOnGlobe = (v: (typeof MOCK_PRIORITIES)[number]) => {
    const q = new URLSearchParams({
      globeCity: v.village_name,
      clon: String(v.lon),
      clat: String(v.lat),
      damlon: String(DEMO_DAM.lon),
      damlat: String(DEMO_DAM.lat),
      depth: `${v.depth_m} m`,
      arr: `T+${v.arrival_time_min} min`,
    });
    navigate(`/incident?${q.toString()}`);
  };
  const chartOrder = [...MOCK_PRIORITIES].sort((a, b) => a.arrival_time_min - b.arrival_time_min);

  const sorted = useMemo(() => {
    const list = [...MOCK_PRIORITIES];
    switch (sortBy) {
      case 'arrival': return list.sort((a, b) => a.arrival_time_min - b.arrival_time_min);
      case 'population': return list.sort((a, b) => b.population - a.population);
      default: return list.sort((a, b) => b.priority_score - a.priority_score);
    }
  }, [sortBy]);

  const totalPopulation = MOCK_PRIORITIES.reduce((sum, v) => sum + v.population, 0);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-bold text-cmd-ink">{t('nav.evacuationPlanner')}</h1>
        <p className="text-cmd-muted mt-1 text-sm">Ranked evacuation priorities, road status, and shelter capacity</p>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Population at Risk', value: totalPopulation.toLocaleString(), tone: 'text-cmd-red' },
          { label: 'Earliest Arrival', value: `T+${MOCK_PRIORITIES[0].arrival_time_min} min`, tone: 'text-cmd-amber' },
          { label: 'Shelter Capacity', value: SHELTERS.reduce((sum, s) => sum + s.capacity, 0).toLocaleString(), tone: 'text-cmd-green' },
        ].map(({ label, value, tone }) => (
          <div key={label} className="cmd-card p-4">
            <div className="text-xs text-cmd-muted">{label}</div>
            <div className={`text-2xl font-bold mt-1 tabular-nums ${tone}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* Depth profile illustration — click a bar to fly the globe there */}
      <div className="cmd-card p-5">
        <h3 className="text-[15px] font-semibold text-cmd-ink mb-1">Modelled depth profile by village</h3>
        <p className="text-xs text-cmd-muted mb-3">Peak water depth (m) — screening values for planning. Click a bar to open it on the globe.</p>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartOrder} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
              <XAxis dataKey="village_name" tick={{ fill: '#91A2AD', fontSize: 10 }} interval={0} angle={-18} dy={8} height={44} tickLine={false} axisLine={{ stroke: '#263742' }} />
              <YAxis tick={{ fill: '#91A2AD', fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ background: '#14222B', border: '1px solid #263742', borderRadius: 8, fontSize: 12, color: '#E8EEF0' }}
                formatter={(v: any) => [`${v} m`, 'Depth']}
              />
              <Bar dataKey="depth_m" radius={[4, 4, 0, 0]} isAnimationActive={false}
                onClick={(_, i) => { const v = chartOrder[i]; if (v) focusOnGlobe(v); }} style={{ cursor: 'pointer' }}>
                {chartOrder.map((v) => (
                  <Cell key={v.village_name} fill={HAZARD_BAR[v.hazard_class]} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Priority List */}
      <div className="cmd-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[15px] font-semibold text-cmd-ink flex items-center gap-2">
            <Users className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
            Evacuation Priority Ranking
          </h3>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="px-3 py-1.5 bg-cmd-panel2 border border-cmd-border rounded-lg text-xs text-cmd-ink focus:outline-none focus:border-cmd-teal/60"
          >
            <option value="priority">Sort by Priority Score</option>
            <option value="arrival">Sort by Arrival Time</option>
            <option value="population">Sort by Population</option>
          </select>
        </div>

        <table className="w-full">
          <thead>
            <tr className="border-b border-cmd-border">
              {['#', 'Village', 'Population', 'Arrival (min)', 'Hazard', 'Depth (m)', 'Velocity (m/s)', 'Priority Score'].map((h, i) => (
                <th key={h} className={`px-3 py-2.5 text-[11px] font-semibold text-cmd-muted uppercase tracking-wider ${i >= 2 ? 'text-right' : i === 4 ? 'text-center' : 'text-left'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((v, i) => (
              <tr key={v.village_name} onClick={() => focusOnGlobe(v)}
                className="border-b border-cmd-border/60 last:border-0 hover:bg-white/[0.03] cursor-pointer" title="Open on the globe">
                <td className="px-3 py-3 text-sm font-bold text-cmd-muted tabular-nums">{i + 1}</td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-cmd-red" strokeWidth={1.75} />
                    <span className="text-sm font-semibold text-cmd-ink">{v.village_name}</span>
                    <ExternalLink className="w-3 h-3 text-cmd-muted" />
                  </div>
                </td>
                <td className="px-3 py-3 text-sm text-right text-cmd-ink/90 tabular-nums">{v.population.toLocaleString()}</td>
                <td className="px-3 py-3 text-sm text-right font-mono">
                  <span className={v.arrival_time_min <= 30 ? 'text-cmd-red font-bold' : v.arrival_time_min <= 60 ? 'text-cmd-amber' : 'text-cmd-muted'}>
                    T+{v.arrival_time_min}
                  </span>
                </td>
                <td className="px-3 py-3 text-center">
                  <span className={`px-2 py-1 rounded-md border text-[11px] font-bold uppercase ${HAZARD_TONE[v.hazard_class]}`}>
                    {v.hazard_class}
                  </span>
                </td>
                <td className="px-3 py-3 text-sm text-right text-cmd-ink/90 tabular-nums">{v.depth_m}</td>
                <td className="px-3 py-3 text-sm text-right text-cmd-ink/90 tabular-nums">{v.velocity_ms}</td>
                <td className={`px-3 py-3 text-sm text-right font-bold tabular-nums ${
                  v.priority_score > 1000 ? 'text-cmd-red' :
                  v.priority_score > 300 ? 'text-cmd-amber' :
                  v.priority_score > 100 ? 'text-cmd-amber/80' : 'text-cmd-green'
                }`}>
                  {v.priority_score.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Road Status + Shelters */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="cmd-card p-5">
          <h3 className="text-[15px] font-semibold text-cmd-ink mb-4 flex items-center gap-2">
            <Car className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
            Road Passability
          </h3>
          <div className="space-y-2.5">
            {MOCK_ROADS.map((r) => (
              <div key={r.name} className="flex items-center justify-between p-3 rounded-lg border border-cmd-border bg-cmd-panel2/60">
                <div className="flex items-center gap-2.5">
                  <div className={`w-2.5 h-2.5 rounded-full ${
                    r.status === 'safe' ? 'bg-cmd-green' :
                    r.status === 'restricted' ? 'bg-cmd-amber' : 'bg-cmd-red'
                  }`} />
                  <span className="text-[13px] font-medium text-cmd-ink">{r.name}</span>
                </div>
                <span className="text-[11px] font-bold uppercase text-cmd-muted">{r.status}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="cmd-card p-5">
          <h3 className="text-[15px] font-semibold text-cmd-ink mb-4 flex items-center gap-2">
            <Home className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
            Shelter Capacity
          </h3>
          <div className="space-y-2.5">
            {SHELTERS.map((s) => (
              <div key={s.name} className="flex items-center justify-between p-3 rounded-lg border border-cmd-border bg-cmd-panel2/60">
                <div>
                  <div className="text-[13px] font-medium text-cmd-ink">{s.name}</div>
                  <div className="text-[11px] text-cmd-muted">{s.distance_km} km away</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-cmd-green tabular-nums">{s.capacity.toLocaleString()}</div>
                  <div className="text-[11px] text-cmd-muted">capacity</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      </div>
    </motion.div>
  );
}

