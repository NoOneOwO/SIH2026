"""
DamSafe Twin — Report Generation Service

Renders village briefings + EAP / incident PDFs from scenario + impact data.
"""

import os
from datetime import datetime
from typing import Optional
from uuid import UUID

from jinja2 import Template

from app.config import get_settings

settings = get_settings()

# ── Templates ────────────────────────────────────────────────────────────────

EAP_REPORT_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>DamSafe Twin — EAP Report: {{ dam_name }}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px; color: #1a1a1a; }
  h1 { color: #c0392b; border-bottom: 3px solid #c0392b; padding-bottom: 8px; }
  h2 { color: #2c3e50; margin-top: 24px; }
  h3 { color: #34495e; }
  .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin: 16px 0; }
  .danger { background: #f8d7da; border-left: 4px solid #dc3545; padding: 12px; margin: 16px 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #2c3e50; color: white; }
  tr:nth-child(even) { background: #f8f9fa; }
  .priority-high { color: #dc3545; font-weight: bold; }
  .priority-medium { color: #fd7e14; }
  .priority-low { color: #28a745; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 2px solid #ddd; font-size: 11px; color: #666; }
  .disclaimer { background: #e9ecef; padding: 16px; margin: 16px 0; font-style: italic; }
</style>
</head>
<body>

<h1>🛡️ DamSafe Twin — Emergency Action Plan</h1>

<div class="danger">
  <strong>CLASSIFICATION:</strong> {{ classification }}<br>
  <strong>Prepared:</strong> {{ prepared_date }}<br>
  <strong>Prepared by:</strong> {{ prepared_by }}
</div>

<h2>1. Dam Overview</h2>
<table>
  <tr><th>Parameter</th><th>Value</th></tr>
  <tr><td>Dam Name</td><td>{{ dam_name }}</td></tr>
  <tr><td>Dam Type</td><td>{{ dam_type }}</td></tr>
  <tr><td>Height</td><td>{{ height_m }} m</td></tr>
  <tr><td>Crest Length</td><td>{{ crest_length_m }} m</td></tr>
  <tr><td>Reservoir Capacity</td><td>{{ reservoir_capacity_mcm }} MCM</td></tr>
  <tr><td>Spillway Count</td><td>{{ spillway_count }}</td></tr>
</table>

<h2>2. Failure Scenarios</h2>
{% for scenario in scenarios %}
<h3>{{ scenario.failure_mode | title }} — {{ scenario.variant }}</h3>
<table>
  <tr><th>Parameter</th><th>Value</th></tr>
  <tr><td>Failure Mode</td><td>{{ scenario.failure_mode }}</td></tr>
  <tr><td>Variant</td><td>{{ scenario.variant }}</td></tr>
  <tr><td>Solver</td><td>{{ scenario.solver }} v{{ scenario.solver_version }}</td></tr>
  <tr><td>Status</td><td>{{ scenario.status }}</td></tr>
  <tr><td>Approved By</td><td>{{ scenario.approved_by or 'Pending' }}</td></tr>
</table>
<p><strong>Breach Parameters:</strong> {{ scenario.breach_params }}</p>
{% endfor %}

<h2>3. Downstream Impact</h2>

<h3>3.1 Evacuation Priority List</h3>
<table>
  <tr>
    <th>Rank</th><th>Village</th><th>Population</th>
    <th>Arrival Time (min)</th><th>Hazard Class</th><th>Priority Score</th>
  </tr>
  {% for v in priorities %}
  <tr>
    <td>{{ loop.index }}</td>
    <td class="priority-{{ 'high' if v.priority_score > 100 else ('medium' if v.priority_score > 10 else 'low') }}">
      {{ v.village_name }}
    </td>
    <td>{{ v.population }}</td>
    <td>{{ v.arrival_time_min }}</td>
    <td>{{ v.hazard_class | upper }}</td>
    <td>{{ "%.1f" | format(v.priority_score) }}</td>
  </tr>
  {% endfor %}
</table>

<h3>3.2 Road Passability</h3>
<table>
  <tr><th>Status</th><th>Count</th></tr>
  <tr><td>🟢 Safe</td><td>{{ road_summary.safe }}</td></tr>
  <tr><td>🟡 Restricted</td><td>{{ road_summary.restricted }}</td></tr>
  <tr><td>🔴 Impassable</td><td>{{ road_summary.impassable }}</td></tr>
</table>

<h3>3.3 Critical Facilities</h3>
<table>
  <tr><th>Name</th><th>Type</th></tr>
  {% for f in facilities %}
  <tr><td>{{ f.name }}</td><td>{{ f.kind }}</td></tr>
  {% endfor %}
</table>

<h2>4. Response Actions</h2>
<div class="warning">
  <strong>Level 2 — Potential Breach:</strong><br>
  1. Activate EAP communication chain<br>
  2. Pre-position SDRF/NDRF teams at priority villages<br>
  3. Begin evacuation of top-priority settlements<br>
  4. Monitor dam conditions continuously<br>
  5. Prepare for Level 3 escalation<br>
</div>

<div class="danger">
  <strong>Level 3 — Confirmed Breach:</strong><br>
  1. Execute full evacuation of all at-risk areas<br>
  2. Close all downstream roads (impassable segments)<br>
  3. Activate shelter capacity<br>
  4. Establish incident command post<br>
  5. Begin search & rescue staging<br>
</div>

<h2>5. Data Provenance & Limitations</h2>
<table>
  <tr><th>Component</th><th>Details</th></tr>
  <tr><td>DEM Source</td><td>{{ dem_source }} ({{ dem_resolution }}m resolution)</td></tr>
  <tr><td>Quality Grade</td><td>{{ quality_grade }}</td></tr>
  <tr><td>Solver</td><td>{{ solver }} v{{ solver_version }}</td></tr>
  <tr><td>Mass Balance Error</td><td>{{ mass_balance_error }}%</td></tr>
</table>

<div class="disclaimer">
  {{ disclaimer }}
</div>

<div class="footer">
  <p>Generated by DamSafe Twin v{{ version }} — {{ generated_at }}</p>
  <p>This document is for planning and screening purposes only.</p>
  <p>Operational use requires agency-authorized input data, calibrated model parameters,
  surveyed terrain/bathymetry, independent engineering review, and formal EAP approval.</p>
</div>

</body>
</html>
"""


async def generate_eap_report(
    dam_data: dict,
    scenarios_data: list,
    priorities: list,
    road_summary: dict,
    facilities: list,
    sim_data: dict,
    output_format: str = "html",
) -> str:
    """Generate an EAP / incident report as HTML (convertible to PDF via WeasyPrint)."""
    template = Template(EAP_REPORT_TEMPLATE)

    html = template.render(
        dam_name=dam_data.get("name", "Unknown Dam"),
        dam_type=dam_data.get("dam_type", "Unknown"),
        height_m=dam_data.get("height_m", "N/A"),
        crest_length_m=dam_data.get("crest_length_m", "N/A"),
        reservoir_capacity_mcm=dam_data.get("reservoir_capacity_mcm", "N/A"),
        spillway_count=dam_data.get("spillway_count", "N/A"),
        scenarios=scenarios_data,
        priorities=priorities,
        road_summary=road_summary,
        facilities=facilities,
        dem_source=sim_data.get("dem_source", "CartoDEM"),
        dem_resolution=sim_data.get("dem_resolution", 30),
        quality_grade=sim_data.get("quality_grade", "prototype"),
        solver=sim_data.get("solver", "educational_swe"),
        solver_version=sim_data.get("solver_version", "1.0.0"),
        mass_balance_error=sim_data.get("mass_balance_error", "N/A"),
        disclaimer=sim_data.get(
            "disclaimer",
            "This demonstration provides a planning and screening prototype. "
            "Operational use requires agency-authorized input data, calibrated model "
            "parameters, surveyed terrain/bathymetry, independent engineering review, "
            "and formal EAP approval."
        ),
        classification="FOR OFFICIAL USE ONLY — EXERCISE DOCUMENT",
        prepared_date=datetime.utcnow().strftime("%d %B %Y"),
        prepared_by="DamSafe Twin Automated System",
        version="1.0.0",
        generated_at=datetime.utcnow().isoformat(),
    )

    return html


async def html_to_pdf(html_content: str) -> bytes:
    """Convert HTML to PDF using WeasyPrint."""
    from weasyprint import HTML
    pdf = HTML(string=html_content).write_pdf()
    return pdf
