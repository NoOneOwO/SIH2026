"""
DamSafe Twin — dam profile, official documents & explainable condition assessment.

Storage: plain JSON + files under ``backend/data/dam_profiles/<dam_id>/`` (the
same pattern as the local auth store — no DB migration needed for the MVP).

EVIDENCE CLASSES (kept visibly apart everywhere):
    official  — uploaded by a verified official/admin against the dam
    osint     — publicly available information bundled with this prototype;
                clearly labelled, never presented as confirmed structural truth
    modelled  — arithmetic on the two above (completeness, recency counts)

CONDITION ASSESSMENT CONTRACT
-----------------------------
Deterministic rules over documented evidence. Categories:
    LOW_CONCERN / MODERATE_CONCERN / HIGH_CONCERN / INSUFFICIENT_DATA
The result ALWAYS lists the reasoning lines behind it. An earthen dam is never
"unsafe because earthen" — material/type is contextual metadata only. Where
evidence is absent the answer is INSUFFICIENT DATA, never a guess.
"""

from __future__ import annotations

import io
import json
import os
import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.auth.service import CurrentUser, require_role
from app.sandbox.dam_registry import get_dam

router = APIRouter()

# backend/ directory (this file lives directly in backend/app/ — two hops up).
DATA_DIR = Path(__file__).resolve().parents[1] / "data"
PROFILES_DIR = DATA_DIR / "dam_profiles"
ALLOWED_DOCS = {".pdf", ".txt", ".md", ".jpg", ".jpeg", ".png"}
MAX_DOC_BYTES = 10 * 1024 * 1024

DOC_TYPES = {
    "safety_inspection": "Dam safety inspection report",
    "structural_inspection": "Structural inspection report",
    "eap": "Emergency Action Plan",
    "maintenance": "Maintenance report",
    "condition": "Reservoir / dam condition report",
    "incident": "Previous incident report",
    "government": "Government inspection document",
    "technical": "Technical report",
    "other": "Other official documentation",
}

# ── OSINT evidence layer (public information bundled with the prototype) ────
# Each note is clearly labelled osint. Empty for most dams: absence of public
# information is reported as such, never filled with an assessment.
OSINT_NOTES: dict[str, list[dict]] = {
    "d4": [{
        "year": 2021,
        "source": "Public reporting around the 2021 Chamoli disaster prompted review of Uttarakhand large dams",
        "summary": (
            "Tehri Dam (260 m rockfill) has been the subject of extensive public seismic-stability "
            "discussions since the 1990s; no public report of unresolved critical structural defects was found "
            "in the bundled review."
        ),
    }],
    "d28": [{
        "year": 1967,
        "source": "Historical record: Koyna earthquake (M 6.3) close to the dam",
        "summary": (
            "The 1967 Koyna earthquake damaged the jacking gallery; cracks in the rubble concrete zone were "
            "documented publicly and later grouted (per published accounts). Historic evidence, not a current status."
        ),
    }],
}


def _dam_dir(dam_id: str) -> Path:
    p = PROFILES_DIR / dam_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def _profile_path(dam_id: str) -> Path:
    return _dam_dir(dam_id) / "profile.json"


def _docs_path(dam_id: str) -> Path:
    return _dam_dir(dam_id) / "documents.json"


def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# document text extraction + structuring
# ─────────────────────────────────────────────────────────────────────────────

def _extract_text(filename: str, blob: bytes) -> str:
    """Text extraction for PDF/TXT/MD. Images are accepted and stored but not
    OCR'd — the extraction says so instead of pretending."""
    ext = Path(filename).suffix.lower()
    if ext in (".txt", ".md"):
        return blob.decode("utf-8", errors="replace")
    if ext == ".pdf":
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(blob))
            pages = []
            for page in reader.pages[:40]:  # first 40 pages is plenty for structuring
                try:
                    pages.append(page.extract_text() or "")
                except Exception:
                    pages.append("")
            return "\n".join(pages)
        except Exception as e:
            return f"[text extraction failed: {e}]"
    return ""


# Keyword tables for the heuristic structuring. Each finding records the
# matched source quote, so the UI can show the evidence behind it.
ISSUE_KEYWORDS = {
    "seepage": r"\bseep(age|ing)\b",
    "cracking": r"\bcrack(s|ed|ing)?\b",
    "spillway": r"\bspillway\b",
    "settlement": r"\bsettle?ment\b",
    "erosion": r"\berosion\b",
    "gate defect": r"\bgate(s)?\b.*\b(defect|fault|jammed|inoperative|stuck)\b|\b(jammed|inoperative)\b.*\bgate",
    "uplift pressure": r"\buplift\b",
    "concrete deterioration": r"\b(spall|spalling|deteriorat|honeycomb)\w*\b",
    "deformation": r"\bdeform|bulg|displacement\b",
    "instrumentation anomaly": r"\b(piezometer|inclinometer| extensometer|instrument).{0,60}\b(anomal|exceed|alarm|unusual|readings?)\b",
}

CONDITION_PATTERNS = [
    (r"\bcondition\s*(?:rating|index)?\s*[:\-]?\s*(?:is\s*)?(satisfactory|good|fair|poor|unsatisfactory)\b", "reported"),
    (r"\b rated (?:as )?(satisfactory|fair|poor|unsatisfactory)\b", "reported"),
]

RECOMMEND_PATTERNS = [
    r"(?:recommend(?:ed|s|ation)?|should be|needs? to be|requires?)\s+([^.]{15,180})\.",
    r"(?:repair|remediat\w+|grout\w*|replac\w+)\s+(?:of\s+)?([^.]{10,150})\.",
]

INCIDENT_PATTERNS = [
    r"\b(incident|failure|emergency|breach|overtopping|flood release)\b[^.]{10,180}\.",
]

DATE_PATTERNS = [
    r"\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b",
    r"\b(20\d{2})-(\d{2})-(\d{2})\b",
]


def _guess_doc_type(text: str, filename: str) -> str:
    t = text.lower() + " " + filename.lower()
    if re.search(r"\bemergency action plan\b|\beap\b", t):
        return "eap"
    if re.search(r"\bsafety inspection\b", t):
        return "safety_inspection"
    if re.search(r"\bstructural inspection\b|\bstructural review\b", t):
        return "structural_inspection"
    if re.search(r"\bmaintenance\b", t):
        return "maintenance"
    if re.search(r"\bincident\b|\bemergency event\b", t):
        return "incident"
    if re.search(r"\bcondition report\b|\bannual (?:dam )?condition\b", t):
        return "condition"
    if re.search(r"\bgovernment\b|\bCWC\b|\bcentral water commission\b|\bstate authority\b", t):
        return "government"
    if re.search(r"\btechnical\b|\bgeotechnical\b|\binstrumentation\b", t):
        return "technical"
    return "other"


def _find_dates(text: str) -> list[str]:
    out: list[str] = []
    for pat in DATE_PATTERNS:
        for m in re.finditer(pat, text[:20000]):
            out.append(m.group(0))
            if len(out) >= 6:
                return out
    return out


def _find_issues(text: str) -> list[dict]:
    issues = []
    for label, pat in ISSUE_KEYWORDS.items():
        m = re.search(pat, text, flags=re.IGNORECASE)
        if m:
            start = max(0, m.start() - 90)
            quote = re.sub(r"\s+", " ", text[start:m.end() + 110]).strip()
            issues.append({"topic": label, "quote": quote, "evidence": "official"})
    return issues


def _find_recommendations(text: str) -> list[str]:
    out = []
    for pat in RECOMMEND_PATTERNS:
        for m in re.finditer(pat, text, flags=re.IGNORECASE):
            rec = re.sub(r"\s+", " ", m.group(0)).strip()
            if rec and rec not in out:
                out.append(rec)
            if len(out) >= 6:
                return out
    return out


def _find_incidents(text: str) -> list[str]:
    out = []
    for m in re.finditer(INCIDENT_PATTERNS[0], text, flags=re.IGNORECASE):
        s = re.sub(r"\s+", " ", m.group(0)).strip()
        if s not in out:
            out.append(s)
        if len(out) >= 4:
            return out
    return out


def _find_reported_condition(text: str) -> str | None:
    for pat, _src in CONDITION_PATTERNS:
        m = re.search(pat, text, flags=re.IGNORECASE)
        if m:
            return m.group(1).lower()
    return None


def structure_document(filename: str, blob: bytes) -> dict:
    """Heuristic extraction → documented finding set (each with its quote)."""
    text = _extract_text(filename, blob)
    word_count = len(text.split())
    return {
        "doc_type": _guess_doc_type(text, filename),
        "text_chars": len(text),
        "word_count": word_count,
        "extraction": (
            "full-text" if word_count > 80 else
            ("image-only — stored, not OCR'd; no text extracted" if Path(filename).suffix.lower() in (".jpg", ".jpeg", ".png")
             else "little/no machine-readable text found")
        ),
        "dates_found": _find_dates(text),
        "reported_condition": _find_reported_condition(text),
        "issues": _find_issues(text),
        "recommendations": _find_recommendations(text),
        "incidents": _find_incidents(text),
    }


# ─────────────────────────────────────────────────────────────────────────────
# profile + documents CRUD
# ─────────────────────────────────────────────────────────────────────────────

def _check_dam(dam_id: str) -> dict:
    rec = get_dam(dam_id)
    if rec is None:
        raise HTTPException(status_code=404, detail=f"Unknown dam id '{dam_id}'")
    return rec


class ProfileBody(dict):
    pass


@router.get("/{dam_id}/profile")
def get_profile(dam_id: str, user: CurrentUser = Depends(require_role("viewer"))):
    """Registry facts + edited profile + documents + completeness."""
    rec = _check_dam(dam_id)
    profile = _load_json(_profile_path(dam_id), {})
    docs = _load_json(_docs_path(dam_id), [])
    completeness = completeness_score(rec, profile, docs)
    return {
        "dam_id": dam_id,
        "registry": rec,
        "profile": profile,
        "documents": docs,
        "completeness": completeness,
        "osint": OSINT_NOTES.get(dam_id, []),
        "evidence_legend": {
            "official": "Uploaded by a verified official/admin against this dam",
            "osint": "Publicly available information bundled with the prototype — contextual, not confirmed structural truth",
            "modelled": "Derived arithmetic (completeness, recency, counts)",
        },
    }


@router.put("/{dam_id}/profile")
def put_profile(dam_id: str, body: dict, user: CurrentUser = Depends(require_role("analyst"))):
    """Create/update the operational profile. Material/type is stored as
    context only — the assessment never judges safety from it."""
    _check_dam(dam_id)
    allowed = {
        "river_basin", "owner_operator", "material_type", "construction_year",
        "height_m", "crest_length_m", "reservoir_capacity_mcm",
        "spillway_capacity_cumecs", "max_water_level_m", "full_reservoir_level_m",
        "normal_operating_level_m", "current_storage_mcm", "spillway_gates",
        "structural_notes", "operating_notes", "population_downstream_note",
    }
    clean = {k: v for k, v in (body or {}).items() if k in allowed}
    existing = _load_json(_profile_path(dam_id), {})
    existing.update(clean)
    existing["updated_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _save_json(_profile_path(dam_id), existing)
    return {"status": "saved", "profile": existing, "completeness": completeness_score(get_dam(dam_id), existing, _load_json(_docs_path(dam_id), []))}


@router.get("/{dam_id}/documents")
def list_documents(dam_id: str, user: CurrentUser = Depends(require_role("viewer"))):
    _check_dam(dam_id)
    return {"dam_id": dam_id, "total": 0 if not _docs_path(dam_id).exists() else len(_load_json(_docs_path(dam_id), [])),
            "documents": _load_json(_docs_path(dam_id), [])}


def _can_upload(user: CurrentUser, dam_id: str) -> bool:
    """admin/approver/analyst: any dam. official: only their posting dam."""
    if user.role in ("admin", "approver", "analyst"):
        return True
    return user.role == "official" and getattr(user, "dam_id", None) == dam_id


@router.post("/{dam_id}/documents")
async def upload_document(
    dam_id: str,
    file: UploadFile = File(...),
    doc_type: str | None = None,
    user: CurrentUser = Depends(require_role("viewer")),
):
    """Upload an official document (PDF/TXT/MD/JPG/PNG ≤ 10 MB) against the dam.

    Officials may upload for their posting dam; analysts and above for any dam.
    The file is stored, text-extracted and structured (issues, recommendations,
    incidents, reported condition, dates) — each finding keeps its source quote.
    """
    _check_dam(dam_id)
    if not _can_upload(user, dam_id):
        raise HTTPException(
            status_code=403,
            detail="Officials may only upload documents for their posting dam",
        )
    filename = file.filename or "document"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_DOCS:
        raise HTTPException(status_code=400, detail=f"Document type must be one of {sorted(ALLOWED_DOCS)}")
    blob = await file.read()
    if len(blob) > MAX_DOC_BYTES:
        raise HTTPException(status_code=400, detail="Document exceeds 10 MB")

    doc_id = uuid.uuid4().hex[:12]
    safe_name = f"{doc_id}{ext}"
    (_dam_dir(dam_id) / safe_name).write_bytes(blob)
    structured = structure_document(filename, blob)
    doc = {
        "id": doc_id,
        "original_name": filename,
        "stored_name": safe_name,
        "size_bytes": len(blob),
        "uploaded_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "uploaded_by": user.name,
        "uploader_role": user.role,
        "doc_type": doc_type if doc_type in DOC_TYPES else structured["doc_type"],
        "doc_type_label": DOC_TYPES.get(doc_type if doc_type in DOC_TYPES else structured["doc_type"], DOC_TYPES["other"]),
        "evidence": "official",
        **structured,
    }
    docs = _load_json(_docs_path(dam_id), [])
    docs.append(doc)
    _save_json(_docs_path(dam_id), docs)
    return {"status": "stored", "document": doc, "total": len(docs)}


@router.get("/{dam_id}/documents/{doc_id}/file")
def get_document_file(dam_id: str, doc_id: str, user: CurrentUser = Depends(require_role("viewer"))):
    _check_dam(dam_id)
    docs = _load_json(_docs_path(dam_id), [])
    doc = next((d for d in docs if d["id"] == doc_id), None)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    from fastapi.responses import FileResponse

    path = _dam_dir(dam_id) / doc["stored_name"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing from storage")
    return FileResponse(path, filename=doc["original_name"])


# ─────────────────────────────────────────────────────────────────────────────
# completeness (modelled, deterministic)
# ─────────────────────────────────────────────────────────────────────────────

PROFILE_FIELDS = [
    "river_basin", "owner_operator", "material_type", "construction_year",
    "spillway_capacity_cumecs", "max_water_level_m", "full_reservoir_level_m",
]


def completeness_score(registry: dict, profile: dict, docs: list[dict]) -> dict:
    """Data-completeness 0–100: registry facts + profile fields + documents."""
    checks = []
    for field, label in [
        ("type", "Dam type"), ("height_m", "Height"), ("river", "River"),
        ("capacity_mcm", "Reservoir capacity"), ("year_built", "Construction year"),
    ]:
        checks.append((label, registry.get(field) not in (None, "", 0)))
    for field in PROFILE_FIELDS:
        label = field.replace("_", " ").capitalize()
        checks.append((label, profile.get(field) not in (None, "", 0)))
    checks.append(("Any official document", bool(docs)))
    checks.append(("Report from the last 5 years", any(
        (d.get("uploaded_at_utc") or "") >= time.strftime("%Y", time.gmtime()) + "" for d in docs) or any(
        _doc_year(d) and _doc_year(d) >= time.gmtime().tm_year - 5 for d in docs)))
    filled = sum(1 for _, ok in checks if ok)
    pct = round(filled / len(checks) * 100)
    missing = [label for label, ok in checks if not ok]
    return {"score": pct, "filled": filled, "total": len(checks), "missing": missing, "basis": "modelled"}


def _doc_year(doc: dict) -> int | None:
    for d in doc.get("dates_found", []) or []:
        m = re.search(r"(20\d{2})", d)
        if m:
            return int(m.group(1))
    return None


# ─────────────────────────────────────────────────────────────────────────────
# condition assessment (deterministic, explainable)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{dam_id}/condition")
def condition_assessment(dam_id: str, user: CurrentUser = Depends(require_role("viewer"))):
    """Explainable condition/concern assessment from official + OSINT evidence."""
    rec = _check_dam(dam_id)
    profile = _load_json(_profile_path(dam_id), {})
    docs = _load_json(_docs_path(dam_id), [])
    osint = OSINT_NOTES.get(dam_id, [])
    completeness = completeness_score(rec, profile, docs)

    reasons: list[dict] = []
    official = [d for d in docs if d.get("evidence") == "official"]

    if not official and not osint:
        return {
            "dam_id": dam_id,
            "category": "INSUFFICIENT_DATA",
            "headline": "Insufficient data — no official documentation and no bundled public information for this dam.",
            "reasons": [
                "No official document has been uploaded for this dam.",
                "No publicly available information is bundled in the OSINT layer.",
                "Upload a safety inspection, condition or incident report to enable an assessment.",
            ],
            "official_documents": 0,
            "osint_notes": 0,
            "completeness": completeness,
            "evidence_legend": {
                "official": "Uploaded documents only",
                "osint": "Public information, clearly labelled — never confirmed structural truth",
            },
        }

    # Evidence accumulation (official first).
    open_issue_topics: set[str] = set()
    worst_condition: str | None = None
    recent_docs = 0
    this_year = time.gmtime().tm_year
    for d in official:
        yr = _doc_year(d)
        if yr and this_year - yr <= 10 or (d.get("uploaded_at_utc") or "")[:4].isdigit() and this_year - int((d.get("uploaded_at_utc") or "0000")[:4]) <= 10:
            recent_docs += 1
        reasons.append({
            "evidence": "official",
            "text": f"{d['doc_type_label']} uploaded {d['uploaded_at_utc'][:10]} "
                    f"({d['word_count']} words extracted, {len(d.get('issues', []))} issue topic(s) found)"
                    + (f", reported condition: {d['reported_condition']}" if d.get("reported_condition") else ""),
        })
        for i in d.get("issues", []):
            open_issue_topics.add(i["topic"])
            reasons.append({"evidence": "official", "text": f"Reported issue — {i['topic']}: \"{i['quote'][:160]}\""})
        if d.get("reported_condition") in ("poor", "unsatisfactory"):
            worst_condition = "poor"
        elif d.get("reported_condition") in ("fair",) and worst_condition is None:
            worst_condition = "fair"

    for n in osint:
        reasons.append({"evidence": "osint", "text": f"{n['source']} ({n['year']}): {n['summary']}"})

    # Deterministic category rules.
    has_recent_official = recent_docs > 0
    if worst_condition in ("poor", "unsatisfactory"):
        category = "HIGH_CONCERN"
        headline = "High concern — recent official documentation reports poor/unsatisfactory condition."
    elif official and open_issue_topics:
        category = "MODERATE_CONCERN"
        headline = ("Moderate concern — official documentation reports unresolved issue topics ("
                    + ", ".join(sorted(open_issue_topics)) + ").")
    elif official:
        category = "LOW_CONCERN" if has_recent_official else "INSUFFICIENT_DATA"
        headline = (
            "Low concern — official documents on file with no reported issue topics."
            if has_recent_official else
            "Insufficient data — documents exist but none are recent enough to reflect current condition."
        )
    else:
        category = "MODERATE_CONCERN"
        headline = "Moderate concern — no official documentation, but bundled public information warrants review."

    return {
        "dam_id": dam_id,
        "category": category,
        "headline": headline,
        "reasons": reasons,
        "official_documents": len(official),
        "recent_official_documents": recent_docs,
        "osint_notes": len(osint),
        "issue_topics": sorted(open_issue_topics),
        "reported_condition": worst_condition,
        "completeness": completeness,
        "note": (
            "This is an evidence-bookkeeping screen, not a structural safety verdict. Material/type "
            "(e.g. earthen vs concrete) is stored as context and never scored. Categories: "
            "Low Concern / Moderate Concern / High Concern / Insufficient Data."
        ),
        "evidence_legend": {
            "official": "Uploaded documents only",
            "osint": "Public information, clearly labelled — never confirmed structural truth",
        },
    }
