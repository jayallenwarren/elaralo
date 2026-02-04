from __future__ import annotations

import os
import time
import re
import uuid
import json
import hashlib
import base64
import asyncio
from collections import deque
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel

from filelock import FileLock  # type: ignore

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
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

# If CORS_ALLOW_ORIGINS is not set, we use a conservative default that supports:
#   - Your production site (dulcemoon.net)
#   - Azure Static Web Apps preview/staging domains (*.azurestaticapps.net)
#   - Local development
#
# You can (and should) override this in production via an App Service env var:
#   CORS_ALLOW_ORIGINS="https://www.dulcemoon.net,https://dulcemoon.net,https://*.azurestaticapps.net"
#
# NOTE: This default avoids the common "Failed to fetch" / missing Access-Control-Allow-Origin
# failure when testing from an Azure Static Web Apps generated domain.
if not cors_env:
    cors_env = ",".join(
        [
            "https://dulcemoon.net",
            "https://www.dulcemoon.net",
            "https://*.azurestaticapps.net",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )
    print(f"[CORS] CORS_ALLOW_ORIGINS not set; defaulting to: {cors_env}")


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

# BeeStreamed live-session tracking (best-effort, in-memory; resets on API restart)
_BEE_STREAM_SESSION_ACTIVE: Dict[Tuple[str, str], bool] = {}
_BEE_STREAM_SESSION_EVENT_REF: Dict[Tuple[str, str], str] = {}



def _norm_key(s: str) -> str:
    """Normalize mapping lookup keys.

    The mapping DB is manually edited across rebrands and historically contains
    inconsistent brand formatting (e.g., "DulceMoon" vs "Dulce Moon").
    We normalize by:
      - lowercasing
      - stripping
      - removing whitespace and underscores

    IMPORTANT: We intentionally preserve hyphens so composite avatar keys
    (e.g., "Ashley-Female-...") can still be split on "-" later.
    """
    t = (s or "").strip().lower()
    t = re.sub(r"[\s_]+", "", t)
    return t

def _stream_session_key(brand: str, avatar: str) -> Tuple[str, str]:
    """Build a stable key for BeeStreamed live-session tracking."""
    return (_norm_key(brand), _norm_key(avatar))


def _set_stream_session_active(brand: str, avatar: str, active: bool, event_ref: str = "") -> None:
    """Mark a (brand, avatar) BeeStreamed session as active/inactive (best-effort)."""
    try:
        key = _stream_session_key(brand, avatar)
        _BEE_STREAM_SESSION_ACTIVE[key] = bool(active)
        if active and event_ref:
            _BEE_STREAM_SESSION_EVENT_REF[key] = str(event_ref).strip()
    except Exception:
        # Never allow session bookkeeping to break API calls
        pass


def _get_stream_session_active(brand: str, avatar: str) -> bool:
    try:
        key = _stream_session_key(brand, avatar)
        return bool(_BEE_STREAM_SESSION_ACTIVE.get(key, False))
    except Exception:
        return False


def _get_stream_session_event_ref(brand: str, avatar: str) -> str:
    try:
        key = _stream_session_key(brand, avatar)
        return str(_BEE_STREAM_SESSION_EVENT_REF.get(key, "") or "").strip()
    except Exception:
        return ""


def _is_stream_session_active_for_event_ref(event_ref: str) -> bool:
    """True iff the BeeStreamed session has been activated by the host (Play) for this event_ref.

    This is used to ensure that only the Host can *initiate* shared in-stream chat.
    Viewers may only join the chat room after the Host has started the BeeStreamed session.
    """
    ref = (event_ref or "").strip()
    if not ref:
        return False
    try:
        for key, ev in _BEE_STREAM_SESSION_EVENT_REF.items():
            if str(ev or "").strip() == ref:
                return bool(_BEE_STREAM_SESSION_ACTIVE.get(key, False))
    except Exception:
        return False
    return False


# ---------------------------------------------------------------------------
# BeeStreamed in-stream shared chat (Host + joined Viewers)
#
# Requirement:
#   - While a BeeStreamed session is active, the host + all joined viewers should see
#     each other's messages in a shared in-stream chat.
#   - This chat is intentionally separate from the /chat (AI) endpoint.
#
# Implementation notes:
#   - Uses WebSockets for low-latency broadcast.
#   - Maintains a small in-memory backlog per event_ref so late joiners can see recent
#     chat messages.
#   - This is best-effort / single-instance. If you run multiple API replicas, you will
#     need a shared pub/sub (Redis, etc.) to broadcast across instances.
# ---------------------------------------------------------------------------


class _LiveChatRoom:
    __slots__ = ("sockets", "history")

    def __init__(self) -> None:
        self.sockets: set[WebSocket] = set()
        self.history = deque(maxlen=250)  # last ~250 messages


class _LiveChatManager:
    def __init__(self) -> None:
        self._rooms: Dict[str, _LiveChatRoom] = {}
        self._lock = asyncio.Lock()

    async def connect(self, event_ref: str, ws: WebSocket) -> list[dict[str, Any]]:
        """Accept the socket and register it in the event_ref room.

        Returns the current room history snapshot.
        """
        await ws.accept()
        ref = (event_ref or "").strip()
        if not ref:
            return []

        async with self._lock:
            room = self._rooms.get(ref)
            if room is None:
                room = _LiveChatRoom()
                self._rooms[ref] = room

            room.sockets.add(ws)
            history = list(room.history)

        return history

    async def disconnect(self, event_ref: str, ws: WebSocket) -> None:
        ref = (event_ref or "").strip()
        if not ref:
            return
        async with self._lock:
            room = self._rooms.get(ref)
            if not room:
                return
            room.sockets.discard(ws)
            # Keep history for late joiners, even if empty room.
            if not room.sockets:
                # Optional: keep the room for a while; for now we keep it.
                pass

    async def broadcast(self, event_ref: str, payload: dict[str, Any]) -> None:
        ref = (event_ref or "").strip()
        if not ref:
            return

        # Snapshot sockets under lock, then send outside lock.
        async with self._lock:
            room = self._rooms.get(ref)
            if room is None:
                room = _LiveChatRoom()
                self._rooms[ref] = room
            room.history.append(payload)
            sockets = list(room.sockets)

        dead: list[WebSocket] = []
        for s in sockets:
            try:
                await s.send_json(payload)
            except Exception:
                dead.append(s)

        if dead:
            async with self._lock:
                room = self._rooms.get(ref)
                if room:
                    for d in dead:
                        room.sockets.discard(d)

    async def close_room(self, event_ref: str, reason: str = "session_ended") -> None:
        """Broadcast a session-ended event and close all sockets for an event_ref."""
        ref = (event_ref or "").strip()
        if not ref:
            return

        async with self._lock:
            room = self._rooms.pop(ref, None)

        if not room:
            return

        payload = {"type": reason}
        for s in list(room.sockets):
            try:
                await s.send_json(payload)
            except Exception:
                pass
            try:
                await s.close()
            except Exception:
                pass


_LIVECHAT = _LiveChatManager()



# Strict mapping DB enforcement:
#   - Only `voice_video_mappings.sqlite3` is allowed (per deployment requirement).
#   - If the DB is missing or not writable when we need to persist event_ref, we fail loudly.
_MAPPING_DB_PATH: str = ""
_MAPPING_DB_TABLE: str = ""
_MAPPING_DB_EVENT_REF_COL: str = ""


def _mapping_db_path_strict() -> str:
    """Resolve the required SQLite mapping database.

    Product requirement:
      - The API must use ONLY `voice_video_mappings.sqlite3` for mapping persistence.
      - If the DB cannot be found unambiguously, the API must fail fast (startup error).
      - You MAY provide VOICE_VIDEO_DB_PATH, but it MUST point to a file named exactly
        `voice_video_mappings.sqlite3`.

    Why this is strict:
      - If multiple copies of the DB exist (common in deploy pipelines), writing to one file
        while reading from another will cause "event_ref not saved" symptoms and repeated
        BeeStreamed event creation.
    """
    filename = "voice_video_mappings.sqlite3"
    env_path = (os.getenv("VOICE_VIDEO_DB_PATH", "") or "").strip()

    if env_path:
        if os.path.basename(env_path) != filename:
            raise RuntimeError(
                f"VOICE_VIDEO_DB_PATH must point to {filename} (got: {env_path})"
            )
        if not os.path.exists(env_path):
            raise RuntimeError(f"Required mapping DB not found at VOICE_VIDEO_DB_PATH: {env_path}")
        return os.path.realpath(env_path)

    base_dir = os.path.dirname(__file__)
    search_dirs: list[str] = []
    for d in [base_dir, os.getcwd(), os.path.abspath(os.path.join(base_dir, os.pardir))]:
        if d and d not in search_dirs:
            search_dirs.append(d)

    candidates: list[str] = []
    for d in search_dirs:
        p = os.path.realpath(os.path.join(d, filename))
        if os.path.exists(p):
            candidates.append(p)

    # De-dupe while preserving order
    unique: list[str] = []
    seen: set[str] = set()
    for c in candidates:
        if c not in seen:
            unique.append(c)
            seen.add(c)

    if not unique:
        raise RuntimeError(
            f"Required mapping DB not found. Looked for {filename} in: {search_dirs}. "
            f"Set VOICE_VIDEO_DB_PATH to the correct absolute path."
        )

    if len(unique) > 1:
        raise RuntimeError(
            f"Multiple '{filename}' files found: {unique}. "
            f"This is ambiguous and can cause event_ref persistence bugs. "
            f"Set VOICE_VIDEO_DB_PATH to choose the correct one."
        )

    return unique[0]



def _load_companion_mappings_sync() -> None:
    global _COMPANION_MAPPINGS, _COMPANION_MAPPINGS_LOADED_AT, _COMPANION_MAPPINGS_SOURCE

    global _MAPPING_DB_PATH, _MAPPING_DB_TABLE, _MAPPING_DB_EVENT_REF_COL

    db_path = _mapping_db_path_strict()
    _MAPPING_DB_PATH = db_path

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.cursor()

        # The mapping table name differs between environments.
        # Prefer the canonical names, but fall back to any table present.
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        table_names = [str(r[0]) for r in cur.fetchall() if r and r[0]]
        tables_lc = {t.lower(): t for t in table_names}

        preferred = [
            "voice_video_mappings",
            "companion_mappings",
        ]
        table = ""
        for cand in preferred:
            if cand.lower() in tables_lc:
                table = tables_lc[cand.lower()]
                break

        if not table:
            raise RuntimeError(
                f"[mappings] Required table not found in {db_path}. Expected one of {preferred}. Found tables: {table_names}"
            )

        # Discover the actual event_ref column name (case-insensitive). Add it if missing.
        cur.execute(f'PRAGMA table_info("{table}")')
        cols = [str(r[1] or "").strip() for r in cur.fetchall() if r and r[1]]
        cols_lc = {c.lower(): c for c in cols if c}

        def _pick_col(*candidates: str) -> str:
            for cand in candidates:
                real = cols_lc.get(str(cand).lower())
                if real:
                    return real
            return ""

        event_col = _pick_col("event_ref", "eventref", "eventRef", "EventRef", "EVENT_REF")
        if not event_col:
            # Try adding event_ref column (required for stream persistence).
            try:
                cur.execute(f'ALTER TABLE "{table}" ADD COLUMN event_ref TEXT')
                conn.commit()
                event_col = "event_ref"
            except Exception as e:
                raise RuntimeError(
                    f"[mappings] Table '{table}' in {db_path} lacks an event_ref column and cannot be altered: {e!r}"
                )

        _MAPPING_DB_TABLE = table
        _MAPPING_DB_EVENT_REF_COL = event_col

# Quote the table name to safely handle names with special characters.
        cur.execute(f'SELECT rowid as __rowid, * FROM "{table}"')
        rows = cur.fetchall()
        table_name_for_source = str(table or "")
    finally:
        conn.close()

    d: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for r in rows:
        # sqlite3.Row keys preserve the column names from the DB. Different environments may
        # have different capitalization (e.g., Live vs live) or legacy names (e.g., Companion).
        keys_lc = {str(k).lower(): k for k in r.keys()}

        def get_col(*candidates: str, default: Any = "") -> Any:
            for cand in candidates:
                k = keys_lc.get(str(cand).lower())
                if k is not None:
                    return r[k]
            return default

        brand = str(get_col("brand", "rebranding", "company", "brand_id", "Brand", default="") or "").strip()
        avatar = str(get_col("avatar", "companion", "Companion", "first_name", "firstname", default="") or "").strip()
        if not brand or not avatar:
            continue

        key = (_norm_key(brand), _norm_key(avatar))

        d[key] = {
            "__rowid": int(get_col("__rowid", default=0) or 0),
            "brand": brand,
            "avatar": avatar,
            "eleven_voice_name": str(get_col("eleven_voice_name", "Eleven_Voice_Name", default="") or ""),
            "communication": str(get_col("communication", "Communication", default="") or ""),
            "eleven_voice_id": str(get_col("eleven_voice_id", "Eleven_Voice_ID", default="") or ""),
            "live": str(get_col("live", "Live", default="") or ""),
            "event_ref": str(get_col("event_ref", "eventRef", "EventRef", "EVENT_REF", default="") or ""),
            "host_member_id": str(get_col("host_member_id", "hostMemberId", "HOST_MEMBER_ID", default="") or ""),
            "companion_type": str(get_col("companion_type", "Companion_Type", "COMPANION_TYPE", "type", "Type", default="") or ""),
            "did_embed_code": str(get_col("did_embed_code", "DID_EMBED_CODE", default="") or ""),
            "did_agent_link": str(get_col("did_agent_link", "DID_AGENT_LINK", default="") or ""),
            "did_agent_id": str(get_col("did_agent_id", "DID_AGENT_ID", default="") or ""),
            "did_client_key": str(get_col("did_client_key", "DID_CLIENT_KEY", default="") or ""),
            # Preserve common extra fields when present (helps debugging / future UIs).
            "companion_id": str(get_col("companion_id", "Companion_ID", "CompanionId", default="") or ""),
        }

    _COMPANION_MAPPINGS = d
    _COMPANION_MAPPINGS_LOADED_AT = time.time()
    # Persist the resolved table name in the source string so we can update the correct table later.
    _COMPANION_MAPPINGS_SOURCE = f"{db_path}:{table_name_for_source}"
    print(f"[mappings] Loaded {len(_COMPANION_MAPPINGS)} companion mapping rows from {db_path} (table={table_name_for_source})")


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
    # Fail fast if mappings DB is missing/misconfigured (per deployment requirement).
    await run_in_threadpool(_load_companion_mappings_sync)


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

# ---------------------------------------------------------------------------
# BeeStreamed embed + host gating (white-label friendly)
#
# Goals:
# - Each "Human / Stream" companion has a stable event_ref (preferably stored in the SQLite mapping DB).
# - Only the Human Companion (host) can start/stop the WebRTC stream.
# - Everyone else can open the embed and will see a "waiting for host" experience until the host starts.
#
# Notes:
# - host_member_id can be stored per companion in the mapping DB as `host_member_id`.
# - If `host_member_id` is missing for DulceMoon/Dulce, we fall back to a known host id (single human companion).
# - If `event_ref` is missing, ONLY the host will create it (via BeeStreamed API) and we will best-effort persist it.
# ---------------------------------------------------------------------------

DULCE_HOST_MEMBER_ID_FALLBACK = "1dc3fe06-c351-4678-8fe4-6a4b1350c556"

def _beestreamed_api_base() -> str:
    return (os.getenv("BEESTREAMED_API_BASE", "") or "https://api.beestreamed.com").strip().rstrip("/")

def _beestreamed_public_event_url(event_ref: str) -> str:
    # BeeStreamed public event page (works as an embeddable viewer page in an iframe).
    base = (os.getenv("BEESTREAMED_PUBLIC_EVENT_BASE", "") or "https://beestreamed.com/event").strip().rstrip("/")
    return f"{base}?id={event_ref}"


def _beestreamed_broadcaster_ui_url(event_ref: str) -> str:
    """Return the BeeStreamed **Producer View** (broadcaster UI) URL for an event_ref.

    Notes:
      - The Producer View appears to live under `manage.beestreamed.com/producer` and commonly accepts
        `ref=<event_ref>` (observed) as well as `event_ref` / `id` on some deployments.
      - BeeStreamed may block embedding of the manage UI (X-Frame-Options / CSP). When that happens, the iframe
        will show "refused to connect". The wrapper still remains useful to allow pop-outs to a new tab.

    Resolution order:
      1) BEESTREAMED_PRODUCER_URL_TEMPLATE (or legacy BEESTREAMED_BROADCASTER_URL_TEMPLATE)
           - Must contain the placeholder "{event_ref}"
           - Example:
               https://manage.beestreamed.com/producer?ref={event_ref}

      2) BEESTREAMED_PRODUCER_BASE (or legacy BEESTREAMED_BROADCASTER_BASE)
         + BEESTREAMED_PRODUCER_QUERY_KEY (or legacy BEESTREAMED_BROADCASTER_QUERY_KEY)
           - We append the event_ref as a query parameter.
           - Default base: https://manage.beestreamed.com/producer
           - Default key:  ref

      3) If nothing is configured, we fall back to:
           https://manage.beestreamed.com/producer?ref=<event_ref>&event_ref=<event_ref>&id=<event_ref>

    Compatibility note:
      - We include multiple common keys (`ref`, `event_ref`, `id`) to maximize compatibility.
    """
    ref = (event_ref or "").strip()
    if not ref:
        return ""

    tmpl = (
        os.getenv("BEESTREAMED_PRODUCER_URL_TEMPLATE", "")
        or os.getenv("BEESTREAMED_BROADCASTER_URL_TEMPLATE", "")
        or ""
    ).strip()
    if tmpl and "{event_ref}" in tmpl:
        return tmpl.replace("{event_ref}", ref)

    base = (
        os.getenv("BEESTREAMED_PRODUCER_BASE", "")
        or os.getenv("BEESTREAMED_BROADCASTER_BASE", "")
        or "https://manage.beestreamed.com/producer"
    ).strip().rstrip("/")
    if not base:
        return ""

    key = (
        os.getenv("BEESTREAMED_PRODUCER_QUERY_KEY", "")
        or os.getenv("BEESTREAMED_BROADCASTER_QUERY_KEY", "")
        or "ref"
    ).strip() or "ref"

    join = "&" if "?" in base else "?"
    url = f"{base}{join}{key}={ref}"

    # Add common alias keys as well (most servers ignore unknown params).
    extras: list[str] = []
    if key != "ref":
        extras.append(f"ref={ref}")
    if key != "event_ref":
        extras.append(f"event_ref={ref}")
    if key != "id":
        extras.append(f"id={ref}")
    if extras:
        url = url + "&" + "&".join(extras)

    return url


@app.get("/stream/beestreamed/embed/{event_ref}", response_class=HTMLResponse)
async def beestreamed_embed_page(event_ref: str):
    """Render a BeeStreamed event inside a sandboxed iframe.

    Why this exists:
      - The BeeStreamed viewer UI can include actions that open a pop-out / new window.
      - By wrapping the viewer in a sandboxed iframe WITHOUT `allow-popups`, those actions
        are prevented and the experience stays within the iframe container.
    """
    event_ref = (event_ref or "").strip()
    if not event_ref:
        raise HTTPException(status_code=400, detail="event_ref is required")

    viewer_url = _beestreamed_public_event_url(event_ref)

    html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Live Stream</title>
    <style>
      html, body {{
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: #000;
        overflow: hidden;
      }}
      .frame {{
        position: fixed;
        inset: 0;
        width: 100%;
        height: 100%;
        border: 0;
      }}
    </style>
  </head>
  <body>
    <iframe
      class="frame"
      src="{viewer_url}"
      title="Live Stream"
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-storage-access-by-user-activation"
      referrerpolicy="no-referrer-when-downgrade"
      allow="autoplay; fullscreen; picture-in-picture; microphone; camera; storage-access"
      allowfullscreen
    ></iframe>
  </body>
</html>"""

    # No caching: viewer state is time-sensitive.
    return HTMLResponse(content=html, headers={"Cache-Control": "no-store"})



@app.get("/stream/beestreamed/broadcaster/{event_ref}", response_class=HTMLResponse)
async def beestreamed_broadcaster_page(event_ref: str):
    """Render the BeeStreamed *broadcaster / producer* UI inside a sandboxed iframe."""
    event_ref = (event_ref or "").strip()
    if not event_ref:
        raise HTTPException(status_code=400, detail="event_ref is required")

    producer_url = _beestreamed_broadcaster_ui_url(event_ref)
    if not producer_url:
        raise HTTPException(
            status_code=500,
            detail="Producer View URL could not be resolved. Configure BEESTREAMED_PRODUCER_URL_TEMPLATE (preferred) or BEESTREAMED_PRODUCER_BASE.",
        )

    html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Broadcast</title>
    <style>
      html, body {{
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: #000;
        overflow: hidden;
      }}
      .frame {{
        position: fixed;
        inset: 0;
        width: 100%;
        height: 100%;
        border: 0;
      }}
    </style>
  </head>
  <body>
    <iframe
      class="frame"
      src="{producer_url}"
      title="Broadcast"
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-storage-access-by-user-activation"
      referrerpolicy="no-referrer-when-downgrade"
      allow="autoplay; fullscreen; picture-in-picture; microphone; camera; display-capture; storage-access"
      allowfullscreen
    ></iframe>
  </body>
</html>"""

    # No caching: broadcast UI is stateful.
    return HTMLResponse(content=html, headers={"Cache-Control": "no-store"})


def _beestreamed_auth_headers() -> Dict[str, str]:
    token_id = (os.getenv("STREAM_TOKEN_ID", "") or "").strip()
    secret_key = (os.getenv("STREAM_SECRET_KEY", "") or "").strip()
    if not token_id or not secret_key:
        raise HTTPException(status_code=500, detail="STREAM_TOKEN_ID / STREAM_SECRET_KEY are not configured")

    basic = base64.b64encode(f"{token_id}:{secret_key}".encode("utf-8")).decode("utf-8")
    return {"Authorization": f"Basic {basic}", "Content-Type": "application/json"}

def _beestreamed_create_event_sync(embed_domain: str = "") -> str:
    import requests  # type: ignore

    api_base = _beestreamed_api_base()
    headers = _beestreamed_auth_headers()

    # Create an event
    try:
        r = requests.post(f"{api_base}/events", headers=headers, json={}, timeout=20)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"BeeStreamed create event failed: {e!r}")

    if r.status_code >= 400:
        msg = (r.text or "").strip()
        raise HTTPException(status_code=r.status_code, detail=f"BeeStreamed create event error {r.status_code}: {msg[:500]}")

    try:
        data = r.json()
    except Exception:
        data = {}

    event_ref = (data.get("event_ref") or data.get("eventRef") or data.get("id") or "").strip()
    if not event_ref:
        raise HTTPException(status_code=502, detail="BeeStreamed create event did not return an event_ref")

    # Best-effort: set embed domain on the event so the iframe host is allowed.
    # If this fails, we continue — the embed may still work depending on BeeStreamed account settings.
    embed_domain = (embed_domain or "").strip()
    if embed_domain:
        try:
            requests.patch(
                f"{api_base}/events/{event_ref}",
                headers=headers,
                json={"event_embed_domain": embed_domain},
                timeout=20,
            )
        except Exception:
            pass

    return event_ref


def _beestreamed_schedule_now_sync(event_ref: str, *, title: str = "", embed_domain: str = "") -> None:
    """Best-effort: set the event date to 'now' so the event is effectively scheduled immediately.

    BeeStreamed docs: PATCH /events/[EVENT REF] supports `date` (formatted) and `title`.
    Examples in the docs show date like "YYYY-MM-DD HH:MM:SS". citeturn3view1turn3view0
    """
    import requests  # type: ignore
    api_base = _beestreamed_api_base()
    headers = _beestreamed_auth_headers()

    ref = (event_ref or "").strip()
    if not ref:
        return

    payload = {}
    # Use UTC to avoid timezone ambiguity across API hosts.
    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    payload["date"] = now_str

    if (title or "").strip():
        payload["title"] = (title or "").strip()

    # Some BeeStreamed accounts may accept embed domain as a field; we keep this best-effort.
    # If not supported, BeeStreamed will ignore or reject; we swallow failures.
    if (embed_domain or "").strip():
        payload["event_embed_domain"] = (embed_domain or "").strip()

    try:
        requests.patch(f"{api_base}/events/{ref}", headers=headers, json=payload, timeout=20)
    except Exception:
        pass

def _beestreamed_start_webrtc_sync(event_ref: str) -> None:
    import requests  # type: ignore
    api_base = _beestreamed_api_base()
    headers = _beestreamed_auth_headers()

    try:
        r = requests.post(f"{api_base}/events/{event_ref}/startwebrtcstream", headers=headers, timeout=20)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"BeeStreamed start failed: {e!r}")

    if r.status_code >= 400:
        msg = (r.text or "").strip()
        raise HTTPException(status_code=r.status_code, detail=f"BeeStreamed start error {r.status_code}: {msg[:500]}")

def _beestreamed_stop_webrtc_sync(event_ref: str) -> None:
    import requests  # type: ignore
    api_base = _beestreamed_api_base()
    headers = _beestreamed_auth_headers()

    try:
        r = requests.post(f"{api_base}/events/{event_ref}/stopwebrtcstream", headers=headers, timeout=20)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"BeeStreamed stop failed: {e!r}")

    if r.status_code >= 400:
        msg = (r.text or "").strip()
        raise HTTPException(status_code=r.status_code, detail=f"BeeStreamed stop error {r.status_code}: {msg[:500]}")

def _resolve_host_member_id(brand: str, avatar: str, mapping: Optional[Dict[str, Any]]) -> str:
    host = ""
    if mapping:
        host = str(mapping.get("host_member_id") or "").strip()

    # Fallback for current single-host deployment (DulceMoon/Dulce).
    if not host:
        if (brand or "").strip().lower() == "dulcemoon" and (avatar or "").strip().lower().startswith("dulce"):
            host = DULCE_HOST_MEMBER_ID_FALLBACK
    return host

def _persist_event_ref_strict(brand: str, avatar: str, event_ref: str) -> None:
    """Persist event_ref into `voice_video_mappings.sqlite3` (strict + verified).

    Requirements:
      - Uses ONLY the mapping DB file resolved at startup.
      - Must update the host's record so we do NOT create a new BeeStreamed event on each Play.
      - If persistence fails, raise (do not silently continue).

    Notes:
      - We update the in-memory mapping cache first (for this process).
      - Then we take a filesystem lock and update SQLite.
      - Finally, we VERIFY by reading back the stored value.
    """
    b_in = (brand or "").strip()
    a_in = (avatar or "").strip()
    e = (event_ref or "").strip()
    if not b_in or not a_in or not e:
        raise RuntimeError("persist_event_ref: brand, avatar, and event_ref are required")

    if not _MAPPING_DB_PATH or not _MAPPING_DB_TABLE:
        raise RuntimeError("persist_event_ref: mappings DB was not initialized at startup")

    mapping = _lookup_companion_mapping(b_in, a_in)
    if not mapping:
        raise RuntimeError(f"persist_event_ref: companion mapping not found for {b_in}/{a_in}")

    # Update in-memory cache using the same key normalization as lookups.
    try:
        mapping["event_ref"] = e
    except Exception:
        pass

    rowid = 0
    try:
        rowid = int(mapping.get("__rowid") or 0)
    except Exception:
        rowid = 0

    host_member_id = str(mapping.get("host_member_id") or "").strip()

    def _pick_col(cols_lc: Dict[str, str], *candidates: str) -> str:
        for cand in candidates:
            real = cols_lc.get(str(cand).lower())
            if real:
                return real
        return ""

    def _sql_norm(col_expr: str) -> str:
        # Normalize similarly to _norm_key: trim, lowercase, remove spaces/underscores.
        return f"lower(replace(replace(trim({col_expr}), ' ', ''), '_', ''))"

    # Serialize writes to the DB to avoid race conditions/corruption.
    lock = FileLock(f"{_MAPPING_DB_PATH}.lock")
    with lock:
        conn = sqlite3.connect(_MAPPING_DB_PATH, timeout=30)
        try:
            cur = conn.cursor()

            # Discover columns for the chosen table
            cur.execute(f'PRAGMA table_info("{_MAPPING_DB_TABLE}")')
            cols = [str(r[1] or "").strip() for r in cur.fetchall() if r and r[1]]
            cols_lc = {c.lower(): c for c in cols if c}

            # Determine the actual event_ref column name (case-insensitive). Add if missing.
            event_col = _pick_col(
                cols_lc,
                _MAPPING_DB_EVENT_REF_COL or "",
                "event_ref",
                "eventref",
                "eventRef",
                "EventRef",
                "EVENT_REF",
            )
            if not event_col:
                try:
                    cur.execute(f'ALTER TABLE "{_MAPPING_DB_TABLE}" ADD COLUMN event_ref TEXT')
                    conn.commit()
                    event_col = "event_ref"
                except Exception as ex:
                    raise RuntimeError(
                        f"persist_event_ref: table '{_MAPPING_DB_TABLE}' lacks event_ref and cannot be altered: {ex!r}"
                    )

            def _confirm_by_rowid(rid: int) -> bool:
                if rid <= 0:
                    return False
                cur.execute(
                    f'SELECT "{event_col}" FROM "{_MAPPING_DB_TABLE}" WHERE rowid = ?',
                    (rid,),
                )
                row = cur.fetchone()
                if not row:
                    return False
                stored = str(row[0] or "").strip()
                return stored == e

            updated = False

            # 1) Preferred: update by rowid if we have it.
            if rowid > 0:
                cur.execute(
                    f'UPDATE "{_MAPPING_DB_TABLE}" SET "{event_col}" = ? WHERE rowid = ?',
                    (e, rowid),
                )
                conn.commit()
                # rowcount can be 0 if value was already the same; confirm by read-back.
                if _confirm_by_rowid(rowid):
                    updated = True

            # 2) Fallback: update by host_member_id if present (host record targeting).
            if not updated and host_member_id:
                host_col = _pick_col(
                    cols_lc,
                    "host_member_id",
                    "hostMemberId",
                    "HOST_MEMBER_ID",
                    "host_id",
                    "HostId",
                    "member_id",
                    "memberId",
                )
                if host_col:
                    cur.execute(
                        f'UPDATE "{_MAPPING_DB_TABLE}" SET "{event_col}" = ? WHERE trim("{host_col}") = ?',
                        (e, host_member_id),
                    )
                    conn.commit()
                    # Verify by selecting back.
                    cur.execute(
                        f'SELECT "{event_col}" FROM "{_MAPPING_DB_TABLE}" WHERE trim("{host_col}") = ? LIMIT 1',
                        (host_member_id,),
                    )
                    row = cur.fetchone()
                    if row and str(row[0] or "").strip() == e:
                        updated = True

            # 3) Fallback: update by normalized brand/avatar match.
            if not updated:
                brand_col = _pick_col(cols_lc, "brand", "rebranding", "company", "brand_id", "Brand")
                avatar_col = _pick_col(cols_lc, "avatar", "companion", "first_name", "firstname", "Companion")

                if not brand_col or not avatar_col:
                    raise RuntimeError(
                        f"persist_event_ref: cannot locate brand/avatar columns in '{_MAPPING_DB_TABLE}'"
                    )

                b_norm = _norm_key(b_in)
                a_norm = _norm_key(a_in)

                brand_expr = _sql_norm(f'"{brand_col}"')
                avatar_expr = _sql_norm(f'"{avatar_col}"')

                cur.execute(
                    f'UPDATE "{_MAPPING_DB_TABLE}" '
                    f'SET "{event_col}" = ? '
                    f'WHERE {brand_expr} = ? AND {avatar_expr} = ?',
                    (e, b_norm, a_norm),
                )
                conn.commit()

                # Verify by selecting back.
                cur.execute(
                    f'SELECT "{event_col}" FROM "{_MAPPING_DB_TABLE}" '
                    f'WHERE {brand_expr} = ? AND {avatar_expr} = ? LIMIT 1',
                    (b_norm, a_norm),
                )
                row = cur.fetchone()
                if row and str(row[0] or "").strip() == e:
                    updated = True

            if not updated:
                raise RuntimeError(
                    f"persist_event_ref: failed to persist event_ref for {b_in}/{a_in}. "
                    f"DB={_MAPPING_DB_PATH} table={_MAPPING_DB_TABLE}. "
                    f"Ensure the DB is writable and the mapping row exists."
                )

        finally:
            try:
                conn.close()
            except Exception:
                pass



def _db_read_event_ref_sync(brand: str, avatar: str, host_member_id: str = "") -> str:
    """Read the persisted event_ref for (brand, avatar) from voice_video_mappings.sqlite3.

    This is intentionally a DB read (not cache) to support multi-worker/multi-instance deployments.
    """
    b_in = (brand or "").strip()
    a_in = (avatar or "").strip()
    if not b_in or not a_in:
        return ""

    if not _MAPPING_DB_PATH or not _MAPPING_DB_TABLE:
        raise RuntimeError("db_read_event_ref: mappings DB was not initialized at startup")

    def _pick_col(cols_lc: Dict[str, str], *candidates: str) -> str:
        for cand in candidates:
            real = cols_lc.get(str(cand).lower())
            if real:
                return real
        return ""

    def _sql_norm(col_expr: str) -> str:
        return f"lower(replace(replace(trim({col_expr}), ' ', ''), '_', ''))"

    lock = FileLock(f"{_MAPPING_DB_PATH}.lock")
    with lock:
        conn = sqlite3.connect(_MAPPING_DB_PATH, timeout=30)
        try:
            cur = conn.cursor()
            cur.execute(f'PRAGMA table_info("{_MAPPING_DB_TABLE}")')
            cols = [str(r[1] or "").strip() for r in cur.fetchall() if r and r[1]]
            cols_lc = {c.lower(): c for c in cols if c}

            event_col = _pick_col(
                cols_lc,
                _MAPPING_DB_EVENT_REF_COL or "",
                "event_ref",
                "eventref",
                "eventRef",
                "EventRef",
                "EVENT_REF",
            )
            if not event_col:
                return ""

            # Prefer host_member_id match when provided
            hm = (host_member_id or "").strip()
            if hm:
                host_col = _pick_col(
                    cols_lc,
                    "host_member_id",
                    "hostMemberId",
                    "HOST_MEMBER_ID",
                    "host_id",
                    "HostId",
                    "member_id",
                    "memberId",
                )
                if host_col:
                    cur.execute(
                        f'SELECT "{event_col}" FROM "{_MAPPING_DB_TABLE}" WHERE trim("{host_col}") = ? LIMIT 1',
                        (hm,),
                    )
                    row = cur.fetchone()
                    if row:
                        val = str(row[0] or "").strip()
                        if val:
                            return val

            brand_col = _pick_col(cols_lc, "brand", "rebranding", "company", "brand_id", "Brand")
            avatar_col = _pick_col(cols_lc, "avatar", "companion", "first_name", "firstname", "Companion")
            if not brand_col or not avatar_col:
                return ""

            b_norm = _norm_key(b_in)
            a_norm = _norm_key(a_in)
            brand_expr = _sql_norm(f'"{brand_col}"')
            avatar_expr = _sql_norm(f'"{avatar_col}"')

            cur.execute(
                f'SELECT "{event_col}" FROM "{_MAPPING_DB_TABLE}" '
                f'WHERE {brand_expr} = ? AND {avatar_expr} = ? LIMIT 1',
                (b_norm, a_norm),
            )
            row = cur.fetchone()
            if not row:
                return ""
            return str(row[0] or "").strip()
        finally:
            try:
                conn.close()
            except Exception:
                pass


class BeeStreamedStartEmbedRequest(BaseModel):
    brand: str
    avatar: str
    embedDomain: Optional[str] = None
    memberId: Optional[str] = None

class BeeStreamedStopEmbedRequest(BaseModel):
    brand: str
    avatar: str
    memberId: Optional[str] = None
    eventRef: Optional[str] = None

class BeeStreamedCreateEventRequest(BaseModel):
    """Create a BeeStreamed event for a specific (brand, avatar) mapping.

    Only the user whose memberId matches the mapping's host_member_id may create/start the event.
    Credentials are taken from env on the API host:
      - STREAM_TOKEN_ID
      - STREAM_SECRET_KEY
    """
    brand: str
    avatar: str
    memberId: str
    embedDomain: Optional[str] = None
    startStream: bool = True


class BeeStreamedEmbedUrlRequest(BaseModel):
    """Resolve a BeeStreamed embed URL that stays inside our iframe wrapper.

    Accepts either:
      - eventRef / event_ref, OR
      - streamUrl / stream_url (we'll try to parse the event ref out of it)
    """
    eventRef: Optional[str] = None
    streamUrl: Optional[str] = None


class BeeStreamedLiveChatSendRequest(BaseModel):
    """Send a message to the shared in-stream chat room (HTTP fallback).

    Frontend primarily uses WebSockets, but this endpoint provides a reliable
    fallback (e.g., before WS connect finishes).
    """

    eventRef: str
    text: str

    brand: Optional[str] = None
    avatar: Optional[str] = None
    memberId: Optional[str] = None
    role: Optional[str] = None  # "host" | "viewer"
    name: Optional[str] = None
    clientMsgId: Optional[str] = None
    ts: Optional[int] = None


@app.post("/stream/beestreamed/start_embed")
async def beestreamed_start_embed(req: BeeStreamedStartEmbedRequest):
    brand = (req.brand or "").strip()
    avatar = (req.avatar or "").strip()
    if not brand or not avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required")

    mapping = _lookup_companion_mapping(brand, avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="Companion mapping not found")

    # Use the resolved mapping keys for persistence (first-name fallback etc).
    resolved_brand = str(mapping.get("brand") or brand).strip()
    resolved_avatar = str(mapping.get("avatar") or avatar).strip()

    live = str(mapping.get("live") or "").strip().lower()

    # Be tolerant of values like "Stream", "BeeStreamed", or labels that include these keywords.
    if "stream" not in live:
        raise HTTPException(status_code=400, detail="This companion is not configured for stream")

    comp_type = str(mapping.get("companion_type") or "").strip()
    if comp_type and comp_type.lower() != "human":
        raise HTTPException(status_code=400, detail="This companion is not configured as a Human livestream")

    member_id = (req.memberId or "").strip()
    host_id = _resolve_host_member_id(resolved_brand, resolved_avatar, mapping)
    is_host = bool(host_id and member_id and member_id == host_id)

    # Refresh event_ref from SQLite on every call (important for multi-instance deployments).
    # Without this, one server instance may persist the event_ref, but another instance (with a warm cache)
    # could still see an empty event_ref and create a new BeeStreamed event on each Play.
    try:
        db_event_ref = _db_read_event_ref_sync(resolved_brand, resolved_avatar, host_id or "")
        if db_event_ref:
            mapping["event_ref"] = db_event_ref
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Failed to read voice_video_mappings.sqlite3: {ex}")

    event_ref = str(mapping.get("event_ref") or "").strip()
    created_in_this_call = False

    # Only the host is allowed to create the event_ref automatically.
    if not event_ref and is_host:
        created_in_this_call = True
        event_ref = _beestreamed_create_event_sync((req.embedDomain or "").strip())
        _persist_event_ref_strict(resolved_brand, resolved_avatar, event_ref)

    # If we still have no event_ref, non-host users should wait.
    if not event_ref:
        return {
            "ok": True,
            "status": "waiting_for_host",
            "canStart": False,
            "isHost": False,
            "eventRef": "",
            "embedUrl": "",
            "message": f"Waiting on {resolved_avatar} to start event",
        }

    embed_url = f"/stream/beestreamed/embed/{event_ref}"

    if not is_host:
        return {
            "ok": True,
            "status": "waiting_for_host",
            "canStart": False,
            "isHost": False,
            "eventRef": event_ref,
            "embedUrl": embed_url,
            "message": f"Waiting on {resolved_avatar} to start event",
        }

    # Host: mark the stream session as active as soon as the host hits Play.
    # This drives the "in a live session" gating for everyone else (visitors + members) *before* "Go Live".
    #
    # NOTE: We set this flag before talking to BeeStreamed so that even if BeeStreamed calls take a moment,
    # clients immediately start gating messages.
    _set_stream_session_active(resolved_brand, resolved_avatar, True, event_ref)

    # Host: ensure the event is scheduled for 'now' and then start the WebRTC stream.
    # If BeeStreamed returns a 404 for an existing/stale event_ref, we transparently generate a fresh one,
    # persist it, and retry once.
    def _start_event(_ref: str) -> None:
        _beestreamed_schedule_now_sync(
            _ref,
            title=f"{resolved_avatar} Live",
            embed_domain=(req.embedDomain or "").strip(),
        )
        _beestreamed_start_webrtc_sync(_ref)

    try:
        _start_event(event_ref)
    except HTTPException as e:
        if int(getattr(e, "status_code", 0) or 0) == 404:
            if created_in_this_call:
                # Sometimes BeeStreamed is eventually-consistent right after creation; retry once.
                import time as _time

                _time.sleep(1.0)
                _start_event(event_ref)
            else:
                # Stale/invalid event_ref in DB: regenerate, persist, and retry once.
                event_ref = _beestreamed_create_event_sync((req.embedDomain or "").strip())
                _persist_event_ref_strict(resolved_brand, resolved_avatar, event_ref)
                embed_url = f"/stream/beestreamed/embed/{event_ref}"

                # Update session event_ref immediately so pollers see the correct event id.
                _set_stream_session_active(resolved_brand, resolved_avatar, True, event_ref)

                _start_event(event_ref)
        else:
            # If we fail to start the event, clear the session flag so clients don't stay gated.
            _set_stream_session_active(resolved_brand, resolved_avatar, False, "")
            raise
    except Exception:
        # Non-HTTP error: clear the session flag so clients don't stay gated.
        _set_stream_session_active(resolved_brand, resolved_avatar, False, "")
        raise

    # Ensure the stored session event_ref matches the final event_ref we ended up using.
    _set_stream_session_active(resolved_brand, resolved_avatar, True, event_ref)

    return {
        "ok": True,
        "status": "started",
        "canStart": True,
        "isHost": True,
        "eventRef": event_ref,
        "embedUrl": embed_url,
        "message": "",
    }






@app.post("/stream/beestreamed/start_broadcast")
async def beestreamed_start_broadcast(req: BeeStreamedStartEmbedRequest):
    """Host helper: prepare a BeeStreamed event and return a broadcaster iframe URL.

    - Uses the same host-gating logic as /stream/beestreamed/start_embed.
    - Ensures the event exists (host-only), schedules it for "now", and starts the WebRTC stream.
    - Returns a same-origin wrapper URL (/stream/beestreamed/broadcaster/{event_ref}) suitable for iframing.

    Frontend intent:
      - The host can click "Broadcast" and immediately see the BeeStreamed broadcaster UI already pointed at the
        correct event; they only need to press "Go Live" in the BeeStreamed Producer View.
    """
    data = await beestreamed_start_embed(req)

    try:
        is_host = bool(data.get("isHost"))
        event_ref = str(data.get("eventRef") or "").strip()
    except Exception:
        is_host = False
        event_ref = ""

    data["broadcasterUrl"] = f"/stream/beestreamed/broadcaster/{event_ref}" if (is_host and event_ref) else ""
    return data



@app.post("/stream/beestreamed/create_event")
async def beestreamed_create_event(req: BeeStreamedCreateEventRequest):
    """Create (and optionally start) a BeeStreamed event for a configured companion.

    Authorization rule:
      - Only the host (memberId == host_member_id in voice_video_mappings.sqlite3) may create/start.
      - Everyone else gets a "waiting" response.
    """
    brand = (req.brand or "").strip()
    avatar = (req.avatar or "").strip()
    member_id = (req.memberId or "").strip()

    if not brand or not avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required")

    mapping = _lookup_companion_mapping(brand, avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="Companion mapping not found")

    resolved_brand = str(mapping.get("brand") or brand).strip()
    resolved_avatar = str(mapping.get("avatar") or avatar).strip()

    live = str(mapping.get("live") or "").strip().lower()
    if "stream" not in live:
        raise HTTPException(status_code=400, detail="This companion is not configured for stream")

    comp_type = str(mapping.get("companion_type") or "").strip()
    if comp_type and comp_type.lower() != "human":
        raise HTTPException(status_code=400, detail="This companion is not configured as a Human livestream")

    host_id = _resolve_host_member_id(resolved_brand, resolved_avatar, mapping)
    is_host = bool(host_id and member_id and member_id == host_id)

    if not is_host:
        existing_ref = str(mapping.get("event_ref") or "").strip()
        return {
            "ok": True,
            "status": "waiting_for_host",
            "canStart": False,
            "isHost": False,
            "eventRef": existing_ref,
            "embedUrl": f"/stream/beestreamed/embed/{existing_ref}" if existing_ref else "",
            "message": f"Waiting on {resolved_avatar} to start event",
        }

    # Host path: reuse existing event_ref if present, else create and persist.
    event_ref = str(mapping.get("event_ref") or "").strip()
    created_in_this_call = False
    if not event_ref:
        created_in_this_call = True
        event_ref = _beestreamed_create_event_sync((req.embedDomain or "").strip())
        _persist_event_ref_strict(resolved_brand, resolved_avatar, event_ref)

    if bool(req.startStream):
        def _start_event(_ref: str) -> None:
            _beestreamed_schedule_now_sync(_ref, title=f"{resolved_avatar} Live", embed_domain=(req.embedDomain or "").strip())
            _beestreamed_start_webrtc_sync(_ref)

        try:
            _start_event(event_ref)
        except HTTPException as e:
            if int(getattr(e, "status_code", 0) or 0) == 404:
                if created_in_this_call:
                    import time as _time

                    _time.sleep(1.0)
                    _start_event(event_ref)
                else:
                    event_ref = _beestreamed_create_event_sync((req.embedDomain or "").strip())
                    _persist_event_ref_strict(resolved_brand, resolved_avatar, event_ref)
                    _start_event(event_ref)
            else:
                raise

    return {
        "ok": True,
        "status": "started",
        "canStart": True,
        "isHost": True,
        "eventRef": event_ref,
        "embedUrl": f"/stream/beestreamed/embed/{event_ref}",
        "message": "",
    }



@app.get("/stream/beestreamed/status")
async def beestreamed_status(brand: str, avatar: str):
    """Return current BeeStreamed mapping state for a companion (does not start anything)."""
    brand = (brand or "").strip()
    avatar = (avatar or "").strip()
    if not brand or not avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required")

    mapping = _lookup_companion_mapping(brand, avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="Companion mapping not found")

    resolved_brand = str(mapping.get("brand") or brand).strip()
    resolved_avatar = str(mapping.get("avatar") or avatar).strip()

    event_ref = str(mapping.get("event_ref") or "").strip()
    host_id = _resolve_host_member_id(resolved_brand, resolved_avatar, mapping)

    session_active = _get_stream_session_active(resolved_brand, resolved_avatar)
    session_event_ref = _get_stream_session_event_ref(resolved_brand, resolved_avatar)

    return {
        "ok": True,
        "eventRef": event_ref,
        "embedUrl": f"/stream/beestreamed/embed/{event_ref}" if event_ref else "",
        "hostMemberId": host_id,
        "sessionActive": bool(session_active),
        "sessionEventRef": session_event_ref,

        "companionType": str(mapping.get("companion_type") or "").strip(),
        "live": str(mapping.get("live") or "").strip(),
    }
@app.post("/stream/beestreamed/embed_url")
async def beestreamed_embed_url(req: BeeStreamedEmbedUrlRequest):
    """Return an embeddable URL that *cannot* pop out of the iframe.

    This is useful when the frontend already has an eventRef (or a BeeStreamed viewer URL)
    and only needs the safe wrapper URL for the iframe container.
    """
    event_ref = (req.eventRef or "").strip()
    stream_url = (req.streamUrl or "").strip()

    if not event_ref and stream_url:
        event_ref = _extract_beestreamed_event_ref_from_url(stream_url)

    if not event_ref:
        raise HTTPException(status_code=400, detail="eventRef (or a streamUrl containing it) is required")

    return {
        "ok": True,
        "eventRef": event_ref,
        "embedUrl": f"/stream/beestreamed/embed/{event_ref}",
    }
@app.post("/stream/beestreamed/stop_embed")
async def beestreamed_stop_embed(req: BeeStreamedStopEmbedRequest):
    brand = (req.brand or "").strip()
    avatar = (req.avatar or "").strip()
    if not brand or not avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required")

    mapping = _lookup_companion_mapping(brand, avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="Companion mapping not found")

    resolved_brand = str(mapping.get("brand") or brand).strip()
    resolved_avatar = str(mapping.get("avatar") or avatar).strip()

    member_id = (req.memberId or "").strip()
    host_id = _resolve_host_member_id(resolved_brand, resolved_avatar, mapping)
    is_host = bool(host_id and member_id and member_id == host_id)

    if not is_host:
        return {"ok": True, "status": "not_host"}

    event_ref = (req.eventRef or "").strip() or str(mapping.get("event_ref") or "").strip()
    if not event_ref:
        return {"ok": True, "status": "no_event"}

    _beestreamed_stop_webrtc_sync(event_ref)

    # Mark session inactive for global gating (host-only)
    _set_stream_session_active(resolved_brand, resolved_avatar, False, event_ref)

    # Close any in-stream live chat sockets for this event (best-effort).
    try:
        asyncio.create_task(_LIVECHAT.close_room(event_ref, reason="session_ended"))
    except Exception:
        pass

    return {"ok": True, "status": "stopped", "eventRef": event_ref}


@app.post("/stream/beestreamed/livechat/send")
async def beestreamed_livechat_send(req: BeeStreamedLiveChatSendRequest):
    """HTTP fallback for sending live chat messages.

    The frontend primarily uses WebSockets, but this endpoint is useful when the
    user sends a message before the WS handshake completes.
    """

    event_ref = (req.eventRef or "").strip()
    text = (req.text or "").strip()
    if not event_ref:
        raise HTTPException(status_code=400, detail="eventRef is required")
    if not text:
        return {"ok": True, "status": "empty"}

    # Only the Host can initiate shared in-stream chat. Viewers may only send once the
    # Host has activated the BeeStreamed session (Host pressed Play).
    if not _is_stream_session_active_for_event_ref(event_ref):
        raise HTTPException(status_code=409, detail="Stream session is not active")

    member_id = (req.memberId or "").strip() or f"anon:{uuid.uuid4().hex}"
    role = (req.role or "viewer").strip().lower()
    if role not in {"host", "viewer"}:
        role = "viewer"

    # Deterministic display name (can be overridden by optional req.name)
    name = (req.name or "").strip()
    if not name:
        if role == "host":
            name = "Host"
        else:
            tail = member_id[-4:] if member_id else ""
            name = f"Viewer-{tail}" if tail else "Viewer"

    client_msg_id = (req.clientMsgId or "").strip() or uuid.uuid4().hex
    ts = int(req.ts or int(time.time() * 1000))

    payload = {
        "type": "chat",
        "eventRef": event_ref,
        "text": text[:4000],
        "senderId": member_id,
        "senderRole": role,
        "name": name,
        "clientMsgId": client_msg_id,
        "ts": ts,
    }

    await _LIVECHAT.broadcast(event_ref, payload)
    return {"ok": True}


@app.websocket("/stream/beestreamed/livechat/{event_ref}")
async def beestreamed_livechat_ws(websocket: WebSocket, event_ref: str):
    """WebSocket room for BeeStreamed in-stream chat.

    Query params:
      - memberId: viewer/host id (Wix memberId or our anon:... id)
      - role: host|viewer
      - name: optional display label
    """

    ref = (event_ref or "").strip()
    if not ref:
        await websocket.close(code=1008)
        return

    # Only the Host can initiate shared in-stream chat. Reject early join attempts.
    if not _is_stream_session_active_for_event_ref(ref):
        try:
            await websocket.accept()
        except Exception:
            pass
        try:
            await websocket.send_json({"type": "inactive", "detail": "Stream session is not active"})
        except Exception:
            pass
        try:
            await websocket.close(code=1008)
        except Exception:
            pass
        return

    qp = websocket.query_params
    member_id = (qp.get("memberId") or "").strip() or f"anon:{uuid.uuid4().hex}"
    role = (qp.get("role") or "viewer").strip().lower()
    if role not in {"host", "viewer"}:
        role = "viewer"
    name = (qp.get("name") or "").strip()
    if not name:
        if role == "host":
            name = "Host"
        else:
            tail = member_id[-4:] if member_id else ""
            name = f"Viewer-{tail}" if tail else "Viewer"

    history = await _LIVECHAT.connect(ref, websocket)
    try:
        if history:
            await websocket.send_json({"type": "history", "messages": history})

        while True:
            try:
                data = await websocket.receive_json()
            except Exception:
                # Fall back to raw text
                raw = await websocket.receive_text()
                try:
                    data = json.loads(raw)
                except Exception:
                    continue

            if not isinstance(data, dict):
                continue

            msg_type = str(data.get("type") or "chat").strip().lower()
            if msg_type != "chat":
                continue

            text = str(data.get("text") or "").strip()
            if not text:
                continue

            client_msg_id = str(data.get("clientMsgId") or "").strip() or uuid.uuid4().hex
            ts = int(data.get("ts") or int(time.time() * 1000))

            payload = {
                "type": "chat",
                "eventRef": ref,
                "text": text[:4000],
                "senderId": member_id,
                "senderRole": role,
                "name": name,
                "clientMsgId": client_msg_id,
                "ts": ts,
            }

            await _LIVECHAT.broadcast(ref, payload)
    except WebSocketDisconnect:
        pass
    except Exception:
        # Never crash the app on websocket errors
        pass
    finally:
        await _LIVECHAT.disconnect(ref, websocket)


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
def _usage_status_message(
    *,
    is_trial: bool,
    plan_name: str,
    minutes_used: int,
    minutes_allowed: int,
    minutes_remaining: int,
    cycle_days: int,
    upgrade_url: str = "",
    payg_pay_url: str = "",
    payg_increment_minutes: Optional[int] = None,
    payg_price_text: str = "",
) -> str:
    """Generate a short, deterministic answer about remaining minutes.

    This is used when the user asks questions like:
      - "How many minutes do I have left?"
      - "How many more minutes can we talk?"
      - "How much time do I have remaining on my plan?"

    The response is intentionally plain so it can be spoken via TTS.
    """
    lines: List[str] = []

    m_used = max(0, int(minutes_used or 0))
    m_allowed = max(0, int(minutes_allowed or 0))
    m_rem = max(0, int(minutes_remaining or 0))

    if is_trial:
        lines.append(f"You have {m_rem} minutes remaining in your Free Trial.")
    else:
        nice_plan = (plan_name or "").strip()
        if nice_plan:
            lines.append(f"You have {m_rem} minutes remaining on your plan ({nice_plan}).")
        else:
            lines.append(f"You have {m_rem} minutes remaining on your plan.")

    # Include a small breakdown for clarity.
    if m_allowed > 0 or m_used > 0:
        lines.append(f"Used: {m_used} of {m_allowed} minutes.")

    if (not is_trial) and int(cycle_days or 0) > 0:
        lines.append(f"Your usage cycle resets every {int(cycle_days)} days.")

    # If exhausted, include the same upgrade/pay links used by the paywall.
    if m_rem <= 0:
        resolved_upgrade_url = (upgrade_url or "").strip() or UPGRADE_URL
        resolved_payg_pay_url = (payg_pay_url or "").strip() or PAYG_PAY_URL
        resolved_payg_minutes = (
            int(payg_increment_minutes) if payg_increment_minutes is not None else int(PAYG_INCREMENT_MINUTES or 0)
        )
        resolved_payg_price_text = (payg_price_text or "").strip() or PAYG_PRICE_TEXT

        if resolved_payg_pay_url and resolved_payg_minutes > 0:
            price_part = f" ({resolved_payg_price_text})" if resolved_payg_price_text else ""
            lines.append(f"Add {resolved_payg_minutes} minutes{price_part}: {resolved_payg_pay_url}")

        if resolved_upgrade_url:
            lines.append(f"Upgrade your membership: {resolved_upgrade_url}")

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
def _is_minutes_balance_question(text: str) -> bool:
    """Detect user questions about remaining/available plan minutes.

    Examples we want to catch:
      - "How many more minutes do I have on my plan?"
      - "How many minutes are left?"
      - "Minutes remaining?"
      - "How long can I talk to you?"
      - "What's my minutes balance / usage?"

    We keep this intentionally conservative to avoid false triggers.
    """
    t = (text or "").strip().lower()
    if not t:
        return False

    # Avoid a common unrelated question.
    if re.search(r"\bwhat time is it\b", t):
        return False

    # Strong patterns (explicit "how many/much" + minutes/time + left/remaining)
    if re.search(r"\bhow\s+(many|much)\b.*\b(minutes?|time)\b.*\b(left|remaining|available)\b", t):
        return True

    # "minutes remaining", "time left", etc with plan/usage keywords
    if re.search(r"\b(minutes?|time)\b.*\b(left|remaining|available)\b", t) and re.search(
        r"\b(plan|trial|subscription|membership|usage|balance|quota|included)\b", t
    ):
        return True

    # Short forms: "minutes left?", "minutes available?"
    if re.search(r"\bminutes?\b", t) and re.search(r"\b(left|remaining|available|balance|used)\b", t):
        return True

    # "How long can I talk/speak/chat?"
    if re.search(r"\bhow\s+long\b.*\b(can|may)\s+i\b.*\b(talk|speak|chat)\b", t):
        return True

    # "check my usage" / "show my minutes"
    if re.search(r"\b(check|show)\b.*\b(usage|minutes?|balance)\b", t):
        return True

    return False




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


    # Special-case: allow "minutes remaining" questions to return a status message
    # even when minutes are exhausted (no OpenAI call).
    probe_last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    probe_text = ((probe_last_user.get("content") if probe_last_user else "") or "").strip()
    is_minutes_balance_query = _is_minutes_balance_question(probe_text)

    if not usage_ok and not is_minutes_balance_query:
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

    # If the user is asking about their remaining minutes, answer deterministically
    # (no OpenAI call). This also works when minutes are exhausted.
    if is_minutes_balance_query:
        minutes_used = int(usage_info.get("minutes_used") or 0)
        minutes_allowed = int(usage_info.get("minutes_allowed") or 0)
        minutes_remaining = int(usage_info.get("minutes_remaining") or 0)

        effective_cycle_days = int(cycle_days_override) if cycle_days_override is not None else int(USAGE_CYCLE_DAYS or 0)

        session_state_out = dict(session_state)
        session_state_out.update(
            {
                "minutes_exhausted": minutes_remaining <= 0,
                "minutes_used": minutes_used,
                "minutes_allowed": minutes_allowed,
                "minutes_remaining": minutes_remaining,
            }
        )
        # Ensure mode is always present for the frontend.
        session_state_out["mode"] = session_state_out.get("mode") or "friend"

        reply = _usage_status_message(
            is_trial=is_trial,
            plan_name=plan_label_for_messages,
            minutes_used=minutes_used,
            minutes_allowed=minutes_allowed,
            minutes_remaining=minutes_remaining,
            cycle_days=effective_cycle_days,
            upgrade_url=upgrade_link_override,
            payg_pay_url=pay_go_link_override,
            payg_increment_minutes=pay_go_minutes,
            payg_price_text=payg_price_text_override,
        )
        return await _respond(reply, STATUS_SAFE, session_state_out)

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
