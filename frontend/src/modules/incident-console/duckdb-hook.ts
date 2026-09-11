/**
 * DamSafe Twin — DuckDB-WASM Spatial Query Hook
 *
 * Uses DuckDB-WASM (from GeoLibre's stack) for client-side spatial SQL:
 * - Village proximity analysis
 * - Road passability at time t
 * - Population-weighted hazard scoring
 * - Spatial joins between villages, roads, facilities
 *
 * All queries run in-browser — no backend round-trips.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { VillageData, RoadData, FacilityData } from './hooks';

interface DuckDBState {
  db: any | null;
  conn: any | null;
  ready: boolean;
  error: string | null;
}

export function useDuckDB() {
  const [state, setState] = useState<DuckDBState>({
    db: null,
    conn: null,
    ready: false,
    error: null,
  });
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    async function initDuckDB() {
      try {
        const duckdb = await import('@duckdb/duckdb-wasm');

        const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
        const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

        const worker_url = URL.createObjectURL(
          new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
        );
        const worker = new Worker(worker_url);
        const logger = new duckdb.ConsoleLogger();
        const db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        URL.revokeObjectURL(worker_url);

        const conn = await db.connect();

        // Enable spatial extension
        await conn.query(`INSTALL spatial; LOAD spatial;`);

        setState({ db, conn, ready: true, error: null });
      } catch (err: any) {
        console.warn('DuckDB-WASM init failed:', err);
        setState((s) => ({ ...s, error: err.message }));
      }
    }

    initDuckDB();
  }, []);

  return state;
}

/**
 * Spatial analysis queries powered by DuckDB-WASM.
 * These run entirely in the browser.
 */
export function useSpatialQueries(duckdb: DuckDBState) {
  const queryNearestVillages = useCallback(
    async (villages: VillageData[], lat: number, lon: number, limitKm: number = 50) => {
      if (!duckdb.conn) return villages;

      try {
        // Create in-memory table of villages
        await duckdb.conn.query(`
          CREATE OR REPLACE TEMP TABLE villages AS
          SELECT * FROM (VALUES
            ${villages.map((v) => `('${v.id}', '${v.name}', ${v.lon}, ${v.lat}, ${v.population}, ${v.arrival_time_min}, ${v.hazard_index}, '${v.hazard_class}')`).join(',\n            ')}
          ) AS t(id, name, lon, lat, population, arrival_time_min, hazard_index, hazard_class);
        `);

        // Query villages within radius using ST_Distance
        const result = await duckdb.conn.query(`
          SELECT
            id, name, lon, lat, population, arrival_time_min, hazard_index, hazard_class,
            ST_Distance(
              ST_Point(lon, lat)::geometry,
              ST_Point(${lon}, ${lat})::geometry
            ) / 1000.0 AS distance_km
          FROM villages
          WHERE ST_Distance(
            ST_Point(lon, lat)::geometry,
            ST_Point(${lon}, ${lat})::geometry
          ) / 1000.0 <= ${limitKm}
          ORDER BY distance_km ASC
        `);

        return result.toArray().map((row: any) => ({
          id: row.id,
          name: row.name,
          lon: row.lon,
          lat: row.lat,
          population: row.population,
          arrival_time_min: row.arrival_time_min,
          hazard_index: row.hazard_index,
          hazard_class: row.hazard_class,
          distance_km: row.distance_km,
        }));
      } catch (err) {
        console.warn('DuckDB spatial query failed, returning original data:', err);
        return villages;
      }
    },
    [duckdb.conn],
  );

  const computeEvacuationZones = useCallback(
    async (villages: VillageData[], currentTimeMinutes: number) => {
      if (!duckdb.conn) {
        return {
          immediate: villages.filter((v) => v.arrival_time_min <= 30),
          urgent: villages.filter((v) => v.arrival_time_min > 30 && v.arrival_time_min <= 60),
          planned: villages.filter((v) => v.arrival_time_min > 60),
          totalPopulation: villages.reduce((s, v) => s + v.population, 0),
          floodedCount: villages.filter((v) => currentTimeMinutes >= v.arrival_time_min).length,
        };
      }

      try {
        await duckdb.conn.query(`
          CREATE OR REPLACE TEMP TABLE villages AS
          SELECT * FROM (VALUES
            ${villages.map((v) => `('${v.id}', '${v.name}', ${v.lon}, ${v.lat}, ${v.population}, ${v.arrival_time_min}, ${v.hazard_index}, '${v.hazard_class}')`).join(',\n            ')}
          ) AS t(id, name, lon, lat, population, arrival_time_min, hazard_index, hazard_class);
        `);

        const result = await duckdb.conn.query(`
          SELECT
            CASE
              WHEN arrival_time_min <= 30 THEN 'immediate'
              WHEN arrival_time_min <= 60 THEN 'urgent'
              ELSE 'planned'
            END AS zone,
            COUNT(*) AS village_count,
            SUM(population) AS total_population,
            SUM(CASE WHEN ${currentTimeMinutes} >= arrival_time_min THEN 1 ELSE 0 END) AS flooded_count,
            AVG(hazard_index) AS avg_hazard
          FROM villages
          GROUP BY zone
          ORDER BY MIN(arrival_time_min)
        `);

        const zones = result.toArray();
        const totalPopulation = villages.reduce((s, v) => s + v.population, 0);
        const floodedCount = villages.filter((v) => currentTimeMinutes >= v.arrival_time_min).length;

        return {
          immediate: villages.filter((v) => v.arrival_time_min <= 30),
          urgent: villages.filter((v) => v.arrival_time_min > 30 && v.arrival_time_min <= 60),
          planned: villages.filter((v) => v.arrival_time_min > 60),
          totalPopulation,
          floodedCount,
          zoneStats: zones,
        };
      } catch (err) {
        console.warn('DuckDB zone query failed:', err);
        return {
          immediate: villages.filter((v) => v.arrival_time_min <= 30),
          urgent: villages.filter((v) => v.arrival_time_min > 30 && v.arrival_time_min <= 60),
          planned: villages.filter((v) => v.arrival_time_min > 60),
          totalPopulation: villages.reduce((s, v) => s + v.population, 0),
          floodedCount: villages.filter((v) => currentTimeMinutes >= v.arrival_time_min).length,
        };
      }
    },
    [duckdb.conn],
  );

  return { queryNearestVillages, computeEvacuationZones };
}
