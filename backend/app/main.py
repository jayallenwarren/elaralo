from __future__ import annotations

import os
import time
import re
import uuid
import json
import hashlib
import base64
import asyncio
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from filelock import FileLock  # type: ignore

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

# Threadpool helper (prevents blocking the event loop on requests/azure upload)
from starlette.concurrency import run_in_threadpool  # type: ignore

from .settings import settings
from .models import ChatResponse  # kept for compatibility with existing codebase


# ----------------------------
# Optional consent router
# ----------------------------
try:
    from .consent_routes import router as consent_router  # type: ignore
except Exception:
    consent_router = None


STATUS_SAFE = "safe"
STATUS_BLOCKED = "explicit_blocked"
STATUS_ALLOWED = "explicit_allowed"

app = FastAPI(title="Elaralo API")

# ----------------------------
# CORS
# ----------------------------
# CORS_ALLOW_ORIGINS can be:
#   - comma-separated list of exact origins (e.g. https://elaralo.com,https://www.elaralo.com)
#   - entries with wildcards (e.g. https://*.azurestaticapps.net)
#   - or a single "*" to allow all (NOT recommended for production)
cors_env = (
    os.getenv("CORS_ALLOW_ORIGINS", "")
    or getattr(settings, "CORS_ALLOW_ORIGINS", None)
    or ""
).strip()

def _split_cors_origins(raw: str) -> list[str]:
    """Split + normalize CORS origins from an env var.

    Supports comma and/or whitespace separation.
    Removes trailing slashes (browser Origin never includes a trailing slash).
    De-dupes while preserving order.
    """
    if not raw:
        return []
    tokens = re.split(r"[\s,]+", raw.strip())
    out: list[str] = []
    seen: set[str] = set()
    for t in tokens:
        if not t:
            continue
        t = t.strip()
        if not t:
            continue
        if t != "*" and t.endswith("/"):
            t = t.rstrip("/")
        if t not in seen:
            out.append(t)
            seen.add(t)
    return out

raw_items = _split_cors_origins(cors_env)
allow_all = (len(raw_items) == 1 and raw_items[0] == "*")

allow_origins: list[str] = []
allow_origin_regex: str | None = None
allow_credentials = True

if allow_all:
    # Allow-all is only enabled when explicitly configured via "*".
    allow_origins = ["*"]
    allow_credentials = False  # cannot be True with wildcard
else:
    # Support optional wildcards (e.g., "https://*.azurestaticapps.net").
    literal: list[str] = []
    wildcard: list[str] = []
    for o in raw_items:
        if "*" in o:
            wildcard.append(o)
        else:
            literal.append(o)

    allow_origins = literal

    if wildcard:
        # Convert wildcard origins to a regex.
        parts: list[str] = []
        for w in wildcard:
            parts.append("^" + re.escape(w).replace("\\*", ".*") + "$")
        allow_origin_regex = "|".join(parts)

    # Security-first default: if CORS_ALLOW_ORIGINS is empty, we do NOT allow browser cross-origin calls.
    # (Server-to-server calls without an Origin header still work.)
    if not allow_origins and not allow_origin_regex:
        print("[CORS] WARNING: CORS_ALLOW_ORIGINS is empty. Browser requests from other origins will be blocked.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------
# Routes
# ----------------------------
if consent_router is not None:
    app.include_router(consent_router)


@app.get("/")
def root():
    """
    Minimal root endpoint.

    Azure App Service (Linux) health probes and some monitoring tools will call "/"
    by default. Returning 200 here prevents false "container failed to start" / 502
    notifications when the API itself is healthy but has no root route.
    """
    return {"ok": True, "service": "Elaralo API"}


@app.get("/health")
@app.get("/healthz")
def health():
    """
    Liveness probe.

    Keep this fast and dependency-free (no downstream calls) so platform health checks
    remain reliable during partial outages.
    """
    return {"ok": True}

@app.post("/usage/credit")
async def usage_credit(request: Request):
    """Credit purchased minutes to a member.

    Intended for payment provider webhooks or admin tooling.

    Security:
      - Requires header "X-Admin-Token" matching env var USAGE_ADMIN_TOKEN.

    Body (JSON):
      {
        "member_id": "abc123",
        "minutes": 60
      }
    """
    try:
        raw = await request.json()
    except Exception:
        raw = {}

    token = (request.headers.get("x-admin-token") or request.headers.get("X-Admin-Token") or "").strip()
    if not USAGE_ADMIN_TOKEN or token != USAGE_ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Forbidden")

    member_id = str(raw.get("member_id") or raw.get("memberId") or "").strip()
    minutes = raw.get("minutes") or raw.get("add_minutes") or raw.get("purchased_minutes") or 0

    try:
        minutes_i = int(minutes)
    except Exception:
        minutes_i = 0

    if not member_id or minutes_i <= 0:
        raise HTTPException(status_code=400, detail="member_id and minutes (> 0) are required")

    identity_key = f"member::{member_id}"
    result = await run_in_threadpool(_usage_credit_minutes_sync, identity_key, minutes_i)
    return result


@app.post("/usage/status")
async def usage_status(request: Request):
    """Return remaining minutes for the caller (read-only).

    This endpoint is intentionally separate from /chat so the frontend can answer
    "how many minutes do I have left?" without touching the OpenAI pipeline.
    """
    try:
        raw = await request.json()
    except Exception:
        raw = {}

    session_id = str(raw.get("session_id") or raw.get("sessionId") or "").strip()

    session_state = raw.get("session_state") or raw.get("sessionState") or {}
    if not isinstance(session_state, dict):
        session_state = {}

    member_id = _extract_member_id(session_state)
    plan_name_raw = _extract_plan_name(session_state)

    # RebrandingKey / overrides (same logic as /chat)
    rebranding_key_raw = _extract_rebranding_key(session_state)
    rebranding_parsed = _parse_rebranding_key(rebranding_key_raw) if rebranding_key_raw else {}

    upgrade_link_override = _session_get_str(session_state, "upgrade_link", "upgradeLink") or rebranding_parsed.get("upgrade_link", "")
    pay_go_link_override = _session_get_str(session_state, "pay_go_link", "payGoLink") or rebranding_parsed.get("pay_go_link", "")
    pay_go_price = _session_get_str(session_state, "pay_go_price", "payGoPrice") or rebranding_parsed.get("pay_go_price", "")
    pay_go_minutes_raw = _session_get_str(session_state, "pay_go_minutes", "payGoMinutes") or rebranding_parsed.get("pay_go_minutes", "")
    plan_external = (
        _session_get_str(session_state, "rebranding_plan", "rebrandingPlan", "planExternal", "plan_external")
        or rebranding_parsed.get("plan", "")
    )
    plan_map = _session_get_str(session_state, "elaralo_plan_map", "elaraloPlanMap") or rebranding_parsed.get("elaralo_plan_map", "")
    free_minutes_raw = _session_get_str(session_state, "free_minutes", "freeMinutes") or rebranding_parsed.get("free_minutes", "")
    cycle_days_raw = _session_get_str(session_state, "cycle_days", "cycleDays") or rebranding_parsed.get("cycle_days", "")

    pay_go_minutes = _safe_int(pay_go_minutes_raw)
    free_minutes = _safe_int(free_minutes_raw)
    cycle_days = _safe_int(cycle_days_raw)

    is_trial = not bool(member_id)
    identity_key = f"member::{member_id}" if member_id else f"ip::{_get_client_ip(request) or session_id or 'unknown'}"

    # Prefer using FreeMinutes/CycleDays from RebrandingKey when present.
    minutes_allowed_override: Optional[int] = None
    if free_minutes is not None:
        minutes_allowed_override = free_minutes
    elif plan_map:
        minutes_allowed_override = int(TRIAL_MINUTES) if is_trial else int(_included_minutes_for_plan(plan_map))

    cycle_days_override: Optional[int] = None
    if cycle_days is not None:
        cycle_days_override = cycle_days

    # Plan name used for quota purposes (fallback) should use the mapped plan if provided.
    plan_name_for_limits = plan_map or plan_name_raw

    # Plan label shown to the user should use the external plan name (if provided).
    plan_label_for_messages = plan_external or plan_name_raw

    # For rebranding, construct PAYG_PRICE_TEXT as:
    #   PayGoPrice + " per " + PayGoMinutes + " minutes"
    is_rebranding = bool(rebranding_key_raw or plan_external or plan_map or upgrade_link_override or pay_go_link_override or pay_go_price)

    payg_price_text_override = ""
    if is_rebranding:
        minutes_part = ""
        if pay_go_minutes is not None:
            minutes_part = str(pay_go_minutes)
        else:
            minutes_part = str(pay_go_minutes_raw or "").strip()
        if pay_go_price and minutes_part:
            payg_price_text_override = f"{pay_go_price} per {minutes_part} minutes"

    status = await run_in_threadpool(
        _usage_peek_status_sync,
        identity_key,
        is_trial=is_trial,
        plan_name=plan_name_for_limits,
        minutes_allowed_override=minutes_allowed_override,
        cycle_days_override=cycle_days_override,
    )

    minutes_remaining = int(status.get("minutes_remaining") or 0)
    minutes_allowed = int(status.get("minutes_allowed") or 0)
    minutes_used = int(status.get("minutes_used") or 0)

    resolved_upgrade_url = (upgrade_link_override or "").strip() or UPGRADE_URL
    resolved_payg_pay_url = (pay_go_link_override or "").strip() or PAYG_PAY_URL
    resolved_payg_minutes = int(pay_go_minutes) if pay_go_minutes is not None else int(PAYG_INCREMENT_MINUTES or 0)
    resolved_payg_price_text = (payg_price_text_override or "").strip() or PAYG_PRICE_TEXT

    nice_plan_label = "Free Trial" if is_trial else (plan_label_for_messages or "your plan")

    # Build a short, TTS-friendly answer.
    lines: List[str] = []
    lines.append(f"You have {minutes_remaining} minutes remaining on your {nice_plan_label}.")
    if minutes_allowed > 0:
        lines.append(f"You've used {minutes_used} of {minutes_allowed} included minutes.")

    cycle_days_effective = int(status.get("cycle_days") or 0)
    cycle_resets_in_days = status.get("cycle_resets_in_days")
    if (not is_trial) and cycle_days_effective and isinstance(cycle_resets_in_days, int):
        lines.append(
            f"Your minutes reset every {cycle_days_effective} days. Next reset in about {cycle_resets_in_days} days."
        )

    # If exhausted, include the same paywall guidance you already use in /chat.
    if minutes_remaining <= 0:
        lines.append(
            _usage_paywall_message(
                is_trial=is_trial,
                plan_name=plan_label_for_messages,
                minutes_allowed=minutes_allowed,
                upgrade_url=upgrade_link_override,
                payg_pay_url=pay_go_link_override,
                payg_increment_minutes=pay_go_minutes,
                payg_price_text=payg_price_text_override,
            )
        )
    else:
        # Optional: quick way to add more time
        if resolved_payg_pay_url:
            if resolved_payg_minutes and resolved_payg_price_text:
                lines.append(f"Add {resolved_payg_minutes} minutes ({resolved_payg_price_text}): {resolved_payg_pay_url}")
            else:
                lines.append(f"Add minutes: {resolved_payg_pay_url}")

        if resolved_upgrade_url:
            lines.append(f"Upgrade: {resolved_upgrade_url}")

    reply = "\n".join([ln for ln in lines if str(ln or "").strip()])

    return {
        "ok": bool(status.get("ok")),
        "reply": reply,
        "is_trial": bool(is_trial),
        "plan_name": plan_label_for_messages or ("Trial" if is_trial else ""),
        "minutes_used": minutes_used,
        "minutes_allowed": minutes_allowed,
        "minutes_remaining": minutes_remaining,
        "cycle_days": cycle_days_effective,
        "cycle_resets_in_days": status.get("cycle_resets_in_days"),
        "upgrade_url": resolved_upgrade_url,
        "payg_pay_url": resolved_payg_pay_url,
        "payg_increment_minutes": int(resolved_payg_minutes or 0),
        "payg_price_text": resolved_payg_price_text,
    }


@app.get("/ready")
def ready():
    """
    Readiness probe.

    If you want a stricter readiness check (e.g., verify required env vars),
    add lightweight checks here. For now it mirrors liveness.
    """
    return {"ok": True}
# ----------------------------
# Helpers
# ----------------------------
def _dbg(enabled: bool, *args: Any) -> None:
    if enabled:
        print(*args)


def _now_ts() -> int:
    return int(time.time())


# ----------------------------
# Usage / Minutes limits (Trial + plan quotas)
# ----------------------------
# This feature enforces time budgets for:
# - Visitors without a memberId (Free Trial) using client IP address as identity
# - Members with a memberId (subscription plan minutes + optional purchased minutes)
#
# Storage strategy:
# - A single JSON file on the App Service Linux shared filesystem (/home) so that it survives restarts.
# - A file lock to coordinate writes across gunicorn workers.
#
# NOTE: This is intentionally simple and fail-open (it will not crash the API).
#       If the usage file is unavailable, the system will allow access rather than block.
_USAGE_STORE_PATH = (os.getenv("USAGE_STORE_PATH", "/home/elaralo_usage.json") or "").strip() or "/home/elaralo_usage.json"
_USAGE_LOCK_PATH = _USAGE_STORE_PATH + ".lock"
_USAGE_LOCK = FileLock(_USAGE_LOCK_PATH)

def _env_int(name: str, default: int) -> int:
    try:
        v = os.getenv(name, "")
        if v is None or str(v).strip() == "":
            return int(default)
        return int(str(v).strip())
    except Exception:
        return int(default)

# Minutes for visitors without a memberId
TRIAL_MINUTES = _env_int("TRIAL_MINUTES", 15)

# Included minutes per subscription plan (set these in App Service Configuration)
INCLUDED_MINUTES_FRIEND = _env_int("INCLUDED_MINUTES_FRIEND", 0)
INCLUDED_MINUTES_ROMANTIC = _env_int("INCLUDED_MINUTES_ROMANTIC", 0)
INCLUDED_MINUTES_INTIMATE = _env_int("INCLUDED_MINUTES_INTIMATE", 0)
INCLUDED_MINUTES_PAYG = _env_int("INCLUDED_MINUTES_PAYG", 0)

# Billing/usage tuning (optional)
USAGE_CYCLE_DAYS = _env_int("USAGE_CYCLE_DAYS", 30)  # member usage resets every N days (subscription cycle)
USAGE_IDLE_GRACE_SECONDS = _env_int("USAGE_IDLE_GRACE_SECONDS", 600)  # gaps bigger than this are not charged
USAGE_MAX_BILLABLE_SECONDS_PER_REQUEST = _env_int("USAGE_MAX_BILLABLE_SECONDS_PER_REQUEST", 120)  # cap per chat call

# Pay links (shown to the user when minutes are exhausted)
UPGRADE_URL = (os.getenv("UPGRADE_URL", "") or "").strip()
PAYG_PAY_URL = (os.getenv("PAYG_PAY_URL", "") or "").strip()
PAYG_INCREMENT_MINUTES = _env_int("PAYG_INCREMENT_MINUTES", 60)

# Base Pay-As-You-Go price (e.g., "$4.99"). If PAYG_PRICE_TEXT is not set, we derive it as:
#   "<PAYG_PRICE> per <PAYG_INCREMENT_MINUTES> minutes"
PAYG_PRICE = (os.getenv("PAYG_PRICE", "") or "").strip()
PAYG_PRICE_TEXT = (os.getenv("PAYG_PRICE_TEXT", "") or "").strip()
if not PAYG_PRICE_TEXT and PAYG_PRICE and PAYG_INCREMENT_MINUTES:
    PAYG_PRICE_TEXT = f"{PAYG_PRICE} per {int(PAYG_INCREMENT_MINUTES)} minutes"


# Admin token for server-side minute credits (payment webhook can call this)
USAGE_ADMIN_TOKEN = (os.getenv("USAGE_ADMIN_TOKEN", "") or "").strip()

def _extract_plan_name(session_state: Dict[str, Any]) -> str:
    plan = (
        session_state.get("planName")
        or session_state.get("plan_name")
        or session_state.get("plan")
        or ""
    )
    return str(plan).strip() if plan is not None else ""


def _extract_rebranding_key(session_state: Dict[str, Any]) -> str:
    """Extract the Wix-provided RebrandingKey (preferred) or legacy rebranding string."""
    rk = (
        session_state.get("rebrandingKey")
        or session_state.get("rebranding_key")
        or session_state.get("RebrandingKey")
        or session_state.get("rebranding")  # legacy: brand name only
        or ""
    )
    return str(rk).strip() if rk is not None else ""

def _strip_rebranding_key_label(part: str) -> str:
    """Accept either raw values or labeled values like 'PayGoMinutes: 60'."""
    s = (part or "").strip()
    m = re.match(r"^[A-Za-z0-9_ ()+-]+\s*[:=]\s*(.+)$", s)
    return m.group(1).strip() if m else s

def _parse_rebranding_key(raw: str) -> Dict[str, str]:
    """Parse a '|' separated RebrandingKey.

    Expected order:
      Rebranding|UpgradeLink|PayGoLink|PayGoPrice|PayGoMinutes|Plan|ElaraloPlanMap|FreeMinutes|CycleDays
    """
    v = (raw or "").strip()
    if not v:
        return {}

    # Legacy support: no delimiter -> only brand name
    if "|" not in v:
        return {
            "rebranding": _strip_rebranding_key_label(v),
            "upgrade_link": "",
            "pay_go_link": "",
            "pay_go_price": "",
            "pay_go_minutes": "",
            "plan": "",
            "elaralo_plan_map": "",
            "free_minutes": "",
            "cycle_days": "",
        }

    parts = [_strip_rebranding_key_label(p) for p in v.split("|")]
    parts += [""] * (9 - len(parts))

    (
        rebranding,
        upgrade_link,
        pay_go_link,
        pay_go_price,
        pay_go_minutes,
        plan,
        elaralo_plan_map,
        free_minutes,
        cycle_days,
    ) = parts[:9]

    return {
        "rebranding": str(rebranding or "").strip(),
        "upgrade_link": str(upgrade_link or "").strip(),
        "pay_go_link": str(pay_go_link or "").strip(),
        "pay_go_price": str(pay_go_price or "").strip(),
        "pay_go_minutes": str(pay_go_minutes or "").strip(),
        "plan": str(plan or "").strip(),
        "elaralo_plan_map": str(elaralo_plan_map or "").strip(),
        "free_minutes": str(free_minutes or "").strip(),
        "cycle_days": str(cycle_days or "").strip(),
    }


# ---------------------------------------------------------------------------
# RebrandingKey validation
# ---------------------------------------------------------------------------
# IMPORTANT: RebrandingKey format/field validation is performed upstream in Wix (Velo).
# The API intentionally accepts the RebrandingKey as-is to avoid breaking Wix flows.
#
# If you remove Wix-side validation in the future, you can enable the server-side
# validator below by uncommenting it AND the call site in /chat.
#
# def _validate_rebranding_key_server_side(raw: str) -> Tuple[bool, str]:
#     """Server-side validator for RebrandingKey.
#
#     Expected order:
#       Rebranding|UpgradeLink|PayGoLink|PayGoPrice|PayGoMinutes|Plan|ElaraloPlanMap|FreeMinutes|CycleDays
#     """
#     v = (raw or "").strip()
#     if not v:
#         return True, ""
#
#     # Guardrail: prevent extremely large payloads
#     if len(v) > 2048:
#         return False, "too long"
#
#     # Legacy support: no delimiter => brand name only
#     if "|" not in v:
#         return True, ""
#
#     parts = v.split("|")
#     if len(parts) != 9:
#         return False, f"expected 9 parts, got {len(parts)}"
#
#     rebranding = parts[0].strip()
#     if not rebranding:
#         return False, "missing Rebranding"
#
#     # Validate URLs (when present)
#     def _is_http_url(s: str) -> bool:
#         s = (s or "").strip()
#         if not s:
#             return True
#         return bool(re.match(r"^https?://", s, re.IGNORECASE))
#
#     if not _is_http_url(parts[1]):
#         return False, "UpgradeLink must be http(s) URL"
#     if not _is_http_url(parts[2]):
#         return False, "PayGoLink must be http(s) URL"
#
#     # Validate integers (when present)
#     for name, val in [
#         ("PayGoMinutes", parts[4]),
#         ("FreeMinutes", parts[7]),
#         ("CycleDays", parts[8]),
#     ]:
#         s = (val or "").strip()
#         if not s:
#             continue
#         if not re.fullmatch(r"-?\d+", s):
#             return False, f"{name} must be an integer"
#
#     # Basic price sanity (allow "$5.99", "5.99", "USD 5.99")
#     price = (parts[3] or "").strip()
#     if price and len(price) > 32:
#         return False, "PayGoPrice too long"
#
#     # Basic length checks (defense-in-depth)
#     for i, p in enumerate(parts):
#         if len((p or "").strip()) > 512:
#             return False, f"part {i} too long"
#
#     return True, ""




# ---------------------------------------------------------------------------
# Voice/Video companion capability mappings (SQLite -> in-memory)
# ---------------------------------------------------------------------------
# This database is generated from the Excel mapping sheet ("Voice and Video Mappings - Elaralo.xlsx")
# and shipped alongside the API so the frontend can query companion capabilities at runtime:
#   - which companions are Audio-only vs Video+Audio
#   - which Live provider to use (D-ID vs Stream)
#   - ElevenLabs voice IDs (TTS voice selection)
#   - D-ID Agent IDs / Client Keys (for the D-ID browser SDK)
#
# Design choice:
#   - We load the full table into memory at startup (fast lookups, no per-request DB IO).
#   - The DB is treated as read-only config; updates are made by regenerating the SQLite file
#     and redeploying (or by mounting a new file and restarting).
#
# Default lookup key is (brand, avatar), case-insensitive.

import sqlite3
from urllib.parse import urlparse, parse_qs

_COMPANION_MAPPINGS: Dict[Tuple[str, str], Dict[str, Any]] = {}
_COMPANION_MAPPINGS_LOADED_AT: float | None = None
_COMPANION_MAPPINGS_SOURCE: str = ""


def _norm_key(s: str) -> str:
    return (s or "").strip().lower()


def _candidate_mapping_db_paths() -> List[str]:
    base_dir = os.path.dirname(__file__)
    env_path = (os.getenv("VOICE_VIDEO_DB_PATH", "") or "").strip()
    candidates = [
        env_path,
        os.path.join(base_dir, "voice_video_mappings.sqlite3"),
        os.path.join(base_dir, "data", "voice_video_mappings.sqlite3"),
    ]
    # keep unique, preserve order
    out: List[str] = []
    seen: set[str] = set()
    for p in candidates:
        p = (p or "").strip()
        if not p:
            continue
        if p not in seen:
            out.append(p)
            seen.add(p)
    return out


def _load_companion_mappings_sync() -> None:
    global _COMPANION_MAPPINGS, _COMPANION_MAPPINGS_LOADED_AT, _COMPANION_MAPPINGS_SOURCE

    db_path = ""
    for p in _candidate_mapping_db_paths():
        if os.path.exists(p):
            db_path = p
            break

    if not db_path:
        print("[mappings] WARNING: voice/video mappings DB not found. Video/audio capabilities will fall back to frontend defaults.")
        _COMPANION_MAPPINGS = {}
        _COMPANION_MAPPINGS_LOADED_AT = time.time()
        _COMPANION_MAPPINGS_SOURCE = ""
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT
              brand,
              avatar,
              eleven_voice_name,
              communication,
              eleven_voice_id,
              live,
              did_embed_code,
              did_agent_link,
              did_agent_id,
              did_client_key
            FROM companion_mappings
            """
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    d: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for r in rows:
        brand = str(r["brand"] or "").strip()
        avatar = str(r["avatar"] or "").strip()
        if not brand or not avatar:
            continue
        key = (_norm_key(brand), _norm_key(avatar))
        d[key] = {
            "brand": brand,
            "avatar": avatar,
            "eleven_voice_name": (r["eleven_voice_name"] or "") if r["eleven_voice_name"] is not None else "",
            "communication": (r["communication"] or "") if r["communication"] is not None else "",
            "eleven_voice_id": (r["eleven_voice_id"] or "") if r["eleven_voice_id"] is not None else "",
            "live": (r["live"] or "") if r["live"] is not None else "",
            "did_embed_code": (r["did_embed_code"] or "") if r["did_embed_code"] is not None else "",
            "did_agent_link": (r["did_agent_link"] or "") if r["did_agent_link"] is not None else "",
            "did_agent_id": (r["did_agent_id"] or "") if r["did_agent_id"] is not None else "",
            "did_client_key": (r["did_client_key"] or "") if r["did_client_key"] is not None else "",
        }

    _COMPANION_MAPPINGS = d
    _COMPANION_MAPPINGS_LOADED_AT = time.time()
    _COMPANION_MAPPINGS_SOURCE = db_path
    print(f"[mappings] Loaded {len(_COMPANION_MAPPINGS)} companion mapping rows from {db_path}")


def _lookup_companion_mapping(brand: str, avatar: str) -> Optional[Dict[str, Any]]:
    b = _norm_key(brand) or "elaralo"
    a = _norm_key(avatar)
    if not a:
        return None

    m = _COMPANION_MAPPINGS.get((b, a))
    if m:
        return m

    # fallback brand → Elaralo
    if b != "elaralo":
        m = _COMPANION_MAPPINGS.get(("elaralo", a))
        if m:
            return m

    # final fallback: if someone sends a composite key like "Ashley-Female-...".
    first = a.split("-")[0].strip() if "-" in a else a
    if first and first != a:
        m = _COMPANION_MAPPINGS.get((b, first))
        if m:
            return m
        if b != "elaralo":
            m = _COMPANION_MAPPINGS.get(("elaralo", first))
            if m:
                return m

    return None


@app.on_event("startup")
async def _startup_load_companion_mappings() -> None:
    # Load once at startup; do not block on errors.
    try:
        await run_in_threadpool(_load_companion_mappings_sync)
    except Exception as e:
        print(f"[mappings] ERROR loading companion mappings: {e!r}")


@app.get("/mappings/companion")
async def get_companion_mapping(brand: str = "", avatar: str = "") -> Dict[str, Any]:
    """Lookup a companion mapping row by (brand, avatar).

    Query params:
      - brand: Brand name (e.g., "Elaralo", "DulceMoon")
      - avatar: Avatar first name (e.g., "Jennifer")

    Response:
      {
        found: bool,
        brand: str,
        avatar: str,
        communication: "Audio"|"Video"|"" ,
        live: "D-ID"|"Stream"|"" ,
        elevenVoiceId: str,
        elevenVoiceName: str,
        didAgentId: str,
        didClientKey: str,
        didAgentLink: str,
        didEmbedCode: str,
        loadedAt: <unix seconds> | null,
        source: <db path> | ""
      }
    """
    b = (brand or "").strip()
    a = (avatar or "").strip()

    m = _lookup_companion_mapping(b, a)
    if not m:
        return {
            "found": False,
            "brand": b,
            "avatar": a,
            "communication": "",
            "live": "",
            "elevenVoiceId": "",
            "elevenVoiceName": "",
            "didAgentId": "",
            "didClientKey": "",
            "didAgentLink": "",
            "didEmbedCode": "",
            "loadedAt": _COMPANION_MAPPINGS_LOADED_AT,
            "source": _COMPANION_MAPPINGS_SOURCE,
        }

    return {
        "found": True,
        "brand": str(m.get("brand") or ""),
        "avatar": str(m.get("avatar") or ""),
        "communication": str(m.get("communication") or ""),
        "live": str(m.get("live") or ""),
        "elevenVoiceId": str(m.get("eleven_voice_id") or ""),
        "elevenVoiceName": str(m.get("eleven_voice_name") or ""),
        "didAgentId": str(m.get("did_agent_id") or ""),
        "didClientKey": str(m.get("did_client_key") or ""),
        "didAgentLink": str(m.get("did_agent_link") or ""),
        "didEmbedCode": str(m.get("did_embed_code") or ""),
        "loadedAt": _COMPANION_MAPPINGS_LOADED_AT,
        "source": _COMPANION_MAPPINGS_SOURCE,
    }


# ---------------------------------------------------------------------------
# BeeStreamed: Start WebRTC streams (Live=Stream companions)
# ---------------------------------------------------------------------------
# IMPORTANT:
# - BeeStreamed tokens MUST NOT be exposed to the browser. The frontend calls this endpoint,
#   and the API performs BeeStreamed authentication server-side.
# - Authentication format per BeeStreamed docs:
#     Authorization: Basic base64_encode({token_id}:{secret_key})
# - Start WebRTC stream endpoint:
#     POST https://api.beestreamed.com/events/[EVENT REF]/startwebrtcstream
#
# Docs: https://docs.beestreamed.com/introduction (API Overview / Authentication)


def _extract_beestreamed_event_ref_from_url(stream_url: str) -> str:
    """Best-effort extraction of BeeStreamed event_ref from a viewer URL.

    This is intentionally flexible because BeeStreamed viewer URLs can be customized.
    We attempt, in order:
      1) query string parameters: event_ref / eventRef
      2) last path segment that looks like an alphanumeric ref (6-32 chars)
    """
    u = (stream_url or "").strip()
    if not u:
        return ""

    try:
        parsed = urlparse(u)
    except Exception:
        return ""

    try:
        qs = parse_qs(parsed.query or "")
        for k in ("event_ref", "eventRef", "event", "ref"):
            v = qs.get(k)
            if v and isinstance(v, list) and v[0]:
                cand = str(v[0]).strip()
                if re.fullmatch(r"[A-Za-z0-9]{6,32}", cand):
                    return cand
    except Exception:
        pass

    # Path fallback
    try:
        segments = [s for s in (parsed.path or "").split("/") if s]
        for seg in reversed(segments):
            seg = seg.strip()
            if re.fullmatch(r"[A-Za-z0-9]{6,32}", seg):
                return seg
    except Exception:
        pass

    return ""


@app.post("/stream/beestreamed/start")
async def beestreamed_start_webrtc(request: Request) -> Dict[str, Any]:
    """Start a BeeStreamed WebRTC stream for the configured event.

    Body (JSON):
      {
        "stream_url": "https://..."     (optional; used to derive event_ref)
        "event_ref": "abcd12345678"    (optional; overrides URL parsing)
      }

    Env vars (server-side only):
      STREAM_TOKEN_ID
      STREAM_SECRET_KEY
    """
    try:
        raw = await request.json()
    except Exception:
        raw = {}

    stream_url = str(raw.get("stream_url") or raw.get("streamUrl") or "").strip()
    event_ref = str(raw.get("event_ref") or raw.get("eventRef") or "").strip()

    if not event_ref:
        event_ref = _extract_beestreamed_event_ref_from_url(stream_url)

    # Optional server-side fallback (useful when the viewer URL does not contain the event_ref).
    if not event_ref:
        event_ref = (os.getenv("STREAM_EVENT_REF", "") or "").strip()

    if not event_ref:
        raise HTTPException(
            status_code=400,
            detail="BeeStreamed event_ref is required (provide event_ref, STREAM_EVENT_REF, or a stream_url containing it).",
        )

    token_id = (os.getenv("STREAM_TOKEN_ID", "") or "").strip()
    secret_key = (os.getenv("STREAM_SECRET_KEY", "") or "").strip()

    if not token_id or not secret_key:
        raise HTTPException(status_code=500, detail="STREAM_TOKEN_ID / STREAM_SECRET_KEY are not configured")

    # BeeStreamed auth header: Basic base64(token_id:secret_key)
    basic = base64.b64encode(f"{token_id}:{secret_key}".encode("utf-8")).decode("utf-8")
    headers = {"Authorization": f"Basic {basic}"}

    api_url = f"https://api.beestreamed.com/events/{event_ref}/startwebrtcstream"

    import requests  # type: ignore

    try:
        r = requests.post(api_url, headers=headers, timeout=20)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"BeeStreamed request failed: {e!r}")

    if r.status_code >= 400:
        msg = (r.text or "").strip()
        raise HTTPException(status_code=r.status_code, detail=f"BeeStreamed error {r.status_code}: {msg[:500]}")

    try:
        data = r.json()
    except Exception:
        data = {"message": (r.text or "").strip(), "status": r.status_code}

    return {"ok": True, "event_ref": event_ref, "beestreamed": data}

def _safe_int(val: Any) -> Optional[int]:
    """Parse an int from strings like '60', ' 60 ', or 'PayGoMinutes: 60'. Returns None if missing/invalid."""
    try:
        if val is None:
            return None
        s = str(val).strip()
        if not s:
            return None
        m = re.search(r"-?\d+", s)
        if not m:
            return None
        return int(m.group(0))
    except Exception:
        return None

def _session_get_str(session_state: Dict[str, Any], *keys: str) -> str:
    for k in keys:
        try:
            v = session_state.get(k)
        except Exception:
            v = None
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return ""

def _normalize_plan_name_for_limits(plan_name: str) -> str:
    p = (plan_name or "").strip()
    if not p:
        return ""
    # Normalize "Test - X" plans to X for quota purposes
    if p.lower().startswith("test - "):
        p = p[7:].strip()
    return p

def _included_minutes_for_plan(plan_name: str) -> int:
    p = _normalize_plan_name_for_limits(plan_name).lower()

    if p == "friend":
        return INCLUDED_MINUTES_FRIEND
    if p == "romantic":
        return INCLUDED_MINUTES_ROMANTIC
    if p == "intimate (18+)":
        return INCLUDED_MINUTES_INTIMATE
    if p == "pay as you go":
        return INCLUDED_MINUTES_PAYG
    # Unknown / not provided -> 0 included minutes
    return 0

def _get_client_ip(request: Request) -> str:
    # Azure front-ends commonly set x-forwarded-for with a comma-separated chain.
    xff = (request.headers.get("x-forwarded-for") or "").strip()
    if xff:
        return xff.split(",")[0].strip()
    rip = (request.headers.get("x-real-ip") or "").strip()
    if rip:
        return rip
    cip = (request.headers.get("x-client-ip") or "").strip()
    if cip:
        return cip
    try:
        return str(getattr(request.client, "host", "") or "").strip()
    except Exception:
        return ""

def _load_usage_store() -> Dict[str, Any]:
    try:
        if not os.path.isfile(_USAGE_STORE_PATH):
            return {}
        with open(_USAGE_STORE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}

def _save_usage_store(store: Dict[str, Any]) -> None:
    try:
        folder = os.path.dirname(_USAGE_STORE_PATH) or "."
        os.makedirs(folder, exist_ok=True)
        tmp = _USAGE_STORE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(store, f)
        os.replace(tmp, _USAGE_STORE_PATH)
    except Exception:
        # Fail-open: do not crash the API
        return

def _usage_paywall_message(
    is_trial: bool,
    plan_name: str,
    minutes_allowed: int,
    *,
    upgrade_url: str = "",
    payg_pay_url: str = "",
    payg_increment_minutes: Optional[int] = None,
    payg_price_text: str = "",
) -> str:
    """Generate the user-facing message when minutes are exhausted.

    Supports per-request overrides (RebrandingKey) for:
      - upgrade_url
      - payg_pay_url
      - payg_increment_minutes
      - payg_price_text
    """
    # Keep this short and plain so it can be spoken via TTS.
    lines: List[str] = []

    resolved_upgrade_url = (upgrade_url or "").strip() or UPGRADE_URL
    resolved_payg_pay_url = (payg_pay_url or "").strip() or PAYG_PAY_URL
    resolved_payg_minutes = (
        int(payg_increment_minutes) if payg_increment_minutes is not None else int(PAYG_INCREMENT_MINUTES or 0)
    )
    resolved_payg_price_text = (payg_price_text or "").strip() or PAYG_PRICE_TEXT

    if is_trial:
        lines.append(f"Your Free Trial time has ended ({minutes_allowed} minutes).")
    else:
        nice_plan = (plan_name or "").strip()
        if not nice_plan:
            lines.append("Your membership plan is Unknown / Not Provided, so minutes cannot be allocated.")
        else:
            lines.append(f"You have no minutes remaining for your plan ({nice_plan}).")

    if resolved_payg_pay_url and resolved_payg_minutes > 0:
        price_part = f" ({resolved_payg_price_text})" if resolved_payg_price_text else ""
        lines.append(f"Add {resolved_payg_minutes} minutes{price_part}: {resolved_payg_pay_url}")

    if resolved_upgrade_url:
        lines.append(f"Upgrade your membership: {resolved_upgrade_url}")

    lines.append("Once you have more minutes, come back here and continue our conversation.")
    return " ".join([ln.strip() for ln in lines if ln.strip()])
def _usage_charge_and_check_sync(identity_key: str, *, is_trial: bool, plan_name: str, minutes_allowed_override: Optional[int] = None, cycle_days_override: Optional[int] = None) -> Tuple[bool, Dict[str, Any]]:
    """Charge usage time and determine whether the identity still has minutes.

    Returns:
      (ok, info)
        ok: True if allowed to continue, False if minutes exhausted.
        info: includes minutes_used / minutes_allowed / minutes_remaining for optional UI/debug.
    """
    now = time.time()
    try:
        with _USAGE_LOCK:
            store = _load_usage_store()
            rec = store.get(identity_key)
            if not isinstance(rec, dict):
                rec = {}

            # Initialize record
            used_seconds = float(rec.get("used_seconds") or 0.0)
            purchased_seconds = float(rec.get("purchased_seconds") or 0.0)
            last_seen = rec.get("last_seen")
            cycle_start = float(rec.get("cycle_start") or now)

            # Member cycle reset (trial does not reset)
            cycle_days = int(cycle_days_override) if cycle_days_override is not None else int(USAGE_CYCLE_DAYS or 0)
            if not is_trial and cycle_days and cycle_days > 0:
                cycle_len = float(cycle_days) * 86400.0
                if (now - cycle_start) >= cycle_len:
                    used_seconds = 0.0
                    cycle_start = now

            # Charge time since last chat call (capped)
            delta = 0.0
            if last_seen is not None:
                try:
                    delta = float(now - float(last_seen))
                except Exception:
                    delta = 0.0

            if delta < 0:
                delta = 0.0

            # Don't charge long idle gaps (prevents "went AFK" from burning minutes)
            if USAGE_IDLE_GRACE_SECONDS and delta > float(USAGE_IDLE_GRACE_SECONDS):
                delta = 0.0

            # Cap per-request billable time
            max_bill = float(USAGE_MAX_BILLABLE_SECONDS_PER_REQUEST) if USAGE_MAX_BILLABLE_SECONDS_PER_REQUEST > 0 else 0.0
            if max_bill and delta > max_bill:
                delta = max_bill

            used_seconds += delta

            # Compute allowed seconds
            if minutes_allowed_override is not None:
                try:
                    minutes_allowed = max(0, int(minutes_allowed_override))
                except Exception:
                    minutes_allowed = 0
            else:
                minutes_allowed = int(TRIAL_MINUTES) if is_trial else int(_included_minutes_for_plan(plan_name))
            allowed_seconds = (float(minutes_allowed) * 60.0) + float(purchased_seconds or 0.0)

            # Persist record
            rec_out = {
                "used_seconds": used_seconds,
                "purchased_seconds": purchased_seconds,
                "last_seen": now,
                "cycle_start": cycle_start,
                "plan_name": plan_name,
                "is_trial": bool(is_trial),
            }
            store[identity_key] = rec_out
            _save_usage_store(store)

        remaining_seconds = max(0.0, allowed_seconds - used_seconds)
        ok = remaining_seconds > 0.0

        return ok, {
            "minutes_used": int(used_seconds // 60),
            "minutes_allowed": int(minutes_allowed),
            "minutes_remaining": int(remaining_seconds // 60),
            "identity_key": identity_key,
        }
    except Exception:
        # Fail-open
        return True, {"minutes_used": 0, "minutes_allowed": 0, "minutes_remaining": 0, "identity_key": identity_key}


def _usage_peek_status_sync(
    identity_key: str,
    *,
    is_trial: bool,
    plan_name: str,
    minutes_allowed_override: Optional[int] = None,
    cycle_days_override: Optional[int] = None,
) -> Dict[str, Any]:
    """Return usage status WITHOUT persisting.

    IMPORTANT:
      - Does NOT update last_seen
      - Does NOT write used_seconds back to the store
      - Computes a *projected* remaining time as-if a chat call happened "now"
        (so the number matches what /chat would enforce), but it is read-only.
    """
    now = time.time()
    try:
        with _USAGE_LOCK:
            store = _load_usage_store()
            rec = store.get(identity_key)
            if not isinstance(rec, dict):
                rec = {}

            used_seconds = float(rec.get("used_seconds") or 0.0)
            purchased_seconds = float(rec.get("purchased_seconds") or 0.0)
            last_seen = rec.get("last_seen")
            cycle_start = float(rec.get("cycle_start") or now)

            # Member cycle reset (trial does not reset)
            cycle_days = int(cycle_days_override) if cycle_days_override is not None else int(USAGE_CYCLE_DAYS or 0)
            cycle_reset_applied = False
            if not is_trial and cycle_days and cycle_days > 0:
                cycle_len = float(cycle_days) * 86400.0
                if (now - cycle_start) >= cycle_len:
                    used_seconds = 0.0
                    cycle_start = now
                    cycle_reset_applied = True

            # Compute the same billable delta that /chat would apply,
            # but do NOT persist it.
            delta = 0.0
            if last_seen is not None:
                try:
                    delta = float(now - float(last_seen))
                except Exception:
                    delta = 0.0

            if delta < 0:
                delta = 0.0

            # Don't charge long idle gaps (prevents "went AFK" from burning minutes)
            if USAGE_IDLE_GRACE_SECONDS and delta > float(USAGE_IDLE_GRACE_SECONDS):
                delta = 0.0

            # Cap per-request billable time
            max_bill = (
                float(USAGE_MAX_BILLABLE_SECONDS_PER_REQUEST)
                if USAGE_MAX_BILLABLE_SECONDS_PER_REQUEST > 0
                else 0.0
            )
            if max_bill and delta > max_bill:
                delta = max_bill

            projected_used_seconds = used_seconds + delta

        # Compute allowed seconds
        if minutes_allowed_override is not None:
            try:
                minutes_allowed = max(0, int(minutes_allowed_override))
            except Exception:
                minutes_allowed = 0
        else:
            minutes_allowed = int(TRIAL_MINUTES) if is_trial else int(_included_minutes_for_plan(plan_name))
        allowed_seconds = (float(minutes_allowed) * 60.0) + float(purchased_seconds or 0.0)

        remaining_seconds = max(0.0, allowed_seconds - projected_used_seconds)
        ok = remaining_seconds > 0.0

        cycle_resets_in_days: Optional[int] = None
        if not is_trial and cycle_days and cycle_days > 0:
            cycle_end = float(cycle_start) + (float(cycle_days) * 86400.0)
            cycle_resets_in_days = int(max(0.0, cycle_end - now) // 86400)

        return {
            "ok": ok,
            "minutes_used": int(projected_used_seconds // 60),
            "minutes_allowed": int(minutes_allowed),
            "minutes_remaining": int(remaining_seconds // 60),
            "purchased_minutes": int(float(purchased_seconds or 0.0) // 60),
            "identity_key": identity_key,
            "cycle_days": int(cycle_days or 0),
            "cycle_resets_in_days": cycle_resets_in_days,
            "cycle_reset_applied": bool(cycle_reset_applied),
        }
    except Exception:
        # Fail-open
        return {
            "ok": True,
            "minutes_used": 0,
            "minutes_allowed": 0,
            "minutes_remaining": 0,
            "purchased_minutes": 0,
            "identity_key": identity_key,
            "cycle_days": int(cycle_days_override or 0),
            "cycle_resets_in_days": None,
            "cycle_reset_applied": False,
        }


def _usage_credit_minutes_sync(identity_key: str, minutes: int) -> Dict[str, Any]:
    """Add purchased minutes to an identity record (used by payment webhooks/admin tooling)."""
    now = time.time()
    try:
        minutes_i = int(minutes)
        if minutes_i <= 0:
            return {"ok": False, "error": "minutes must be > 0", "identity_key": identity_key}

        with _USAGE_LOCK:
            store = _load_usage_store()
            rec = store.get(identity_key)
            if not isinstance(rec, dict):
                rec = {}

            purchased_seconds = float(rec.get("purchased_seconds") or 0.0)
            purchased_seconds += float(minutes_i) * 60.0

            rec["purchased_seconds"] = purchased_seconds
            rec.setdefault("used_seconds", float(rec.get("used_seconds") or 0.0))
            rec.setdefault("cycle_start", float(rec.get("cycle_start") or now))
            rec.setdefault("last_seen", float(rec.get("last_seen") or now))
            rec["plan_name"] = rec.get("plan_name") or "Pay as You Go"

            store[identity_key] = rec
            _save_usage_store(store)

        return {
            "ok": True,
            "identity_key": identity_key,
            "minutes_added": minutes_i,
            "purchased_minutes_total": int(purchased_seconds // 60),
        }
    except Exception:
        return {"ok": False, "identity_key": identity_key}


def _normalize_mode(raw: str) -> str:
    t = (raw or "").strip().lower()
    # allow some synonyms from older frontend builds
    if t in {"explicit", "intimate", "18+", "adult"}:
        return "intimate"
    if t in {"romance", "romantic"}:
        return "romantic"
    return "friend"


def _detect_mode_switch_from_text(text: str) -> Optional[str]:
    t = (text or "").lower().strip()

    # explicit hints: allow [mode:romantic] etc
    if "mode:friend" in t or "[mode:friend]" in t:
        return "friend"
    if "mode:romantic" in t or "[mode:romantic]" in t:
        return "romantic"
    if (
        "mode:intimate" in t
        or "[mode:intimate]" in t
        or "mode:explicit" in t
        or "[mode:explicit]" in t
    ):
        return "intimate"

    # soft detection (more natural language coverage)
    # friend
    if any(p in t for p in [
        "switch to friend",
        "go to friend",
        "back to friend",
        "friend mode",
        "set friend",
        "set mode to friend",
        "turn on friend",
    ]):
        return "friend"

    # romantic
    if any(p in t for p in [
        "switch to romantic",
        "go to romantic",
        "back to romantic",
        "romantic mode",
        "set romantic",
        "set mode to romantic",
        "turn on romantic",
        "let's be romantic",
    ]):
        return "romantic"

    # intimate/explicit
    if any(p in t for p in [
        "switch to intimate",
        "go to intimate",
        "back to intimate",
        "intimate mode",
        "set intimate",
        "set mode to intimate",
        "turn on intimate",
        "switch to explicit",
        "explicit mode",
        "set explicit",
        "set mode to explicit",
        "turn on explicit",
    ]):
        return "intimate"

    return None


def _looks_intimate(text: str) -> bool:
    t = (text or "").lower()
    return any(
        k in t
        for k in [
            "explicit", "intimate", "nsfw", "sex", "nude", "porn",
            "fuck", "cock", "pussy", "blowjob", "anal", "orgasm",
        ]
    )


def _parse_companion_meta(raw: Any) -> Dict[str, str]:
    if isinstance(raw, str):
        # Companion keys may include additional metadata after a pipe, e.g.:
        #   "Elara-Female-Caucasian-GenZ|live=stream"
        # For persona generation we only want the base identity.
        base = raw.split("|", 1)[0].strip()
        parts = [p.strip() for p in base.split("-") if p.strip()]
        if len(parts) >= 4:
            return {
                "first_name": parts[0],
                "gender": parts[1],
                "ethnicity": parts[2],
                "generation": "-".join(parts[3:]),
            }
    return {"first_name": "", "gender": "", "ethnicity": "", "generation": ""}



def _build_persona_system_prompt(session_state: dict, *, mode: str, intimate_allowed: bool) -> str:
    comp = _parse_companion_meta(
        session_state.get("companion")
        or session_state.get("companionName")
        or session_state.get("companion_name")
    )
    name = comp.get("first_name") or "Elara"

    lines = [
        f"You are {name}, an AI companion who is warm, attentive, and emotionally intelligent.",
        "You speak naturally and conversationally.",
        "You prioritize consent, safety, and emotional connection.",
    ]

    if mode == "romantic":
        lines.append("You may be affectionate and flirty while remaining respectful.")

    if mode == "intimate" and intimate_allowed:
        lines.append(
            "The user has consented to Intimate (18+) conversation. "
            "You may engage in adult, sensual discussion, but avoid graphic or pornographic detail. "
            "Focus on intimacy, emotion, and connection."
        )

    return " ".join(lines)


def _to_openai_messages(
    messages: List[Dict[str, str]],
    session_state: dict,
    *,
    mode: str,
    intimate_allowed: bool,
    debug: bool
):
    sys = _build_persona_system_prompt(session_state, mode=mode, intimate_allowed=intimate_allowed)
    _dbg(debug, "SYSTEM PROMPT:", sys)

    out = [{"role": "system", "content": sys}]
    for m in messages:
        if m.get("role") in ("user", "assistant"):
            out.append({"role": m["role"], "content": m.get("content", "")})
    return out


def _call_gpt4o(messages: List[Dict[str, str]]) -> str:
    from openai import OpenAI

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model=os.getenv("OPENAI_MODEL", "gpt-4o"),
        messages=messages,
        temperature=float(os.getenv("OPENAI_TEMPERATURE", "0.8")),
    )
    return (resp.choices[0].message.content or "").strip()



def _call_gpt4o_summary(messages: List[Dict[str, str]]) -> str:
    """Summarization call with conservative limits for reliability."""
    from openai import OpenAI

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    timeout_s = float(os.getenv("SAVE_SUMMARY_OPENAI_TIMEOUT_S", "25") or "25")
    client = OpenAI(api_key=api_key, timeout=timeout_s)
    resp = client.chat.completions.create(
        model=os.getenv("OPENAI_MODEL", "gpt-4o"),
        messages=messages,
        temperature=float(os.getenv("SAVE_SUMMARY_TEMPERATURE", "0.2") or "0.2"),
        max_tokens=int(os.getenv("SAVE_SUMMARY_MAX_TOKENS", "350") or "350"),
    )
    return (resp.choices[0].message.content or "").strip()

def _normalize_payload(raw: Dict[str, Any]) -> Tuple[str, List[Dict[str, str]], Dict[str, Any], bool]:
    sid = raw.get("session_id") or raw.get("sid")
    msgs = raw.get("messages") or []
    state = raw.get("session_state") or {}
    wants = bool(raw.get("wants_explicit"))

    if not sid or not isinstance(sid, str):
        raise HTTPException(422, "session_id required")
    if not msgs or not isinstance(msgs, list):
        raise HTTPException(422, "messages required")
    if not isinstance(state, dict):
        state = {}

    return sid, msgs, state, wants


def _extract_voice_id(raw: Dict[str, Any]) -> str:
    """
    Supports both snake_case and camelCase for frontend convenience.
    """
    return (
        (raw.get("voice_id") or raw.get("voiceId") or raw.get("eleven_voice_id") or raw.get("elevenVoiceId") or "")
    ).strip()


# ----------------------------
# TTS Helpers (ElevenLabs -> Azure Blob SAS)
# ----------------------------
_TTS_CONTAINER = os.getenv("AZURE_TTS_CONTAINER", os.getenv("AZURE_STORAGE_CONTAINER", "tts")) or "tts"
_TTS_BLOB_PREFIX = os.getenv("TTS_BLOB_PREFIX", "audio") or "audio"
_TTS_SAS_MINUTES = int(os.getenv("TTS_SAS_MINUTES", os.getenv("AZURE_BLOB_SAS_EXPIRY_MINUTES", "30")) or "30")

# TTS cache (Azure Blob) — deterministic blob names to avoid regenerating identical audio.
# Enabled by default. Disable by setting TTS_CACHE_ENABLED=0.
_TTS_CACHE_ENABLED = (os.getenv("TTS_CACHE_ENABLED", "1") or "1").strip().lower() not in {"0", "false", "no", "off"}
# Cache blobs live under this prefix within the same container.
_TTS_CACHE_PREFIX = (os.getenv("TTS_CACHE_PREFIX", "tts_cache") or "tts_cache").strip().strip("/")
# Whether to normalize whitespace in TTS text before hashing.
_TTS_CACHE_NORMALIZE_WS = (os.getenv("TTS_CACHE_NORMALIZE_WS", "1") or "1").strip().lower() not in {"0", "false", "no", "off"}


def _normalize_tts_text_for_cache(text: str) -> str:
    t = (text or "").strip()
    if _TTS_CACHE_NORMALIZE_WS:
        t = re.sub(r"\s+", " ", t)
    return t


def _tts_cache_blob_name(voice_id: str, text: str) -> str:
    """Deterministic blob name for caching across sessions and workers."""
    safe_voice = re.sub(r"[^A-Za-z0-9_-]", "_", (voice_id or "voice"))[:48]

    model_id = (os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2") or "eleven_multilingual_v2").strip()
    output_format = (os.getenv("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128") or "mp3_44100_128").strip()
    silence = str(_TTS_LEADING_SILENCE_COPIES)

    norm_text = _normalize_tts_text_for_cache(text)
    h = hashlib.sha256(
        (safe_voice + "|" + model_id + "|" + output_format + "|" + silence + "|" + norm_text).encode("utf-8")
    ).hexdigest()[:40]

    # Keep under a predictable prefix; safe_voice helps partition blobs for listing/debug.
    return f"{_TTS_CACHE_PREFIX}/{safe_voice}/{h}.mp3"




# 235ms silent MP3 prefix used to prevent some clients (notably iOS/Safari in embedded contexts)
# from clipping the first ~200ms of audio when switching from microphone capture to playback.
# You can tune this without redeploying frontend by setting TTS_LEADING_SILENCE_COPIES (0,1,2...).
_SILENT_MP3_PREFIX_B64 = "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU5LjI3LjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAJAAAEXgBBQUFBQUFBQUFBQVlZWVlZWVlZWVlZcXFxcXFxcXFxcXGIiIiIiIiIiIiIiKCgoKCgoKCgoKCguLi4uLi4uLi4uLjQ0NDQ0NDQ0NDQ0Ojo6Ojo6Ojo6Ojo//////////////8AAAAATGF2YzU5LjM3AAAAAAAAAAAAAAAAJAPMAAAAAAAABF6gwS6ZAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVf/7EMQpg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVV//sQxFMDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVX/+xDEfIPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMSmA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxM+DwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU="
_SILENT_MP3_PREFIX_BYTES = base64.b64decode(_SILENT_MP3_PREFIX_B64)
_TTS_LEADING_SILENCE_COPIES = max(0, int(os.getenv("TTS_LEADING_SILENCE_COPIES", "1") or "1"))

def _tts_blob_name(session_id: str, voice_id: str, text: str) -> str:
    safe_session = re.sub(r"[^A-Za-z0-9_-]", "_", (session_id or "session"))[:64]
    safe_voice = re.sub(r"[^A-Za-z0-9_-]", "_", (voice_id or "voice"))[:48]
    h = hashlib.sha1((safe_voice + "|" + (text or "")).encode("utf-8")).hexdigest()[:16]
    ts_ms = int(time.time() * 1000)
    # include hash for debugging/caching, but still unique by timestamp
    return f"{_TTS_BLOB_PREFIX}/{safe_session}/{ts_ms}-{h}-{uuid.uuid4().hex}.mp3"


def _elevenlabs_tts_mp3_bytes(voice_id: str, text: str) -> bytes:
    import requests  # type: ignore

    xi_api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not xi_api_key:
        raise RuntimeError("ELEVENLABS_API_KEY is not configured")

    model_id = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2").strip() or "eleven_multilingual_v2"
    output_format = os.getenv("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128").strip() or "mp3_44100_128"

    # Using /stream tends to be lower latency on ElevenLabs.
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format={output_format}"
    headers = {
        "xi-api-key": xi_api_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    body = {"text": text, "model_id": model_id}

    r = requests.post(url, headers=headers, json=body, timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"ElevenLabs error {r.status_code}: {(r.text or '')[:400]}")
    if not r.content:
        raise RuntimeError("ElevenLabs returned empty audio")
    audio_bytes = r.content
    if _TTS_LEADING_SILENCE_COPIES:
        audio_bytes = (_SILENT_MP3_PREFIX_BYTES * _TTS_LEADING_SILENCE_COPIES) + audio_bytes
    return audio_bytes




def _azure_blob_sas_url(blob_name: str) -> str:
    """Create a read-only SAS URL for an existing blob name in the TTS container."""
    from azure.storage.blob import BlobServiceClient  # type: ignore
    from azure.storage.blob import BlobSasPermissions, generate_blob_sas  # type: ignore

    storage_conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "").strip()
    if not storage_conn_str:
        raise RuntimeError("AZURE_STORAGE_CONNECTION_STRING is not configured")

    blob_service = BlobServiceClient.from_connection_string(storage_conn_str)
    container_client = blob_service.get_container_client(_TTS_CONTAINER)
    blob_client = container_client.get_blob_client(blob_name)

    # Parse AccountName/AccountKey from connection string for SAS
    parts: Dict[str, str] = {}
    for seg in storage_conn_str.split(";"):
        if "=" in seg:
            k, v = seg.split("=", 1)
            parts[k] = v
    account_name = parts.get("AccountName") or getattr(blob_service, "account_name", None)
    account_key = parts.get("AccountKey")
    if not account_name or not account_key:
        raise RuntimeError("Could not parse AccountName/AccountKey from AZURE_STORAGE_CONNECTION_STRING")

    expiry = datetime.utcnow() + timedelta(minutes=max(5, min(_TTS_SAS_MINUTES, 24 * 60)))
    sas = generate_blob_sas(
        account_name=account_name,
        container_name=_TTS_CONTAINER,
        blob_name=blob_name,
        account_key=account_key,
        permission=BlobSasPermissions(read=True),
        expiry=expiry,
    )
    return f"{blob_client.url}?{sas}"
def _azure_upload_mp3_and_get_sas_url(blob_name: str, mp3_bytes: bytes) -> str:
    from azure.storage.blob import BlobServiceClient, ContentSettings  # type: ignore
    from azure.storage.blob import BlobSasPermissions, generate_blob_sas  # type: ignore

    storage_conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "").strip()
    if not storage_conn_str:
        raise RuntimeError("AZURE_STORAGE_CONNECTION_STRING is not configured")

    blob_service = BlobServiceClient.from_connection_string(storage_conn_str)
    container_client = blob_service.get_container_client(_TTS_CONTAINER)

    # Ensure container exists (safe)
    try:
        container_client.get_container_properties()
    except Exception:
        try:
            container_client.create_container()
        except Exception:
            pass

    blob_client = container_client.get_blob_client(blob_name)
    blob_client.upload_blob(
        mp3_bytes,
        overwrite=True,
        content_settings=ContentSettings(content_type="audio/mpeg"),
    )

    # Parse AccountName/AccountKey from connection string for SAS
    parts: Dict[str, str] = {}
    for seg in storage_conn_str.split(";"):
        if "=" in seg:
            k, v = seg.split("=", 1)
            parts[k] = v
    account_name = parts.get("AccountName") or getattr(blob_service, "account_name", None)
    account_key = parts.get("AccountKey")
    if not account_name or not account_key:
        raise RuntimeError("Could not parse AccountName/AccountKey from AZURE_STORAGE_CONNECTION_STRING")

    expiry = datetime.utcnow() + timedelta(minutes=max(5, min(_TTS_SAS_MINUTES, 24 * 60)))
    sas = generate_blob_sas(
        account_name=account_name,
        container_name=_TTS_CONTAINER,
        blob_name=blob_name,
        account_key=account_key,
        permission=BlobSasPermissions(read=True),
        expiry=expiry,
    )
    return f"{blob_client.url}?{sas}"


def _tts_audio_url_sync(session_id: str, voice_id: str, text: str) -> str:
    text = (text or "").strip()
    if not text:
        raise RuntimeError("TTS text is empty")

    # Cache path: deterministic blob name, cross-session.
    if _TTS_CACHE_ENABLED:
        cache_blob = _tts_cache_blob_name(voice_id=voice_id, text=text)
        try:
            from azure.storage.blob import BlobServiceClient  # type: ignore

            storage_conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "").strip()
            if not storage_conn_str:
                raise RuntimeError("AZURE_STORAGE_CONNECTION_STRING is not configured")

            blob_service = BlobServiceClient.from_connection_string(storage_conn_str)
            container_client = blob_service.get_container_client(_TTS_CONTAINER)
            blob_client = container_client.get_blob_client(cache_blob)

            # Fast existence check (SDK-level). If present, return SAS immediately.
            exists = False
            try:
                exists = bool(blob_client.exists())
            except Exception:
                try:
                    blob_client.get_blob_properties()
                    exists = True
                except Exception:
                    exists = False

            if exists:
                _clear_inflight_marker(cache_blob)

                return _azure_blob_sas_url(blob_name=cache_blob)

            # Cache miss: generate and upload.


            _touch_inflight_marker(cache_blob)
            mp3_bytes = _elevenlabs_tts_mp3_bytes(voice_id=voice_id, text=text)

            # Upload without overwrite to avoid clobbering a concurrent writer.
            try:
                from azure.storage.blob import ContentSettings  # type: ignore
                blob_client.upload_blob(
                    mp3_bytes,
                    overwrite=False,
                    content_settings=ContentSettings(content_type="audio/mpeg"),
                )
            except Exception:
                # If another worker won the race and uploaded first, just return SAS.
                pass

            return _azure_blob_sas_url(blob_name=cache_blob)
        except Exception:
            # Fail-open: if cache path fails for any reason, fall back to the legacy per-session upload.
            pass

    # Legacy path: per-session unique blob (no caching).
    blob_name = _tts_blob_name(session_id=session_id, voice_id=voice_id, text=text)
    mp3_bytes = _elevenlabs_tts_mp3_bytes(voice_id=voice_id, text=text)
    return _azure_upload_mp3_and_get_sas_url(blob_name=blob_name, mp3_bytes=mp3_bytes)

# ----------------------------
# STEP A (Latency): TTS Cache Prewarm (Azure Blob)
# ----------------------------
# Objective:
#   Pre-generate a small set of common system phrases into the deterministic Azure Blob cache so that
#   first-use latency for these phrases is near-zero after a cold start/restart.
#
# Safety properties:
#   - Backend-only change; no frontend impact.
#   - Fire-and-forget: does not block application startup.
#   - Fail-open: any error during prewarm is ignored; normal runtime behavior is unchanged.
#   - Uses the same TTS/cache path as production (/chat and /tts/audio-url), so behavior is consistent.
#
# Controls:
#   TTS_PREWARM_ENABLED=1|0   (default: 1)
#   TTS_PREWARM_VOICE_ID=<elevenlabs_voice_id>  (optional; if missing, prewarm is skipped)
#   TTS_PREWARM_PHRASES_JSON='["Hello!", "..."]' (optional override)

_TTS_PREWARM_ENABLED = (os.getenv("TTS_PREWARM_ENABLED", "1") or "1").strip().lower() not in {"0", "false", "no", "off"}

# We deliberately do NOT guess a voice_id from companion here because this is backend-only and we want
# to avoid unintended cross-companion behavior. If you want prewarm for a specific voice, set it explicitly.
_TTS_PREWARM_VOICE_ID = (os.getenv("TTS_PREWARM_VOICE_ID", "") or "").strip()

_DEFAULT_PREWARM_PHRASES: list[str] = [
    "Hello!",
    "Hi there!",
    "How can I help you today?",
    "Sure.",
    "Okay.",
    "Got it.",
    "All set.",
]

def _load_prewarm_phrases() -> list[str]:
    raw = (os.getenv("TTS_PREWARM_PHRASES_JSON", "") or "").strip()
    if not raw:
        return list(_DEFAULT_PREWARM_PHRASES)
    try:
        v = json.loads(raw)
        if isinstance(v, list):
            out: list[str] = []
            for item in v:
                s = str(item or "").strip()
                if s:
                    out.append(s)
            return out or list(_DEFAULT_PREWARM_PHRASES)
    except Exception:
        pass
    return list(_DEFAULT_PREWARM_PHRASES)

async def _tts_prewarm_task() -> None:
    if not _TTS_PREWARM_ENABLED:
        return
    if not _TTS_PREWARM_VOICE_ID:
        # No explicit voice configured; skip prewarm to avoid generating for the wrong companion.
        return

    phrases = _load_prewarm_phrases()
    # Use a fixed session id; caching ignores session id when _TTS_CACHE_ENABLED is on.
    sid = "prewarm"
    for phrase in phrases:
        try:
            # run the synchronous generator in a thread to avoid blocking the event loop
            await run_in_threadpool(_tts_audio_url_sync, sid, _TTS_PREWARM_VOICE_ID, phrase)
        except Exception:
            # fail-open: ignore
            continue

@app.on_event("startup")
async def _startup_tts_prewarm() -> None:
    # Fire-and-forget. Do not await; do not block startup.
    try:
        asyncio.create_task(_tts_prewarm_task())
    except Exception:
        pass

# ----------------------------
# STEP B (Latency): Cache-first TTS for audio/video (rule-preserving)
# ----------------------------
# Rule: For audio and live-avatar flows, do NOT return assistant text before audio/video is ready.
# This step therefore keeps /chat synchronous when voice_id is present, but adds a cache-first fast path
# to avoid an ElevenLabs call on repeats. It also adds a lightweight "inflight" marker so /tts/audio-url
# can wait briefly for another request/worker that is already generating the same cached blob.
#
# No default voice is introduced; this engages only when the frontend supplies voice_id (as today).
#
# Controls:
#   TTS_CHAT_CACHE_FIRST=1|0     (default: 1)
#   TTS_INFLIGHT_WAIT_MS=1500    (default: 1500ms)
#   TTS_INFLIGHT_STALE_S=90      (default: 90s)
#   TTS_INFLIGHT_DIR=/home/tts_inflight

_TTS_CHAT_CACHE_FIRST = (os.getenv("TTS_CHAT_CACHE_FIRST", "1") or "1").strip().lower() not in {"0","false","no","off"}
_TTS_INFLIGHT_WAIT_MS = max(0, int(os.getenv("TTS_INFLIGHT_WAIT_MS", "1500") or "1500"))
_TTS_INFLIGHT_STALE_S = max(10, int(os.getenv("TTS_INFLIGHT_STALE_S", "90") or "90"))
_TTS_INFLIGHT_DIR = (os.getenv("TTS_INFLIGHT_DIR", "/home/tts_inflight") or "/home/tts_inflight").strip()

def _inflight_marker_path(cache_blob_name: str) -> str:
    h = hashlib.sha256((cache_blob_name or "").encode("utf-8")).hexdigest()[:40]
    return os.path.join(_TTS_INFLIGHT_DIR, f"{h}.lock")

def _touch_inflight_marker(cache_blob_name: str) -> None:
    try:
        os.makedirs(_TTS_INFLIGHT_DIR, exist_ok=True)
        with open(_inflight_marker_path(cache_blob_name), "w", encoding="utf-8") as f:
            f.write(str(int(time.time())))
    except Exception:
        pass

def _clear_inflight_marker(cache_blob_name: str) -> None:
    try:
        p = _inflight_marker_path(cache_blob_name)
        if os.path.exists(p):
            os.remove(p)
    except Exception:
        pass

def _inflight_marker_is_fresh(cache_blob_name: str) -> bool:
    try:
        p = _inflight_marker_path(cache_blob_name)
        if not os.path.exists(p):
            return False
        age = time.time() - os.path.getmtime(p)
        return age >= 0 and age <= _TTS_INFLIGHT_STALE_S
    except Exception:
        return False

def _tts_cache_peek_sync(voice_id: str, text: str) -> Optional[str]:
    """Cache-only lookup: returns SAS URL if deterministic cache blob exists, else None."""
    if not _TTS_CACHE_ENABLED:
        return None
    t = (text or "").strip()
    if not t:
        return None
    cache_blob = _tts_cache_blob_name(voice_id=voice_id, text=t)
    try:
        from azure.storage.blob import BlobServiceClient  # type: ignore
        storage_conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "").strip()
        if not storage_conn_str:
            return None
        blob_service = BlobServiceClient.from_connection_string(storage_conn_str)
        container_client = blob_service.get_container_client(_TTS_CONTAINER)
        blob_client = container_client.get_blob_client(cache_blob)
        try:
            if blob_client.exists():
                return _azure_blob_sas_url(blob_name=cache_blob)
        except Exception:
            try:
                blob_client.get_blob_properties()
                return _azure_blob_sas_url(blob_name=cache_blob)
            except Exception:
                return None
    except Exception:
        return None
    return None




# ----------------------------
# CHAT (Optimized: optional audio_url in same response)
# ----------------------------
@app.post("/chat", response_model=None)
async def chat(request: Request):
    """
    Backward-compatible /chat endpoint.

    Optimization:
      If the request includes `voice_id` (or `voiceId`), the API will ALSO generate
      an ElevenLabs MP3, upload it to Azure Blob, and return `audio_url` in the same
      /chat response — avoiding a second round-trip to /tts/audio-url.

    Request (existing fields):
      { session_id, messages, session_state, wants_explicit }

    Additional optional fields:
      { voice_id: "<elevenlabs_voice_id>" }   or  { voiceId: "<...>" }
    """
    debug = bool(getattr(settings, "DEBUG", False))

    raw = await request.json()
    session_id, messages, session_state, wants_explicit = _normalize_payload(raw)
    
    voice_id = _extract_voice_id(raw)

    # ----------------------------
    # Usage / minutes enforcement
    # ----------------------------
    # Rule: If we do NOT have a memberId, the visitor is on Free Trial (IP-based identity).
    # Every plan (including subscriptions) has a minute budget. When exhausted, we return a pay/upgrade message.
    member_id = _extract_member_id(session_state)
    plan_name_raw = _extract_plan_name(session_state)

    # RebrandingKey (Wix) overrides (upgrade/pay links + quota settings) when present.
    # Wix provides: Rebranding|UpgradeLink|PayGoLink|PayGoPrice|PayGoMinutes|Plan|ElaraloPlanMap|FreeMinutes|CycleDays
    rebranding_key_raw = _extract_rebranding_key(session_state)

    # NOTE: RebrandingKey validation is performed in Wix (Velo) before sending to this API.
    # Server-side validation is intentionally disabled to avoid breaking existing Wix flows.
    # If Wix-side validation is removed, you can enable the validator by uncommenting below:
    # ok, err = _validate_rebranding_key_server_side(rebranding_key_raw)
    # if not ok:
    #     _dbg(debug, f"[RebrandingKey] rejected: {err}")
    #     rebranding_key_raw = ""
    rebranding_parsed = _parse_rebranding_key(rebranding_key_raw) if rebranding_key_raw else {}

    # Prefer explicit fields (if provided) and fall back to the parsed RebrandingKey.
    upgrade_link_override = _session_get_str(session_state, "upgrade_link", "upgradeLink") or rebranding_parsed.get("upgrade_link", "")
    pay_go_link_override = _session_get_str(session_state, "pay_go_link", "payGoLink") or rebranding_parsed.get("pay_go_link", "")
    pay_go_price = _session_get_str(session_state, "pay_go_price", "payGoPrice") or rebranding_parsed.get("pay_go_price", "")
    pay_go_minutes_raw = _session_get_str(session_state, "pay_go_minutes", "payGoMinutes") or rebranding_parsed.get("pay_go_minutes", "")
    plan_external = (
        _session_get_str(session_state, "rebranding_plan", "rebrandingPlan", "planExternal", "plan_external")
        or rebranding_parsed.get("plan", "")
    )
    plan_map = _session_get_str(session_state, "elaralo_plan_map", "elaraloPlanMap") or rebranding_parsed.get("elaralo_plan_map", "")
    free_minutes_raw = _session_get_str(session_state, "free_minutes", "freeMinutes") or rebranding_parsed.get("free_minutes", "")
    cycle_days_raw = _session_get_str(session_state, "cycle_days", "cycleDays") or rebranding_parsed.get("cycle_days", "")

    pay_go_minutes = _safe_int(pay_go_minutes_raw)
    free_minutes = _safe_int(free_minutes_raw)
    cycle_days = _safe_int(cycle_days_raw)

    is_trial = not bool(member_id)
    identity_key = f"member::{member_id}" if member_id else f"ip::{_get_client_ip(request) or session_id or 'unknown'}"

    # Prefer using FreeMinutes/CycleDays from RebrandingKey when present.
    minutes_allowed_override: Optional[int] = None
    if free_minutes is not None:
        minutes_allowed_override = free_minutes
    elif plan_map:
        minutes_allowed_override = int(TRIAL_MINUTES) if is_trial else int(_included_minutes_for_plan(plan_map))

    cycle_days_override: Optional[int] = None
    if cycle_days is not None:
        cycle_days_override = cycle_days

    # Plan name used for quota purposes (fallback) should use the mapped plan if provided.
    plan_name_for_limits = plan_map or plan_name_raw

    # Plan label shown to the user should use the external plan name (if provided).
    plan_label_for_messages = plan_external or plan_name_raw

    # For rebranding, construct PAYG_PRICE_TEXT as:
    #   PayGoPrice + " per " + PayGoMinutes + " minutes"
    is_rebranding = bool(rebranding_key_raw or plan_external or plan_map or upgrade_link_override or pay_go_link_override or pay_go_price)

    payg_price_text_override = ""
    if is_rebranding:
        minutes_part = ""
        if pay_go_minutes is not None:
            minutes_part = str(pay_go_minutes)
        else:
            minutes_part = str(pay_go_minutes_raw or "").strip()
        if pay_go_price and minutes_part:
            payg_price_text_override = f"{pay_go_price} per {minutes_part} minutes"

    usage_ok, usage_info = await run_in_threadpool(
        _usage_charge_and_check_sync,
        identity_key,
        is_trial=is_trial,
        plan_name=plan_name_for_limits,
        minutes_allowed_override=minutes_allowed_override,
        cycle_days_override=cycle_days_override,
    )

    if not usage_ok:
        minutes_allowed = int(
            usage_info.get("minutes_allowed")
            or (minutes_allowed_override if minutes_allowed_override is not None else (TRIAL_MINUTES if is_trial else _included_minutes_for_plan(plan_name_for_limits)))
            or 0
        )
        session_state_out = dict(session_state)
        session_state_out.update(
            {
                "minutes_exhausted": True,
                "minutes_used": int(usage_info.get("minutes_used") or 0),
                "minutes_allowed": int(minutes_allowed),
                "minutes_remaining": int(usage_info.get("minutes_remaining") or 0),
            }
        )
        reply = _usage_paywall_message(
            is_trial=is_trial,
            plan_name=plan_label_for_messages,
            minutes_allowed=minutes_allowed,
            upgrade_url=upgrade_link_override,
            payg_pay_url=pay_go_link_override,
            payg_increment_minutes=pay_go_minutes,
            payg_price_text=payg_price_text_override,
        )
        return {
            "session_id": session_id,
            "mode": STATUS_SAFE,
            "reply": reply,
            "session_state": session_state_out,
            "audio_url": None,
        }

# Best-effort retrieval of a previously saved chat summary.
    # IMPORTANT: Companion-isolated memory. We do NOT use wildcard fallbacks.
    saved_summary: str | None = None
    memory_key: str | None = None
    try:
        # Use the exact same keying logic as /chat/save-summary, otherwise retrieval will miss.
        # If memberId is present but companion is missing/empty, _summary_store_key() returns 'unknown'
        # and we deliberately do NOT inject memory (prevents cross-companion leakage).
        key = _summary_store_key(session_state, session_id)
        if key.startswith('session::'):
            memory_key = key
        else:
            # memberId-based key: require a real companion key
            if key.endswith('::unknown'):
                memory_key = None
            else:
                memory_key = key

        if memory_key:
            _refresh_summary_store_if_needed()
            rec = _CHAT_SUMMARY_STORE.get(memory_key) or {}
            s = rec.get('summary')
            if isinstance(s, str) and s.strip():
                saved_summary = s.strip()
    except Exception:
        saved_summary = None
        memory_key = None

    # Helper to build responses consistently and optionally include audio_url.
    async def _respond(reply: str, status_mode: str, state_out: Dict[str, Any]) -> Dict[str, Any]:
        audio_url: Optional[str] = None
        if voice_id and (reply or "").strip():
            try:
                if _TTS_CHAT_CACHE_FIRST and _TTS_CACHE_ENABLED:
                    audio_url = await run_in_threadpool(_tts_cache_peek_sync, voice_id, reply)
                if audio_url is None:
                    audio_url = await run_in_threadpool(_tts_audio_url_sync, session_id, voice_id, reply)
            except Exception as e:
                # Fail-open: never break chat because TTS failed
                _dbg(debug, "TTS generation failed:", repr(e))
                state_out = dict(state_out)
                state_out["tts_error"] = f"{type(e).__name__}: {e}"

        return {
            "session_id": session_id,
            "mode": status_mode,          # safe/explicit_blocked/explicit_allowed
            "reply": reply,
            "session_state": state_out,
            "audio_url": audio_url,       # NEW (optional)
        }

    # last user message
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = ((last_user.get("content") if last_user else "") or "").strip()
    normalized_text = user_text.lower().strip()

    # allow text-based mode switching
    detected_switch = _detect_mode_switch_from_text(user_text)
    if detected_switch:
        session_state["mode"] = detected_switch

    requested_mode = _normalize_mode(str(session_state.get("mode") or "friend"))
    requested_intimate = (requested_mode == "intimate")

    # authoritative consent flag should live in session_state (works across gunicorn workers)
    intimate_allowed = bool(session_state.get("explicit_consented") is True)

    # if user is requesting intimate OR the UI is in intimate mode, treat as intimate request
    user_requesting_intimate = wants_explicit or requested_intimate or _looks_intimate(user_text)

    # consent keywords
    CONSENT_YES = {
        "yes", "y", "yeah", "yep", "sure", "ok", "okay",
        "i consent", "i agree", "i confirm", "confirm",
        "i am 18+", "i'm 18+", "i am over 18", "i'm over 18",
        "i confirm i am 18+", "i confirm that i am 18+",
        "i confirm and consent",
    }
    CONSENT_NO = {"no", "n", "nope", "nah", "decline", "cancel"}

    pending = (session_state.get("pending_consent") or "")
    pending = pending.strip().lower() if isinstance(pending, str) else ""

    def _grant_intimate(state_in: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(state_in)
        out["adult_verified"] = True
        out["explicit_consented"] = True
        out["pending_consent"] = None
        out["mode"] = "intimate"
        out["explicit_granted_at"] = _now_ts()
        return out

    # If we are waiting on consent, only accept yes/no
    if pending == "intimate" and not intimate_allowed:
        if normalized_text in CONSENT_YES:
            session_state_out = _grant_intimate(session_state)
            return await _respond(
                "Thank you — Intimate (18+) mode is enabled. What would you like to explore together?",
                STATUS_ALLOWED,
                session_state_out,
            )

        if normalized_text in CONSENT_NO:
            session_state_out = dict(session_state)
            session_state_out["pending_consent"] = None
            session_state_out["explicit_consented"] = False
            session_state_out["mode"] = "friend"
            return await _respond(
                "No problem — we’ll keep things in Friend mode.",
                STATUS_SAFE,
                session_state_out,
            )

        # still pending; remind
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"  # keep pill highlighted
        return await _respond(
            "Please reply with 'yes' or 'no' to continue.",
            STATUS_BLOCKED,
            session_state_out,
        )

    # Start consent if intimate requested but not allowed
    require_consent = bool(getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True))
    if require_consent and user_requesting_intimate and not intimate_allowed:
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"
        return await _respond(
            "Before we continue, please confirm you are 18+ and consent to Intimate (18+) conversation. Reply 'yes' to continue.",
            STATUS_BLOCKED,
            session_state_out,
        )

    # Effective mode for the model (never intimate unless allowed)
    effective_mode = requested_mode
    if effective_mode == "intimate" and not intimate_allowed:
        effective_mode = "friend"

    _dbg(
        debug,
        f"/chat session={session_id} requested_mode={requested_mode} effective_mode={effective_mode} "
        f"user_requesting_intimate={user_requesting_intimate} intimate_allowed={intimate_allowed} pending={pending} voice_id={'yes' if voice_id else 'no'}",
    )

    # call model
    try:
        openai_messages = _to_openai_messages(
            messages,
            session_state,
            mode=effective_mode,
            intimate_allowed=intimate_allowed,
            debug=debug,
        )

        # Memory policy: do not guess about prior conversations.
        # - If a saved summary is injected, you may use ONLY that as cross-session context.
        # - If no saved summary is injected, explicitly say no saved summary is available if asked.
        # Platform capability policy:
        # - This app can speak your replies via TTS / Live Avatar. Do not claim you "don't have TTS".
        memory_policy = (
            "Memory rule: Only reference cross-session history if a 'Saved conversation summary' is provided. "
            "If no saved summary is provided and the user asks about past conversations, say you do not have a saved summary for this companion.\n"
            "Capability rule: Your replies may be spoken aloud in this app (audio TTS and/or a live avatar). "
            "Do not say you lack text-to-speech; instead explain that you generate text and the platform voices it."
        )
        openai_messages.insert(1, {"role": "system", "content": memory_policy})

        if saved_summary:
            openai_messages.insert(
                2,
                {
                    "role": "system",
                    "content": "Saved conversation summary (user-authorized, for reference across devices):\n" + saved_summary,
                },
            )

        assistant_reply = _call_gpt4o(openai_messages)
    except Exception as e:
        _dbg(debug, "OpenAI call failed:", repr(e))
        raise HTTPException(status_code=500, detail=f"OpenAI call failed: {type(e).__name__}: {e}")

    # echo back session_state (ensure correct mode)
    session_state_out = dict(session_state)
    session_state_out["mode"] = effective_mode
    session_state_out["pending_consent"] = None if intimate_allowed else session_state_out.get("pending_consent")
    session_state_out["companion_meta"] = _parse_companion_meta(
        session_state_out.get("companion")
        or session_state_out.get("companionName")
        or session_state_out.get("companion_name")
    )

    return await _respond(
        assistant_reply,
        STATUS_ALLOWED if intimate_allowed else STATUS_SAFE,
        session_state_out,
    )


# ----------------------------
# SAVE CHAT SUMMARY
# ----------------------------
# NOTE: This stores summaries server-side (in memory, with optional file persistence).
# This is intentionally simple; durable storage / retrieval strategy can be evolved
# incrementally without changing the frontend contract.
_CHAT_SUMMARY_STORE: Dict[str, Dict[str, Any]] = {}
_CHAT_SUMMARY_FILE = os.getenv("CHAT_SUMMARY_FILE", "")
_CHAT_SUMMARY_FILE_MTIME: float = 0.0

# Lock for cross-worker file refresh/write coordination (best-effort).
# This only synchronizes within a single worker process; cross-worker sync is via atomic file replace + mtime.
_CHAT_SUMMARY_LOCK = __import__("threading").RLock()


def _load_summary_store() -> None:
    """Best-effort load of persisted summary store.

    Worker-safe behavior for single-instance App Service:
      - Load from CHAT_SUMMARY_FILE if present.
      - Clear and replace the in-memory store to match disk.
      - Track file mtime to enable refresh-on-change across gunicorn workers.

    Fail-open: never crashes the API.
    """
    global _CHAT_SUMMARY_FILE_MTIME
    if not _CHAT_SUMMARY_FILE:
        return
    try:
        if not os.path.isfile(_CHAT_SUMMARY_FILE):
            return
        with open(_CHAT_SUMMARY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            _CHAT_SUMMARY_STORE.clear()
            for k, v in data.items():
                if isinstance(k, str) and isinstance(v, dict):
                    _CHAT_SUMMARY_STORE[k] = v
        try:
            _CHAT_SUMMARY_FILE_MTIME = os.stat(_CHAT_SUMMARY_FILE).st_mtime
        except Exception:
            pass
    except Exception:
        # Fail-open
        return


def _refresh_summary_store_if_needed() -> None:
    """Refresh the in-memory store if the backing file changed.

    This enables cross-worker consistency on a single instance because each gunicorn
    worker sees the shared filesystem and can reload when another worker writes.
    """
    global _CHAT_SUMMARY_FILE_MTIME
    if not _CHAT_SUMMARY_FILE:
        return
    try:
        st = os.stat(_CHAT_SUMMARY_FILE)
    except FileNotFoundError:
        return
    except Exception:
        return

    if st.st_mtime <= _CHAT_SUMMARY_FILE_MTIME:
        return

    with _CHAT_SUMMARY_LOCK:
        # Re-check inside lock to avoid redundant reloads within this worker
        try:
            st2 = os.stat(_CHAT_SUMMARY_FILE)
        except Exception:
            return
        if st2.st_mtime <= _CHAT_SUMMARY_FILE_MTIME:
            return
        _load_summary_store()


def _normalize_companion_key(raw: Any) -> str:
    """Normalize a companion identifier for stable keying.

    Used ONLY for storage keys; display names remain unchanged.
    """
    s = "" if raw is None else str(raw)
    s = re.sub(r"\s+", " ", s.strip())
    # Strip any pipe-appended metadata to keep keys stable across live providers
    s = s.split("|", 1)[0].strip()
    return s.lower()


def _extract_member_id(session_state: Dict[str, Any]) -> str:
    member_id = (
        session_state.get("memberId")
        or session_state.get("member_id")
        or session_state.get("member")
        or ""
    )
    return str(member_id).strip() if member_id is not None else ""


def _extract_companion_raw(session_state: Dict[str, Any]) -> str:
    companion = (
        session_state.get("companion")
        or session_state.get("companionName")
        or session_state.get("companion_name")
        or ""
    )
    return str(companion).strip() if companion is not None else ""


def _summary_store_key(session_state: Dict[str, Any], session_id: str) -> str:
    """Stable key using memberId + normalized companion; falls back to session_id.

    IMPORTANT: Companion isolation is enforced by including the normalized companion key.
    If memberId is present but companion is missing/empty, we deliberately use 'unknown'
    and retrieval must treat that as 'no saved memory'.
    """
    member_id = _extract_member_id(session_state)
    companion_key = _normalize_companion_key(_extract_companion_raw(session_state))

    if member_id:
        return f"{member_id}::{companion_key or 'unknown'}"
    return f"session::{session_id}"


def _persist_summary_store() -> None:
    """Best-effort atomic persistence to a shared file.

    Uses write-to-temp + os.replace to avoid other workers reading partial files.
    """
    global _CHAT_SUMMARY_FILE_MTIME
    if not _CHAT_SUMMARY_FILE:
        return
    try:
        tmp_path = _CHAT_SUMMARY_FILE + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(_CHAT_SUMMARY_STORE, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, _CHAT_SUMMARY_FILE)
        try:
            _CHAT_SUMMARY_FILE_MTIME = os.stat(_CHAT_SUMMARY_FILE).st_mtime
        except Exception:
            pass
    except Exception:
        # Fail-open
        return


# Load persisted summaries once at startup (best-effort).
_load_summary_store()


@app.post("/chat/save-summary", response_model=None)
async def save_chat_summary(request: Request):
    """Saves a server-side summary of the chat history.

    Reliability goals:
      - Never leave the browser with an ambiguous network failure when possible.
      - Cap inputs to avoid oversized payloads/timeouts.
      - Return a structured JSON response even when summarization fails.

    Request JSON:
      { session_id, messages, session_state }

    Response JSON:
      { ok: true|false, summary?: "...", error_code?: "...", error?: "...", saved_at?: <ts>, key?: "..." }
    """
    debug = bool(getattr(settings, "DEBUG", False))

    try:
        raw = await request.json()
    except Exception as e:
        return {"ok": False, "error_code": "invalid_json", "error": f"{type(e).__name__}: {e}"}

    session_id, messages, session_state, _wants_explicit = _normalize_payload(raw)

    # Normalize + cap the conversation for summarization to reduce cost and avoid request failures.
    max_msgs = int(os.getenv("SAVE_SUMMARY_MAX_MESSAGES", "80") or "80")
    max_chars = int(os.getenv("SAVE_SUMMARY_MAX_CHARS", "12000") or "12000")
    per_msg_chars = int(os.getenv("SAVE_SUMMARY_MAX_CHARS_PER_MESSAGE", "2000") or "2000")

    convo_items: List[Dict[str, str]] = []
    for m in messages:
        role = m.get("role")
        if role in ("user", "assistant"):
            content = str(m.get("content") or "")
            if per_msg_chars > 0 and len(content) > per_msg_chars:
                content = content[:per_msg_chars] + " …"
            convo_items.append({"role": role, "content": content})

    if max_msgs > 0 and len(convo_items) > max_msgs:
        convo_items = convo_items[-max_msgs:]

    # Enforce a total character budget from the end (most recent is most useful).
    total = 0
    capped: List[Dict[str, str]] = []
    for m in reversed(convo_items):
        c = m["content"]
        if total >= max_chars:
            break
        # keep at least some of this message
        remaining = max_chars - total
        if remaining <= 0:
            break
        if len(c) > remaining:
            c = c[-remaining:]
        capped.append({"role": m["role"], "content": c})
        total += len(c)
    convo_items = list(reversed(capped))

    sys = (
        "You are a concise assistant that creates a server-side chat summary for future context. "
        "Write a compact summary that captures: relationship tone, key facts, user preferences/boundaries, "
        "names/roles, and any commitments or plans. Avoid quoting long passages. "
        "Output plain text only."
    )

    convo: List[Dict[str, str]] = [{"role": "system", "content": sys}] + convo_items

    # Time-bound the summarization request to prevent upstream timeouts.
    timeout_s = float(os.getenv("SAVE_SUMMARY_TIMEOUT_S", "30") or "30")
    try:
        summary = await asyncio.wait_for(run_in_threadpool(_call_gpt4o_summary, convo), timeout=timeout_s)
    except asyncio.TimeoutError:
        return {"ok": False, "error_code": "timeout", "error": f"Save summary timed out after {timeout_s:.0f}s"}
    except Exception as e:
        _dbg(debug, "Summary generation failed:", repr(e))
        return {"ok": False, "error_code": "summary_failed", "error": f"{type(e).__name__}: {e}"}

    # Refresh from disk before write to avoid clobbering another worker's recent update.
    _refresh_summary_store_if_needed()

    key = _summary_store_key(session_state, session_id)
    record = {
        "saved_at": _now_ts(),
        "session_id": session_id,
        "member_id": session_state.get("memberId") or session_state.get("member_id"),
        "companion": session_state.get("companion") or session_state.get("companionName") or session_state.get("companion_name"),
        "summary": summary,
    }
    _CHAT_SUMMARY_STORE[key] = record
    _persist_summary_store()

    return {"ok": True, "summary": summary, "saved_at": record["saved_at"], "key": key}


# ----------------------------
# BACKWARD-COMPAT TTS ENDPOINT (still supported)
# ----------------------------
@app.post("/tts/audio-url")
async def tts_audio_url(request: Request) -> Dict[str, Any]:
    """
    Backward compatible endpoint.

    Request JSON:
      {
        "session_id": "...",
        "voice_id": "<ElevenLabsVoiceId>",
        "text": "..."
      }

    Response JSON:
      { "audio_url": "https://...sas..." }
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    session_id = (body.get("session_id") or body.get("sid") or "").strip()
    if not session_id:
        raise HTTPException(status_code=422, detail="session_id required")

    voice_id = ((body.get("voice_id") or body.get("voiceId") or "")).strip()
    text = (body.get("text") or "").strip()

    if not voice_id or not text:
        raise HTTPException(status_code=422, detail="voice_id and text are required")

    try:
        # STEP B: if another worker/request is already generating the same cached blob, wait briefly.
        audio_url: Optional[str] = None
        if _TTS_CACHE_ENABLED and voice_id and text:
            try:
                cache_blob = _tts_cache_blob_name(voice_id=voice_id, text=text)
                if _inflight_marker_is_fresh(cache_blob):
                    waited = 0
                    while waited < _TTS_INFLIGHT_WAIT_MS:
                        peek = await run_in_threadpool(_tts_cache_peek_sync, voice_id, text)
                        if peek:
                            audio_url = peek
                            break
                        await asyncio.sleep(0.15)
                        waited += 150
            except Exception:
                pass
        if audio_url is None:
            audio_url = await run_in_threadpool(_tts_audio_url_sync, session_id, voice_id, text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TTS failed: {type(e).__name__}: {e}")

    return {"audio_url": audio_url}


# --------------------------
# STT (Speech-to-Text)
# --------------------------
# NOTE: This endpoint intentionally accepts RAW audio bytes in the request body (not multipart/form-data)
# to avoid requiring the `python-multipart` package (which can otherwise prevent FastAPI from starting).
#
# Frontend should POST the recorded Blob directly:
#   fetch(`${API_BASE}/stt/transcribe`, { method:"POST", headers:{ "Content-Type": blob.type }, body: blob })
#
@app.post("/stt/transcribe")
async def stt_transcribe(request: Request):
    if not settings.OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not configured")

    content_type = (request.headers.get("content-type") or "").lower().strip()
    audio_bytes = await request.body()

    if not audio_bytes or len(audio_bytes) < 16:
        raise HTTPException(status_code=400, detail="No audio received")

    # Infer file extension for OpenAI transcription.
    if "webm" in content_type:
        ext = "webm"
    elif "ogg" in content_type:
        ext = "ogg"
    elif "mp4" in content_type or "m4a" in content_type or "aac" in content_type:
        ext = "mp4"
    elif "wav" in content_type:
        ext = "wav"
    else:
        # Fallback; OpenAI can often still detect format, but providing a filename helps.
        ext = "bin"

    bio = io.BytesIO(audio_bytes)
    bio.name = f"stt.{ext}"

    try:
        # Use the same OpenAI client used elsewhere in this service.
        # `settings.STT_MODEL` can be set; fallback is whisper-1.
        stt_model = getattr(settings, "STT_MODEL", None) or "whisper-1"
        resp = client.audio.transcriptions.create(
            model=stt_model,
            file=bio,
        )
        text = getattr(resp, "text", None)
        if text is None and isinstance(resp, dict):
            text = resp.get("text")
        if not text:
            text = ""
        return {"text": str(text).strip()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STT transcription failed: {e}")



# =============================================================================
# Option B — Separate Journaling Endpoint (does NOT touch /chat or TTS/STT)
# =============================================================================
#
# Goal:
#   Capture *copies* of incoming/outgoing messages to an append-only journal store.
#   Summaries (manual or automated) can later be generated from this journal without
#   invoking the existing /chat/save-summary flow that the frontend currently treats
#   as a "stop everything" action.
#
# IMPORTANT:
#   - This code path is separate from /chat, /tts/*, /stt/*.
#   - It is only executed if the frontend calls /journal/append.
#   - No TTS/STT logic is modified by this feature.
#
# Storage:
#   - Default: local persistent /home on Azure App Service.
#   - Set CHAT_JOURNAL_DIR to override.
#
# Payload contract (frontend → backend):
#   POST /journal/append
#   {
#     "session_id": "....",
#     "session_state": { ... },     # same object you send to /chat
#     "events": [
#       { "role": "user"|"assistant", "content": "...", "ts": 1730000000.123 }
#     ]
#   }
#
# Response:
#   { ok: true|false, key: "...", count: N, error?: "..." }
# =============================================================================

_CHAT_JOURNAL_DIR = (os.getenv("CHAT_JOURNAL_DIR", "") or "/home/chat_journals").strip()


def _journal_safe_filename(key: str) -> str:
    # memberId::companionKey (contains ':' and other chars) → filesystem-safe slug
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "_", (key or "").strip())
    if not safe:
        safe = "unknown"
    return safe + ".jsonl"


def _journal_path_for_key(key: str) -> str:
    try:
        os.makedirs(_CHAT_JOURNAL_DIR, exist_ok=True)
    except Exception:
        # Fail-open: journaling should never break the API
        pass
    return os.path.join(_CHAT_JOURNAL_DIR, _journal_safe_filename(key))


def _append_journal_events_sync(path: str, events: List[Dict[str, Any]]) -> None:
    # Append JSONL with a per-file lock for multi-worker safety.
    lock = FileLock(path + ".lock")
    with lock:
        with open(path, "a", encoding="utf-8") as f:
            for e in events:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")


@app.post("/journal/append", response_model=None)
async def journal_append(request: Request):
    try:
        raw = await request.json()
    except Exception as e:
        return {"ok": False, "error": f"invalid_json: {type(e).__name__}: {e}"}

    session_id = str(raw.get("session_id") or "").strip()
    session_state = raw.get("session_state") or {}
    events_in = raw.get("events") or []

    if not isinstance(session_state, dict):
        session_state = {}
    if not isinstance(events_in, list):
        events_in = []

    # Compute the same stable keying scheme used by summaries.
    # (memberId + normalized companion; falls back to session::<session_id>)
    if not session_id:
        # journaling must still have a stable file name; fall back to an ephemeral id
        session_id = "session-" + uuid.uuid4().hex

    key = _summary_store_key(session_state, session_id)

    # Normalize/cap events (journaling must be cheap + safe)
    now_ts = time.time()
    max_events = int(os.getenv("CHAT_JOURNAL_MAX_EVENTS", "20") or "20")
    max_chars = int(os.getenv("CHAT_JOURNAL_MAX_CHARS", "8000") or "8000")
    max_chars_per_event = int(os.getenv("CHAT_JOURNAL_MAX_CHARS_PER_EVENT", "2000") or "2000")

    norm: List[Dict[str, Any]] = []
    for e in events_in[:max_events]:
        if not isinstance(e, dict):
            continue
        role = str(e.get("role") or "").strip().lower()
        if role not in {"user", "assistant"}:
            continue
        content = str(e.get("content") or "")
        content = content.strip()
        if not content:
            continue
        if len(content) > max_chars_per_event:
            content = content[:max_chars_per_event] + "…"
        ts = e.get("ts")
        try:
            ts_f = float(ts) if ts is not None else now_ts
        except Exception:
            ts_f = now_ts

        norm.append(
            {
                "ts": ts_f,
                "role": role,
                "content": content,
                "session_id": session_id,
                "key": key,
            }
        )

    # Global cap
    total_chars = 0
    capped: List[Dict[str, Any]] = []
    for e in norm:
        total_chars += len(e.get("content") or "")
        if total_chars > max_chars:
            break
        capped.append(e)

    if not capped:
        return {"ok": True, "key": key, "count": 0}

    path = _journal_path_for_key(key)
    try:
        await run_in_threadpool(_append_journal_events_sync, path, capped)
        return {"ok": True, "key": key, "count": len(capped)}
    except Exception as e:
        # Fail-open: journaling errors shouldn't break UX.
        return {"ok": False, "key": key, "count": 0, "error": f"{type(e).__name__}: {e}"}


# -----------------------------------------------------------------------------
# (Optional / future) Server-side summarization from journal
# -----------------------------------------------------------------------------
# If, later, you decide to remove Wix-side validation or want backend-driven
# automatic summaries, you can build it on top of the journal file(s) above.
#
# We are intentionally NOT enabling this now, because it introduces extra model
# calls and could create new performance variables. Keep it as a controlled,
# explicit feature rollout.
#
# @app.post("/journal/summarize", response_model=None)
# async def journal_summarize(request: Request):
#     ...
