"""
DamSafe Twin Sandbox — canonical backend dam registry.

Single source of coordinates for the simulation backend (mirrors
frontend/src/data/india-dams.ts; regenerate from that file if it changes).
IDs (d1..d131) are stable canonical keys shared with terrain assets.
"""

from __future__ import annotations

DAMS: list[dict] = [
    {"id": "d60", "name": "Subansiri Dam (under constr)", "state": "Arunachal Pradesh", "lon": 94.75, "lat": 27.58, "height_m": 288}, 
    {"id": "d84", "name": "Tehri Pump Storage", "state": "Uttarakhand", "lon": 78.47, "lat": 30.38, "height_m": 260}, 
    {"id": "d4", "name": "Tehri Dam", "state": "Uttarakhand", "lon": 78.474, "lat": 30.376, "height_m": 260}, 
    {"id": "d1", "name": "Bhakra Dam", "state": "Himachal Pradesh", "lon": 76.431, "lat": 31.411, "height_m": 226}, 
    {"id": "d52", "name": "Idukki Dam", "state": "Kerala", "lon": 76.98, "lat": 9.83, "height_m": 168}, 
    {"id": "d3", "name": "Nathpa Jhakri Dam", "state": "Himachal Pradesh", "lon": 77.87, "lat": 31.55, "height_m": 167}, 
    {"id": "d16", "name": "Sardar Sarovar", "state": "Gujarat", "lon": 73.55, "lat": 21.83, "height_m": 163}, 
    {"id": "d88", "name": "Sardar Vallabhbhai Patel", "state": "Gujarat", "lon": 73.55, "lat": 21.83, "height_m": 163}, 
    {"id": "d118", "name": "Tipaimukh Dam (under constr)", "state": "Manipur", "lon": 93.57, "lat": 24.42, "height_m": 162}, 
    {"id": "d9", "name": "Ranjit Sagar Dam", "state": "Punjab", "lon": 75.88, "lat": 32.39, "height_m": 160}, 
    {"id": "d41", "name": "Srisailam Dam", "state": "Andhra Pradesh", "lon": 78.87, "lat": 16.08, "height_m": 145}, 
    {"id": "d122", "name": "Srisailam Dam (AP)", "state": "Andhra Pradesh", "lon": 78.87, "lat": 16.08, "height_m": 145}, 
    {"id": "d79", "name": "Baglihar Dam", "state": "Jammu & Kashmir", "lon": 75.78, "lat": 33.42, "height_m": 144}, 
    {"id": "d80", "name": "Ratle Dam", "state": "Jammu & Kashmir", "lon": 75.87, "lat": 33.2, "height_m": 135}, 
    {"id": "d78", "name": "Dulhasti Dam", "state": "Jammu & Kashmir", "lon": 75.38, "lat": 33.73, "height_m": 134}, 
    {"id": "d2", "name": "Pong Dam", "state": "Himachal Pradesh", "lon": 76.27, "lat": 32.02, "height_m": 133}, 
    {"id": "d90", "name": "Pong Dam (Beas)", "state": "Himachal Pradesh", "lon": 76.27, "lat": 32.02, "height_m": 133}, 
    {"id": "d40", "name": "Nagarjuna Sagar", "state": "Telangana", "lon": 79.32, "lat": 16.57, "height_m": 125}, 
    {"id": "d85", "name": "Tanakpur Dam", "state": "Uttarakhand", "lon": 80.13, "lat": 29.07, "height_m": 117}, 
    {"id": "d77", "name": "Salal Dam", "state": "Jammu & Kashmir", "lon": 74.77, "lat": 33.35, "height_m": 113}, 
    {"id": "d131", "name": "Idamalayar Dam", "state": "Kerala", "lon": 76.95, "lat": 10.1, "height_m": 105}, 
    {"id": "d112", "name": "Kishanganga Dam", "state": "Jammu & Kashmir", "lon": 74.78, "lat": 34.48, "height_m": 103}, 
    {"id": "d28", "name": "Koyna Dam", "state": "Maharashtra", "lon": 73.84, "lat": 17.41, "height_m": 103}, 
    {"id": "d25", "name": "Narmada Sagar", "state": "Madhya Pradesh", "lon": 76.93, "lat": 22.18, "height_m": 92}, 
    {"id": "d110", "name": "Sainj Dam", "state": "Himachal Pradesh", "lon": 77.07, "lat": 31.62, "height_m": 88}, 
    {"id": "d83", "name": "Parbati Dam", "state": "Himachal Pradesh", "lon": 77.22, "lat": 31.88, "height_m": 88}, 
    {"id": "d48", "name": "Aliyar Dam", "state": "Tamil Nadu", "lon": 76.92, "lat": 10.48, "height_m": 82}, 
    {"id": "d17", "name": "Ukai Dam", "state": "Gujarat", "lon": 73.6, "lat": 21.22, "height_m": 81}, 
    {"id": "d5", "name": "Dhauliganga Dam", "state": "Uttarakhand", "lon": 79.47, "lat": 29.93, "height_m": 80}, 
    {"id": "d81", "name": "Kol Dam", "state": "Himachal Pradesh", "lon": 77.72, "lat": 31.38, "height_m": 72}, 
    {"id": "d128", "name": "Parambikulam Dam", "state": "Tamil Nadu", "lon": 76.65, "lat": 10.55, "height_m": 72}, 
    {"id": "d21", "name": "Bargi Dam", "state": "Madhya Pradesh", "lon": 80.12, "lat": 23.2, "height_m": 69}, 
    {"id": "d26", "name": "Tehri Dam (MP branch)", "state": "Madhya Pradesh", "lon": 79.5, "lat": 23.2, "height_m": 63}, 
    {"id": "d38", "name": "Gerusoppa Dam", "state": "Karnataka", "lon": 74.57, "lat": 14.15, "height_m": 62}, 
    {"id": "d7", "name": "Hirakud Dam", "state": "Odisha", "lon": 83.8, "lat": 21.5, "height_m": 61}, 
    {"id": "d42", "name": "Polavaram Dam", "state": "Andhra Pradesh", "lon": 81.47, "lat": 17.25, "height_m": 60}, 
    {"id": "d36", "name": "Linganamakki Dam", "state": "Karnataka", "lon": 74.81, "lat": 14.22, "height_m": 57}, 
    {"id": "d44", "name": "Somasila Dam", "state": "Andhra Pradesh", "lon": 78.43, "lat": 14.58, "height_m": 54}, 
    {"id": "d13", "name": "Rana Pratap Sagar", "state": "Rajasthan", "lon": 74.77, "lat": 24.93, "height_m": 54}, 
    {"id": "d49", "name": "Periyar Dam", "state": "Tamil Nadu", "lon": 77.25, "lat": 9.58, "height_m": 53}, 
    {"id": "d31", "name": "Ghatprabha Dam", "state": "Maharashtra", "lon": 75.45, "lat": 16.33, "height_m": 52}, 
    {"id": "d33", "name": "Almatti Dam", "state": "Karnataka", "lon": 75.93, "lat": 16.33, "height_m": 52}, 
    {"id": "d35", "name": "Tungabhadra Dam", "state": "Karnataka", "lon": 76.33, "lat": 15.32, "height_m": 49}, 
    {"id": "d46", "name": "Mettur Dam", "state": "Tamil Nadu", "lon": 77.93, "lat": 11.8, "height_m": 48}, 
    {"id": "d47", "name": "Bhavanisagar Dam", "state": "Tamil Nadu", "lon": 77.15, "lat": 11.47, "height_m": 47}, 
    {"id": "d24", "name": "Omkareshwar Dam", "state": "Madhya Pradesh", "lon": 76.15, "lat": 22.23, "height_m": 45}, 
    {"id": "d50", "name": "Vaigai Dam", "state": "Tamil Nadu", "lon": 77.62, "lat": 9.93, "height_m": 44}, 
    {"id": "d45", "name": "Priyadarshini Jurala", "state": "Telangana", "lon": 78.33, "lat": 16.37, "height_m": 44}, 
    {"id": "d20", "name": "Damanganga", "state": "Gujarat", "lon": 72.92, "lat": 20.25, "height_m": 35}, 
    {"id": "d39", "name": "Salaulim Dam", "state": "Goa", "lon": 74.05, "lat": 15.35, "height_m": 33}, 
]

_BY_ID = {d["id"]: d for d in DAMS}


def get_dam(dam_id: str) -> dict | None:
    """Canonical record or None (caller raises a proper API error)."""
    return _BY_ID.get(dam_id)
