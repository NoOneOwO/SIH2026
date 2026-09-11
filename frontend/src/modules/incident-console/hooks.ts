/**
 * DamSafe Twin — useImpactData Hook
 *
 * Single data-fetching hook consumed by BOTH the 2D MapLibre and 3D CesiumJS viewers.
 * Never let the 3D viewer fetch impact data independently — that causes drift.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Shared State Interface ───────────────────────────────────────────────────

export interface IncidentConsoleState {
  viewMode: '2d' | '3d';
  simRunId: string;
  currentTimeMinutes: number;
  cameraTarget: { lon: number; lat: number; heightM: number } | null;
}

// ── Data Types ───────────────────────────────────────────────────────────────

export interface VillageData {
  id: string;
  name: string;
  lon: number;
  lat: number;
  population: number;
  arrival_time_min: number;
  depth_m: number;
  velocity_ms: number;
  hazard_index: number;
  hazard_class: 'green' | 'yellow' | 'orange' | 'red';
  flooded: boolean;
}

export interface RoadData {
  id: string;
  name: string;
  coordinates: [number, number][];
  status: 'safe' | 'restricted' | 'impassable';
  depth_m: number;
  velocity_ms: number;
}

export interface FacilityData {
  id: string;
  name: string;
  kind: 'hospital' | 'school' | 'substation' | 'telecom_tower' | 'police_station';
  lon: number;
  lat: number;
}

export interface ShelterData {
  id: string;
  name: string;
  lon: number;
  lat: number;
  capacity: number;
}

export interface DamData {
  id: string;
  name: string;
  lon: number;
  lat: number;
  height_m: number;
  model_3d_url: string | null;
}

export interface ImpactData {
  dam: DamData;
  villages: VillageData[];
  roads: RoadData[];
  facilities: FacilityData[];
  shelters: ShelterData[];
  floodExtent: { center: [number, number]; radiusDeg: number } | null;
}

// ── Mock Data (MVP — replaced with API calls when backend is running) ────────

const MOCK_DAM: DamData = {
  id: '10000000-0000-0000-0000-000000000001',
  name: 'Machhu Dam',
  lon: 70.85,
  lat: 22.83,
  height_m: 35.0,
  model_3d_url: null,
};

const MOCK_VILLAGES: VillageData[] = [
  { id: 'v1', name: 'Bhalbhal', lon: 70.82, lat: 22.78, population: 5000, arrival_time_min: 20, depth_m: 3.2, velocity_ms: 4.1, hazard_index: 13.12, hazard_class: 'red', flooded: false },
  { id: 'v2', name: 'Jhinjhuwa', lon: 70.75, lat: 22.85, population: 3500, arrival_time_min: 25, depth_m: 2.8, velocity_ms: 3.5, hazard_index: 9.8, hazard_class: 'red', flooded: false },
  { id: 'v3', name: 'Makkerha', lon: 70.90, lat: 22.70, population: 4200, arrival_time_min: 30, depth_m: 2.1, velocity_ms: 2.8, hazard_index: 5.88, hazard_class: 'orange', flooded: false },
  { id: 'v4', name: 'Tankara', lon: 70.78, lat: 22.80, population: 15000, arrival_time_min: 35, depth_m: 1.8, velocity_ms: 2.2, hazard_index: 3.96, hazard_class: 'orange', flooded: false },
  { id: 'v5', name: 'Muli', lon: 71.05, lat: 22.75, population: 12000, arrival_time_min: 40, depth_m: 1.2, velocity_ms: 1.5, hazard_index: 1.8, hazard_class: 'yellow', flooded: false },
  { id: 'v6', name: 'Morbi City', lon: 70.83, lat: 22.82, population: 210000, arrival_time_min: 45, depth_m: 0.8, velocity_ms: 1.0, hazard_index: 0.8, hazard_class: 'yellow', flooded: false },
  { id: 'v7', name: 'Wankaner', lon: 70.95, lat: 22.85, population: 30000, arrival_time_min: 60, depth_m: 0.3, velocity_ms: 0.5, hazard_index: 0.15, hazard_class: 'green', flooded: false },
  { id: 'v8', name: 'Halvad', lon: 71.18, lat: 23.02, population: 25000, arrival_time_min: 90, depth_m: 0.1, velocity_ms: 0.2, hazard_index: 0.02, hazard_class: 'green', flooded: false },
];

const MOCK_ROADS: RoadData[] = [
  { id: 'r1', name: 'NH-27 (Morbi-Rajkot)', coordinates: [[70.70, 22.82], [70.83, 22.82], [71.00, 22.83]], status: 'safe', depth_m: 0, velocity_ms: 0 },
  { id: 'r2', name: 'SH-6 (Morbi-Tankara)', coordinates: [[70.83, 22.82], [70.78, 22.80], [70.75, 22.78]], status: 'restricted', depth_m: 0.4, velocity_ms: 0.6 },
  { id: 'r3', name: 'Morbi-Wankaner Road', coordinates: [[70.83, 22.82], [70.90, 22.84], [70.95, 22.85]], status: 'safe', depth_m: 0.1, velocity_ms: 0.2 },
];

const MOCK_FACILITIES: FacilityData[] = [
  { id: 'f1', name: 'Morbi General Hospital', kind: 'hospital', lon: 70.83, lat: 22.82 },
  { id: 'f2', name: 'Morbi Police Station', kind: 'police_station', lon: 70.84, lat: 22.81 },
  { id: 'f3', name: 'GEB Substation Morbi', kind: 'substation', lon: 70.82, lat: 22.83 },
  { id: 'f4', name: 'BSNL Tower Morbi', kind: 'telecom_tower', lon: 70.85, lat: 22.82 },
  { id: 'f5', name: 'Government School Tankara', kind: 'school', lon: 70.78, lat: 22.80 },
];

const MOCK_SHELTERS: ShelterData[] = [
  { id: 's1', name: 'Morbi Stadium', lon: 70.84, lat: 22.84, capacity: 5000 },
  { id: 's2', name: 'Govt School Complex', lon: 70.82, lat: 22.85, capacity: 2000 },
  { id: 's3', name: 'Community Hall Tankara', lon: 70.77, lat: 22.81, capacity: 1500 },
];

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useImpactData(simRunId: string, currentTimeMinutes: number) {
  const [data, setData] = useState<ImpactData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    // Abort any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setLoading(true);

      // Try fetching from the real API first
      const BASE = import.meta.env.VITE_API_BASE_URL || '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (import.meta.env.DEV) headers['Authorization'] = 'Bearer dev-token';

      let villages: VillageData[] = MOCK_VILLAGES;
      let roads: RoadData[] = MOCK_ROADS;

      // Mock fallback: time-based flooding from mock data
      const applyMockFallback = () => {
        villages = MOCK_VILLAGES.map((v) => ({
          ...v,
          flooded: currentTimeMinutes >= v.arrival_time_min,
          depth_m: currentTimeMinutes >= v.arrival_time_min
            ? Math.min(v.depth_m, ((currentTimeMinutes - v.arrival_time_min) / 30) * v.depth_m)
            : 0,
        }));
        roads = MOCK_ROADS.map((r) => ({
          ...r,
          status: (currentTimeMinutes > 15 ? 'restricted' : r.status) as RoadData['status'],
        }));
      };

      try {
        // Attempt real API calls
        const [priorityRes, roadRes] = await Promise.all([
          fetch(`${BASE}/api/v1/impact/${simRunId}/priority?t=${currentTimeMinutes}`, { headers, signal: controller.signal }),
          fetch(`${BASE}/api/v1/impact/${simRunId}/roads?t=${currentTimeMinutes}`, { headers, signal: controller.signal }),
        ]);

        if (priorityRes.ok) {
          const priorityData = await priorityRes.json();
          if (priorityData.priorities?.length) {
            villages = priorityData.priorities.map((p: any) => {
              const mock = MOCK_VILLAGES.find((v) => v.name === p.village_name) || MOCK_VILLAGES[0];
              return {
                ...mock,
                name: p.village_name,
                population: p.population,
                depth_m: p.depth_m,
                velocity_ms: p.velocity_ms,
                hazard_index: p.hazard_index,
                hazard_class: p.hazard_class,
                flooded: currentTimeMinutes >= p.arrival_time_min,
              };
            });
          } else {
            applyMockFallback();
          }
        } else {
          applyMockFallback();
        }
        if (roadRes.ok) {
          const roadData = await roadRes.json();
          if (roadData.roads?.length) {
            roads = roadData.roads.map((r: any) => {
              const mock = MOCK_ROADS.find((m) => m.name === r.road_name) || MOCK_ROADS[0];
              return { ...mock, name: r.road_name, status: r.status, depth_m: r.depth_m, velocity_ms: r.velocity_ms };
            });
          }
        }
      } catch {
        // Network error — API completely unavailable
        applyMockFallback();
      }

      if (controller.signal.aborted) return;

      // Compute flood extent based on time
      const maxArrival = Math.max(...villages.filter((v) => v.flooded).map((v) => v.arrival_time_min), 0);
      const floodExtent = currentTimeMinutes > 0
        ? { center: [MOCK_DAM.lon, MOCK_DAM.lat] as [number, number], radiusDeg: (currentTimeMinutes / 120) * 0.15 }
        : null;

      setData({
        dam: MOCK_DAM,
        villages,
        roads,
        facilities: MOCK_FACILITIES,
        shelters: MOCK_SHELTERS,
        floodExtent,
      });
      setError(null);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [simRunId, currentTimeMinutes]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  return { data, loading, error };
}
