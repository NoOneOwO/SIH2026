/**
 * DamSafe Twin â€” Indian Dams Dataset (CURATED: 50 dams)
 *
 * 30 dams ship a real-DEM local 3D terrain model (see
 * 3d-assets/terrain-pipeline/curate.py); 20 more are list-only
 * (globe fallback). Dams that cannot be cleanly 3D-reconstructed
 * (flat-plains or failed fetches) are excluded from this file.
 * Coordinates in WGS84 (EPSG:4326).
 */

export interface DamPoint {
  id: string;
  name: string;
  state: string;
  lon: number;
  lat: number;
  height_m: number;
  type: string;
  river: string;
  capacity_mcm: number;
  year_built: number;
}

export interface DamPoint {
  id: string;
  name: string;
  state: string;
  lon: number;
  lat: number;
  height_m: number;
  type: string;
  river: string;
  capacity_mcm: number;
  year_built: number;
}

export const INDIA_DAMS: DamPoint[] = [
  { id: 'd60', name: 'Subansiri Dam (under constr)', state: 'Arunachal Pradesh', lon: 94.75, lat: 27.58, height_m: 288, type: 'concrete_gravity', river: 'Subansiri', capacity_mcm: 11600, year_built: 2028 },
  { id: 'd84', name: 'Tehri Pump Storage', state: 'Uttarakhand', lon: 78.47, lat: 30.38, height_m: 260, type: 'rockfill', river: 'Bhagirathi', capacity_mcm: 3540, year_built: 2024 },
  { id: 'd4', name: 'Tehri Dam', state: 'Uttarakhand', lon: 78.474, lat: 30.376, height_m: 260, type: 'rockfill', river: 'Bhagirathi', capacity_mcm: 3540, year_built: 2006 },
  { id: 'd1', name: 'Bhakra Dam', state: 'Himachal Pradesh', lon: 76.431, lat: 31.411, height_m: 226, type: 'concrete_gravity', river: 'Sutlej', capacity_mcm: 9340, year_built: 1963 },
  { id: 'd52', name: 'Idukki Dam', state: 'Kerala', lon: 76.98, lat: 9.83, height_m: 168, type: 'concrete_arch', river: 'Periyar', capacity_mcm: 1996, year_built: 1976 },
  { id: 'd3', name: 'Nathpa Jhakri Dam', state: 'Himachal Pradesh', lon: 77.87, lat: 31.55, height_m: 167, type: 'concrete_gravity', river: 'Sutlej', capacity_mcm: 3745, year_built: 2004 },
  { id: 'd16', name: 'Sardar Sarovar', state: 'Gujarat', lon: 73.55, lat: 21.83, height_m: 163, type: 'concrete_gravity', river: 'Narmada', capacity_mcm: 9500, year_built: 2017 },
  { id: 'd88', name: 'Sardar Vallabhbhai Patel', state: 'Gujarat', lon: 73.55, lat: 21.83, height_m: 163, type: 'concrete_gravity', river: 'Narmada', capacity_mcm: 9500, year_built: 2017 },
  { id: 'd118', name: 'Tipaimukh Dam (under constr)', state: 'Manipur', lon: 93.57, lat: 24.42, height_m: 162, type: 'concrete_gravity', river: 'Barak', capacity_mcm: 1500, year_built: 2030 },
  { id: 'd9', name: 'Ranjit Sagar Dam', state: 'Punjab', lon: 75.88, lat: 32.39, height_m: 160, type: 'concrete_gravity', river: 'Ravi', capacity_mcm: 3282, year_built: 2001 },
  { id: 'd41', name: 'Srisailam Dam', state: 'Andhra Pradesh', lon: 78.87, lat: 16.08, height_m: 145, type: 'concrete_gravity', river: 'Krishna', capacity_mcm: 8106, year_built: 1981 },
  { id: 'd122', name: 'Srisailam Dam (AP)', state: 'Andhra Pradesh', lon: 78.87, lat: 16.08, height_m: 145, type: 'concrete_gravity', river: 'Krishna', capacity_mcm: 8106, year_built: 1981 },
  { id: 'd79', name: 'Baglihar Dam', state: 'Jammu & Kashmir', lon: 75.78, lat: 33.42, height_m: 144, type: 'concrete_gravity', river: 'Chenab', capacity_mcm: 480, year_built: 2008 },
  { id: 'd80', name: 'Ratle Dam', state: 'Jammu & Kashmir', lon: 75.87, lat: 33.2, height_m: 135, type: 'concrete_gravity', river: 'Chenab', capacity_mcm: 450, year_built: 2025 },
  { id: 'd78', name: 'Dulhasti Dam', state: 'Jammu & Kashmir', lon: 75.38, lat: 33.73, height_m: 134, type: 'concrete_gravity', river: 'Chenab', capacity_mcm: 345, year_built: 1985 },
  { id: 'd2', name: 'Pong Dam', state: 'Himachal Pradesh', lon: 76.27, lat: 32.02, height_m: 133, type: 'earthfill', river: 'Beas', capacity_mcm: 7417, year_built: 1975 },
  { id: 'd90', name: 'Pong Dam (Beas)', state: 'Himachal Pradesh', lon: 76.27, lat: 32.02, height_m: 133, type: 'earthen', river: 'Beas', capacity_mcm: 7417, year_built: 1975 },
  { id: 'd40', name: 'Nagarjuna Sagar', state: 'Telangana', lon: 79.32, lat: 16.57, height_m: 125, type: 'masonry', river: 'Krishna', capacity_mcm: 11472, year_built: 1967 },
  { id: 'd85', name: 'Tanakpur Dam', state: 'Uttarakhand', lon: 80.13, lat: 29.07, height_m: 117, type: 'concrete_gravity', river: 'Mahakali', capacity_mcm: 220, year_built: 2001 },
  { id: 'd77', name: 'Salal Dam', state: 'Jammu & Kashmir', lon: 74.77, lat: 33.35, height_m: 113, type: 'concrete_gravity', river: 'Chenab', capacity_mcm: 490, year_built: 1978 },
  { id: 'd131', name: 'Idamalayar Dam', state: 'Kerala', lon: 76.95, lat: 10.1, height_m: 105, type: 'earthfill', river: 'Idamalayar', capacity_mcm: 736, year_built: 1976 },
  { id: 'd112', name: 'Kishanganga Dam', state: 'Jammu & Kashmir', lon: 74.78, lat: 34.48, height_m: 103, type: 'concrete_gravity', river: 'Jhelum', capacity_mcm: 360, year_built: 2018 },
  { id: 'd28', name: 'Koyna Dam', state: 'Maharashtra', lon: 73.84, lat: 17.41, height_m: 103, type: 'concrete_gravity', river: 'Koyna', capacity_mcm: 2796, year_built: 1963 },
  { id: 'd25', name: 'Narmada Sagar', state: 'Madhya Pradesh', lon: 76.93, lat: 22.18, height_m: 92, type: 'concrete_gravity', river: 'Narmada', capacity_mcm: 12220, year_built: 2005 },
  { id: 'd110', name: 'Sainj Dam', state: 'Himachal Pradesh', lon: 77.07, lat: 31.62, height_m: 88, type: 'concrete_gravity', river: 'Sainj', capacity_mcm: 180, year_built: 2013 },
  { id: 'd83', name: 'Parbati Dam', state: 'Himachal Pradesh', lon: 77.22, lat: 31.88, height_m: 88, type: 'concrete_gravity', river: 'Parbati', capacity_mcm: 362, year_built: 2006 },
  { id: 'd48', name: 'Aliyar Dam', state: 'Tamil Nadu', lon: 76.92, lat: 10.48, height_m: 82, type: 'masonry', river: 'Aliyar', capacity_mcm: 177, year_built: 1962 },
  { id: 'd17', name: 'Ukai Dam', state: 'Gujarat', lon: 73.6, lat: 21.22, height_m: 81, type: 'earthen', river: 'Tapti', capacity_mcm: 8510, year_built: 1972 },
  { id: 'd5', name: 'Dhauliganga Dam', state: 'Uttarakhand', lon: 79.47, lat: 29.93, height_m: 80, type: 'concrete_gravity', river: 'Dhauliganga', capacity_mcm: 375, year_built: 1970 },
  { id: 'd81', name: 'Kol Dam', state: 'Himachal Pradesh', lon: 77.72, lat: 31.38, height_m: 72, type: 'concrete_gravity', river: 'Sutlej', capacity_mcm: 925, year_built: 2015 },
  { id: 'd128', name: 'Parambikulam Dam', state: 'Tamil Nadu', lon: 76.65, lat: 10.55, height_m: 72, type: 'masonry', river: 'Parambikulam', capacity_mcm: 666, year_built: 1963 },
  { id: 'd21', name: 'Bargi Dam', state: 'Madhya Pradesh', lon: 80.12, lat: 23.2, height_m: 69, type: 'earthen', river: 'Narmada', capacity_mcm: 4376, year_built: 1988 },
  { id: 'd26', name: 'Tehri Dam (MP branch)', state: 'Madhya Pradesh', lon: 79.5, lat: 23.2, height_m: 63, type: 'earthen', river: 'Son', capacity_mcm: 1434, year_built: 1970 },
  { id: 'd38', name: 'Gerusoppa Dam', state: 'Karnataka', lon: 74.57, lat: 14.15, height_m: 62, type: 'earthen', river: 'Sharavathi', capacity_mcm: 4178, year_built: 1964 },
  { id: 'd7', name: 'Hirakud Dam', state: 'Odisha', lon: 83.8, lat: 21.5, height_m: 61, type: 'earthen', river: 'Mahanadi', capacity_mcm: 8136, year_built: 1957 },
  { id: 'd42', name: 'Polavaram Dam', state: 'Andhra Pradesh', lon: 81.47, lat: 17.25, height_m: 60, type: 'earthfill', river: 'Godavari', capacity_mcm: 16020, year_built: 2024 },
  { id: 'd36', name: 'Linganamakki Dam', state: 'Karnataka', lon: 74.81, lat: 14.22, height_m: 57, type: 'earthfill', river: 'Sharavathi', capacity_mcm: 3194, year_built: 1964 },
  { id: 'd44', name: 'Somasila Dam', state: 'Andhra Pradesh', lon: 78.43, lat: 14.58, height_m: 54, type: 'earthen', river: 'Pennar', capacity_mcm: 336, year_built: 1986 },
  { id: 'd13', name: 'Rana Pratap Sagar', state: 'Rajasthan', lon: 74.77, lat: 24.93, height_m: 54, type: 'concrete_gravity', river: 'Chambal', capacity_mcm: 2256, year_built: 1957 },
  { id: 'd49', name: 'Periyar Dam', state: 'Tamil Nadu', lon: 77.25, lat: 9.58, height_m: 53, type: 'masonry', river: 'Periyar', capacity_mcm: 325, year_built: 1895 },
  { id: 'd31', name: 'Ghatprabha Dam', state: 'Maharashtra', lon: 75.45, lat: 16.33, height_m: 52, type: 'earthen', river: 'Ghatprabha', capacity_mcm: 1554, year_built: 1968 },
  { id: 'd33', name: 'Almatti Dam', state: 'Karnataka', lon: 75.93, lat: 16.33, height_m: 52, type: 'earthfill', river: 'Krishna', capacity_mcm: 2533, year_built: 2005 },
  { id: 'd35', name: 'Tungabhadra Dam', state: 'Karnataka', lon: 76.33, lat: 15.32, height_m: 49, type: 'masonry', river: 'Tungabhadra', capacity_mcm: 3780, year_built: 1953 },
  { id: 'd46', name: 'Mettur Dam', state: 'Tamil Nadu', lon: 77.93, lat: 11.8, height_m: 48, type: 'concrete_gravity', river: 'Cauvery', capacity_mcm: 9386, year_built: 1934 },
  { id: 'd47', name: 'Bhavanisagar Dam', state: 'Tamil Nadu', lon: 77.15, lat: 11.47, height_m: 47, type: 'earthen', river: 'Bhavani', capacity_mcm: 3265, year_built: 1955 },
  { id: 'd24', name: 'Omkareshwar Dam', state: 'Madhya Pradesh', lon: 76.15, lat: 22.23, height_m: 45, type: 'concrete_gravity', river: 'Narmada', capacity_mcm: 6038, year_built: 2007 },
  { id: 'd50', name: 'Vaigai Dam', state: 'Tamil Nadu', lon: 77.62, lat: 9.93, height_m: 44, type: 'concrete_gravity', river: 'Vaigai', capacity_mcm: 707, year_built: 1971 },
  { id: 'd45', name: 'Priyadarshini Jurala', state: 'Telangana', lon: 78.33, lat: 16.37, height_m: 44, type: 'concrete_gravity', river: 'Krishna', capacity_mcm: 1314, year_built: 2003 },
  { id: 'd20', name: 'Damanganga', state: 'Gujarat', lon: 72.92, lat: 20.25, height_m: 35, type: 'earthfill', river: 'Damanganga', capacity_mcm: 1055, year_built: 1976 },
  { id: 'd39', name: 'Salaulim Dam', state: 'Goa', lon: 74.05, lat: 15.35, height_m: 33, type: 'earthen', river: 'Salaulim', capacity_mcm: 536, year_built: 1985 },
];

