from __future__ import annotations

import os
import time
import threading
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
PAYG_PRICE_TEXT = (os.getenv("PAYG_PRICE_TEXT", "") or "").strip()

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

def _usage_paywall_message(is_trial: bool, plan_name: str, minutes_allowed: int) -> str:
    # Keep this short and plain so it can be spoken via TTS.
    lines: List[str] = []

    if is_trial:
        lines.append(f"Your Free Trial time has ended ({minutes_allowed} minutes).")
    else:
        nice_plan = (plan_name or "").strip()
        if not nice_plan:
            lines.append("Your membership plan is Unknown / Not Provided, so minutes cannot be allocated.")
        else:
            lines.append(f"You have no minutes remaining for your plan ({nice_plan}).")

    if PAYG_PAY_URL:
        price_part = f" ({PAYG_PRICE_TEXT})" if PAYG_PRICE_TEXT else ""
        lines.append(f"Add {PAYG_INCREMENT_MINUTES} minutes{price_part}: {PAYG_PAY_URL}")

    if UPGRADE_URL:
        lines.append(f"Upgrade your membership: {UPGRADE_URL}")

    lines.append("Once you have more minutes, come back here and continue our conversation.")
    return " ".join([ln.strip() for ln in lines if ln.strip()])

def _usage_charge_and_check_sync(identity_key: str, *, is_trial: bool, plan_name: str) -> Tuple[bool, Dict[str, Any]]:
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
            if not is_trial and USAGE_CYCLE_DAYS and USAGE_CYCLE_DAYS > 0:
                cycle_len = float(USAGE_CYCLE_DAYS) * 86400.0
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
    plan_name = _extract_plan_name(session_state)
    is_trial = not bool(member_id)
    identity_key = f"member::{member_id}" if member_id else f"ip::{_get_client_ip(request) or session_id or 'unknown'}"

    usage_ok, usage_info = await run_in_threadpool(
        _usage_charge_and_check_sync,
        identity_key,
        is_trial=is_trial,
        plan_name=plan_name,
    )

    if not usage_ok:
        minutes_allowed = int(
            usage_info.get("minutes_allowed")
            or (TRIAL_MINUTES if is_trial else _included_minutes_for_plan(plan_name))
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
        reply = _usage_paywall_message(is_trial=is_trial, plan_name=plan_name, minutes_allowed=minutes_allowed)
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



# -----------------------------------------------------------------------------
# Option B: Separate journaling endpoint (does NOT stop audio/video/mic)
# -----------------------------------------------------------------------------
#
# Rationale:
# - The existing manual Save Summary flow intentionally stops audio/video/mic for user confirmation.
# - We do NOT want to auto-trigger that flow because it impacts UX.
# - Instead, the frontend can fire-and-forget copies of user + assistant turns to this endpoint.
# - A separate, later process (Azure Function / cron / admin endpoint) can generate summaries
#   from the journal without touching the live chat / TTS / STT pathways.
#
# NOTE: This endpoint is purposely isolated from the /chat logic to avoid any regressions
# in the established TTS/STT pipeline.

_CHAT_JOURNAL_ENABLED = os.getenv("CHAT_JOURNAL_ENABLED", "1").strip() not in ("0", "false", "False", "")

# Default journal directory:
# - If CHAT_SUMMARY_FILE is set to a persistent /home path, we journal next to it.
# - Else, fall back to backend/app/data/journal (inside repo) for local dev.
_CHAT_JOURNAL_DIR = os.getenv("CHAT_JOURNAL_DIR", "").strip()
if not _CHAT_JOURNAL_DIR:
    try:
        _summary_dir = os.path.dirname(os.path.abspath(_CHAT_SUMMARY_FILE)) if _CHAT_SUMMARY_FILE else ""
    except Exception:
        _summary_dir = ""
    if _summary_dir:
        _CHAT_JOURNAL_DIR = os.path.join(_summary_dir, "journal")
    else:
        _CHAT_JOURNAL_DIR = os.path.join(os.path.dirname(__file__), "data", "journal")

_CHAT_JOURNAL_LOCK = threading.RLock()

def _journal_filename_for_key(key: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", key).strip("_") or "unknown"
    return os.path.join(_CHAT_JOURNAL_DIR, f"{safe}.jsonl")

def _append_journal_record(key: str, record: Dict[str, Any]) -> None:
    if not _CHAT_JOURNAL_ENABLED:
        return
    try:
        os.makedirs(_CHAT_JOURNAL_DIR, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False)
        path = _journal_filename_for_key(key)
        with _CHAT_JOURNAL_LOCK:
            with open(path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        # Never allow journaling failures to impact the app
        return

@app.post("/journal/append")
async def journal_append(request: Request) -> Dict[str, Any]:
    if not _CHAT_JOURNAL_ENABLED:
        return {"ok": True, "enabled": False}

    try:
        payload = await request.json()
    except Exception:
        payload = {}

    session_id = str(payload.get("session_id") or "").strip()
    role = str(payload.get("role") or "").strip().lower()
    content = payload.get("content")
    ts = payload.get("ts") or payload.get("timestamp") or None

    session_state = payload.get("session_state") or payload.get("sessionState") or {}
    if not isinstance(session_state, dict):
        session_state = {}

    if not session_id or role not in ("user", "assistant") or not isinstance(content, str):
        raise HTTPException(status_code=422, detail="Invalid payload")

    # Reuse the same keying strategy as summaries:
    # - memberId::companion when memberId exists
    # - session::session_id otherwise
    key = _summary_store_key(session_state, session_id)

    record = {
        "key": key,
        "session_id": session_id,
        "role": role,
        "content": content,
        "ts": ts or int(time.time() * 1000),
        "brand": str(session_state.get("rebranding") or "").strip(),
        "companion": str(
            session_state.get("companion")
            or session_state.get("companionName")
            or session_state.get("companion_name")
            or ""
        ).strip(),
        "member_id": _extract_member_id(session_state) or "",
    }

    _append_journal_record(key, record)
    return {"ok": True, "enabled": True}


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

