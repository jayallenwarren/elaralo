from __future__ import annotations

import os
import time
import re
import uuid
import json
import hashlib
import base64
import mimetypes
import asyncio
import threading
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple, Set

# Pydantic (v1/v2 compatibility)
try:
    from pydantic import BaseModel, validator, Field  # type: ignore
except Exception:  # pragma: no cover
    from pydantic.v1 import BaseModel, validator, Field  # type: ignore

from filelock import FileLock  # type: ignore

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, Header, Depends, Body
from fastapi.responses import HTMLResponse, Response, JSONResponse
# Threadpool helper (prevents blocking the event loop on requests/azure upload)
from starlette.concurrency import run_in_threadpool  # type: ignore

# NOTE: This app is deployed in multiple layouts (sometimes as a package, sometimes as a single-file drop-in).
# These import fallbacks prevent 503 "Service Unavailable" at the App Service layer when Python can't resolve
# relative imports due to module/package context.
try:
    from .settings import settings  # type: ignore
    from .models import ChatResponse  # type: ignore  # kept for compatibility with existing codebase
except Exception:  # pragma: no cover
    try:
        from settings import settings  # type: ignore
        from models import ChatResponse  # type: ignore
    except Exception:
        # Last-resort common package layout
        from app.settings import settings  # type: ignore
        from app.models import ChatResponse  # type: ignore

try:
    from .consent_routes import router as consent_router  # type: ignore
except Exception:  # pragma: no cover
    try:
        from consent_routes import router as consent_router  # type: ignore
    except Exception:
        try:
            from app.consent_routes import router as consent_router  # type: ignore
        except Exception:
            consent_router = None
STATUS_SAFE = "safe"
STATUS_BLOCKED = "explicit_blocked"
STATUS_ALLOWED = "explicit_allowed"

app = FastAPI(title="Elaralo API")

# ----------------------------
# WIX FORM
# ----------------------------
WIX_API_KEY = (os.getenv("WIX_API_KEY", "") or "").strip()
WIX_APP_ID = (os.getenv("WIX_APP_ID", "") or "").strip()
WIX_APP_SECRET = (os.getenv("WIX_APP_SECRET", "") or "").strip()
WIX_WEBHOOK_PUBLIC_KEY = (os.getenv("WIX_WEBHOOK_PUBLIC_KEY", "") or "").strip()


async def require_wix_api_key(
    request: Request,
    x_api_key: str | None = Header(default=None, alias="x-api-key"),
    digest: str | None = Header(default=None, alias="digest"),
    authorization: str | None = Header(default=None, alias="authorization"),
) -> None:
    """Auth guard for Wix -> backend webhooks.

    Accepts either:
      1) A shared `x-api-key` header (configure this in the Wix webhook subscription), OR
      2) A Wix-signed JWT (RS256) found in:
         - `digest` header (some Wix webhook setups),
         - `Authorization` header, or
         - request JSON body field `data` (standard Wix REST webhook format).

    On success, sets:
      - request.state.wix_verified = True
      - request.state.wix_auth_method = "x-api-key" | "jwt"
    """

    request.state.wix_verified = False
    request.state.wix_auth_method = None

    expected = (os.getenv("WIX_API_KEY") or "").strip()
    if expected and x_api_key and x_api_key == expected:
        request.state.wix_verified = True
        request.state.wix_auth_method = "x-api-key"
        return

    pub_raw = (os.getenv("WIX_WEBHOOK_PUBLIC_KEY") or "").strip()
    if not pub_raw:
        raise HTTPException(status_code=401, detail="Unauthorized")

    # Build PEM if needed.
    if "-----BEGIN" not in pub_raw:
        pub_pem = "-----BEGIN PUBLIC KEY-----\n" + pub_raw.strip() + "\n-----END PUBLIC KEY-----\n"
    else:
        pub_pem = pub_raw

    candidates: list[str] = []
    for v in (digest, authorization):
        if not v:
            continue
        vv = v.strip()
        if vv.lower().startswith("bearer "):
            vv = vv[7:].strip()
        candidates.append(vv)

    # Try to pull JWT from JSON body (common Wix webhook format: {"data": "<jwt>"}).
    try:
        body = await request.body()
        if body:
            parsed = json.loads(body.decode("utf-8"))
            if isinstance(parsed, dict):
                data = parsed.get("data")
                if isinstance(data, str):
                    candidates.append(data.strip())
    except Exception:
        # Ignore parse errors; we’ll fall back to headers.
        pass

    for token in candidates:
        if not token or token.count(".") < 2:
            continue
        try:
            jwt.decode(token, pub_pem, algorithms=["RS256"], options={"verify_aud": False})
            request.state.wix_verified = True
            request.state.wix_auth_method = "jwt"
            return
        except Exception:
            continue

    raise HTTPException(status_code=401, detail="Unauthorized")
def _split_cors_origins(raw: str) -> list[str]:
    """Split + normalize CORS origins from an env var.

    - Supports comma and/or whitespace separation
    - Removes surrounding quotes and trailing slashes
    - Normalizes to lower-case (scheme/host are case-insensitive)
    - De-dupes while preserving order
    """
    if not raw:
        return []
    parts = re.split(r"[\s,]+", raw.strip())
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        t = (p or "").strip()
        if not t:
            continue
        # Strip surrounding quotes that sometimes show up in App Service config.
        if (t.startswith('"') and t.endswith('"')) or (t.startswith("'") and t.endswith("'")):
            t = t[1:-1].strip()
        t = t.rstrip("/").lower()
        if not t:
            continue
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out

def _wildcard_to_regex(pattern: str) -> str:
    # Convert a wildcard origin (e.g. "https://*.azurestaticapps.net") into a regex.
    # NOTE: We normalize tokens to lower-case and test against a lower-case origin string.
    escaped = re.escape(pattern).replace(r"\*", "[^/]+")  # '*' matches up to the next '/'
    return "^" + escaped + "$"


cors_env = os.getenv("CORS_ALLOW_ORIGINS") or os.getenv("CORS_ALLOWED_ORIGINS") or os.getenv("CORS_ORIGINS") or ""

_cors_tokens = _split_cors_origins(cors_env)

# Conservative default to keep dev usable if CORS_ALLOW_ORIGINS is not set.
# Override in production via the CORS_ALLOW_ORIGINS app setting.
if not _cors_tokens:
    _cors_tokens = [
        "https://elaralo.com",
        "https://www.elaralo.com",
        "https://editor.wix.com",
        "https://manage.wix.com",
        "https://*.azurestaticapps.net",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

_cors_allow_all = any(t == "*" for t in _cors_tokens)

_cors_allow_origins: set[str] = {t for t in _cors_tokens if t != "*" and "*" not in t}
_cors_wildcards: list[str] = [t for t in _cors_tokens if t != "*" and "*" in t]
_cors_allow_origin_regexes: list[re.Pattern[str]] = [re.compile(_wildcard_to_regex(w)) for w in _cors_wildcards]

# If an explicit azurestaticapps origin is listed, also allow any azurestaticapps subdomain.
if any(o.endswith(".azurestaticapps.net") for o in _cors_allow_origins) and not any(
    "azurestaticapps.net" in w for w in _cors_wildcards
):
    _cors_allow_origin_regexes.append(
        re.compile(r"^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.azurestaticapps\.net$")
    )

def _cors_origin_allowed(origin: str | None) -> bool:
    if not origin:
        return False
    o = (origin or "").strip()
    if not o:
        return False
    # Strip quotes/trailing slash + normalize to lower-case for matching.
    if (o.startswith('"') and o.endswith('"')) or (o.startswith("'") and o.endswith("'")):
        o = o[1:-1].strip()
    o = o.rstrip("/").lower()

    if _cors_allow_all:
        return True
    if o in _cors_allow_origins:
        return True
    for rx in _cors_allow_origin_regexes:
        if rx.match(o):
            return True
    return False

def _cors_append_vary(headers: dict, value: str) -> None:
    try:
        existing = headers.get("Vary")
    except Exception:
        existing = None
    if not existing:
        headers["Vary"] = value
        return
    parts = [p.strip() for p in str(existing).split(",") if p.strip()]
    if value.lower() not in {p.lower() for p in parts}:
        headers["Vary"] = str(existing) + ", " + value

@app.middleware("http")
async def _cors_middleware(request: Request, call_next):
    origin = request.headers.get("origin")
    # Short-circuit preflight to avoid 405s (and to ensure headers are present even on errors).
    if request.method == "OPTIONS":
        response = Response(status_code=200)
    else:
        # IMPORTANT:
        # This middleware sits *outside* FastAPI/Starlette's ExceptionMiddleware.
        # If an exception bubbles up past ExceptionMiddleware, call_next() will raise and
        # we would return a response *without* CORS headers (browser shows it as "CORS").
        try:
            response = await call_next(request)
        except HTTPException as exc:
            response = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        except Exception:
            import traceback
            print("[ERROR] Unhandled exception while serving request:", request.method, str(request.url))
            traceback.print_exc()
            response = JSONResponse(status_code=500, content={"detail": "Internal Server Error"})

    if origin and _cors_origin_allowed(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        _cors_append_vary(response.headers, "Origin")

        if request.method == "OPTIONS":
            req_headers = request.headers.get("access-control-request-headers")
            req_method = request.headers.get("access-control-request-method")
            response.headers["Access-Control-Allow-Headers"] = req_headers or "*"
            response.headers["Access-Control-Allow-Methods"] = req_method or "GET,POST,PUT,PATCH,DELETE,OPTIONS"
            response.headers["Access-Control-Max-Age"] = "86400"

    return response

if not cors_env:
    print("[WARN] CORS_ALLOW_ORIGINS is not set; using a conservative default allow list. Set CORS_ALLOW_ORIGINS to override.")
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

import json
import logging

logger = logging.getLogger("wix")
logger.setLevel(logging.INFO)

def _decode_wix_jwt(token: str) -> dict | None:
    """Decode a Wix webhook JWT (RS256) using WIX_WEBHOOK_PUBLIC_KEY.

    Wix REST webhooks commonly deliver event data as a JWT in the request body (often under `data`).
    This helper is intentionally tolerant: it returns None if decoding isn't possible.
    """
    token = (token or "").strip()
    if token.count(".") < 2:
        return None

    key = (os.getenv("WIX_WEBHOOK_PUBLIC_KEY") or "").strip()
    if not key:
        return None

    if "BEGIN PUBLIC KEY" not in key:
        key = "-----BEGIN PUBLIC KEY-----\n" + key + "\n-----END PUBLIC KEY-----\n"

    try:
        import jwt  # PyJWT
        decoded = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            options={"verify_aud": False},
        )
        return decoded if isinstance(decoded, dict) else None
    except Exception:
        return None


def _normalize_wix_webhook_payload(payload: dict) -> dict:
    """Normalize Wix webhook payloads across formats.

    Wix can send:
    - A plain JSON envelope where `data` is already a dict.
    - A JSON envelope where `data` is a JWT string (REST webhook style).
    After normalization, `payload["data"]` and `payload["identity"]` will be dicts when possible.
    """
    if not isinstance(payload, dict):
        return {}

    # Case 1: outer envelope contains `data` as a JWT string -> decode it into the canonical envelope.
    outer_data = payload.get("data")
    if isinstance(outer_data, str):
        decoded_outer = _decode_wix_jwt(outer_data)
        if decoded_outer:
            payload = decoded_outer

    # Case 2: decoded payload contains `data` and/or `identity` as JSON strings -> parse to dict.
    inner_data = payload.get("data")
    if isinstance(inner_data, str):
        try:
            payload["data"] = json.loads(inner_data)
        except Exception:
            # Keep original string if it's not JSON.
            pass

    inner_identity = payload.get("identity")
    if isinstance(inner_identity, str):
        try:
            payload["identity"] = json.loads(inner_identity)
        except Exception:
            pass

    return payload

@app.post("/wix-form")
async def wix_form(request: Request, payload: dict, _auth: None = Depends(require_wix_api_key)):
    """Receives Wix callbacks.

    - For Wix webhooks: Wix includes a signed `digest` header. We verify it in `require_wix_api_key`
      and then process PayGo top-up events here.
    - For manual testing: you can post here with `x-api-key: $WIX_API_KEY` (no crediting occurs).
    """
    logger.info("RAW WIX PAYLOAD:\n%s", json.dumps(payload, indent=2))

    if getattr(request.state, "wix_verified", False):
        normalized = _normalize_wix_webhook_payload(payload)
        try:
            meta = {
                "eventType": normalized.get("eventType"),
                "entityFqdn": normalized.get("entityFqdn"),
                "instanceId": normalized.get("instanceId"),
            }
            print("WIX WEBHOOK META:", json.dumps(meta, indent=2))
            if os.getenv("WIX_WEBHOOK_DEBUG_LOG", "").strip() == "1":
                print("WIX WEBHOOK DECODED (TRUNC):", json.dumps(normalized, indent=2)[:5000])
        except Exception:
            pass
        processed = _paygo_process_wix_webhook(normalized)
        return {"ok": True, "processed": processed}

    return {"ok": True, "processed": False}


@app.post("/wix/webhook")
async def wix_webhook(request: Request, payload: dict, _auth: None = Depends(require_wix_api_key)):
    """Alias for Wix webhooks (same handler as /wix-form)."""
    return await wix_form(request, payload, _auth)


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



# ============================
# PayGo: Wix Payment Links top-up
# ============================

class PayGoIntentRequest(BaseModel):
    """
    Client-side "intent" registration used to correlate a PayGo payment to an identity.

    - Members: send memberId (Wix memberId). No email prompt required.
    - Visitors: send email (used at Wix checkout) and a stable anon memberId (generated client-side and stored locally).
    """
    email: str | None = Field(
        default=None,
        description="Email address used at Wix checkout (required for visitors; optional for members if memberId is present).",
    )
    memberId: str | None = Field(
        default=None,
        description="Identity to credit (Wix memberId for members; anon id for visitors).",
        max_length=200,
    )
    sessionId: str | None = Field(
        default=None,
        description="Optional session id (fallback identity if no memberId).",
        max_length=200,
    )
    minutes: int | None = Field(
        default=None,
        ge=1,
        le=10_000,
        description="Optional override for top-up minutes. Defaults to PAYG_INCREMENT_MINUTES / WIX_PAYLINK_TOPUP_MINUTES.",
    )
    rebrandingKey: str | None = Field(
        default=None,
        description="Optional rebranding key which may contain pay_go_minutes override.",
    )

class PayGoIntentResponse(BaseModel):
    ok: bool = True
    identityKey: str
    minutes: int
    expiresAt: str
    email: str | None = None
    memberId: str | None = None

def _paygo_intents_get(store: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any], float]:
    """Return (by_email, by_member_id, last_prune_at) and normalize legacy storage.

    Storage lives inside the usage store so it survives restarts.

    Legacy (older) format:
        store["__paygo_intents__"] = { "email@example.com": { ... } }

    Current format:
        store["__paygo_intents__"] = {
            "byEmail": { "email@example.com": { ... } },
            "byMemberId": { "<memberId>": { ... } },
            "lastPruneAt": 0.0
        }
    """
    raw = store.get("__paygo_intents__", {}) or {}
    by_email: Dict[str, Any] = {}
    by_member: Dict[str, Any] = {}
    last_prune_at = 0.0

    if isinstance(raw, dict):
        if "byEmail" in raw or "byMemberId" in raw:
            be = raw.get("byEmail", {}) or {}
            bm = raw.get("byMemberId", {}) or {}
            by_email = be if isinstance(be, dict) else {}
            by_member = bm if isinstance(bm, dict) else {}
            try:
                last_prune_at = float(raw.get("lastPruneAt", 0) or 0)
            except Exception:
                last_prune_at = 0.0
        else:
            # Legacy: treat dict as by-email map.
            by_email = raw
    else:
        by_email = {}

    store["__paygo_intents__"] = {"byEmail": by_email, "byMemberId": by_member, "lastPruneAt": last_prune_at}
    return by_email, by_member, last_prune_at


def _paygo_intents_set(store: Dict[str, Any], by_email: Dict[str, Any], by_member: Dict[str, Any], last_prune_at: float) -> None:
    store["__paygo_intents__"] = {"byEmail": by_email, "byMemberId": by_member, "lastPruneAt": float(last_prune_at or 0.0)}


def _paygo_prune_store(store: Dict[str, Any]) -> None:
    """Prune old PayGo intents + processed-event ids."""
    now_ts = time.time()
    by_email, by_member, last_prune_at = _paygo_intents_get(store)

    # Don't prune on every request (this endpoint can be hit frequently).
    if now_ts - last_prune_at < 30:
        return

    cutoff_intents = now_ts - float(PAYGO_INTENT_TTL_SECONDS or 0)
    if cutoff_intents > 0:
        for mapping in (by_email, by_member):
            stale_keys = [
                k
                for k, rec in list(mapping.items())
                if float((rec or {}).get("createdAt", 0) or 0) < cutoff_intents
            ]
            for k in stale_keys:
                mapping.pop(k, None)

    cutoff_events = now_ts - float(PAYGO_EVENT_TTL_SECONDS or 0)
    events = store.get("__paygo_events__", {}) or {}
    if isinstance(events, dict) and cutoff_events > 0:
        stale_eids = [
            eid
            for eid, rec in list(events.items())
            if float((rec or {}).get("ts", 0) or 0) < cutoff_events
        ]
        for eid in stale_eids:
            events.pop(eid, None)
        store["__paygo_events__"] = events

    _paygo_intents_set(store, by_email, by_member, now_ts)

def _usage_credit_minutes_in_store(store: Dict[str, Any], identity_key: str, minutes: float, reason: str) -> Dict[str, Any]:
    rec = store.get(identity_key) or {}
    rec.setdefault("minutes_total", 0.0)
    rec.setdefault("seconds_total", 0.0)
    rec.setdefault("seconds_used", 0.0)
    rec.setdefault("paid_minutes_total", 0.0)
    rec.setdefault("paid_seconds_total", 0.0)
    rec.setdefault("last_plan", "")
    rec.setdefault("last_update_ts", 0.0)
    rec.setdefault("last_charge_ts", 0.0)
    rec.setdefault("last_credit_ts", 0.0)
    rec.setdefault("last_credit_reason", "")
    rec.setdefault("last_seen_ip", "")

    delta_sec = float(minutes) * 60.0
    rec["paid_minutes_total"] = float(rec.get("paid_minutes_total", 0.0)) + float(minutes)
    rec["paid_seconds_total"] = float(rec.get("paid_seconds_total", 0.0)) + delta_sec
    rec["minutes_total"] = float(rec.get("minutes_total", 0.0)) + float(minutes)
    rec["seconds_total"] = float(rec.get("seconds_total", 0.0)) + delta_sec
    rec["last_credit_ts"] = time.time()
    rec["last_credit_reason"] = str(reason)[:200]
    store[identity_key] = rec
    return rec

def _find_email_in_obj(obj: Any) -> str:
    # Prefer explicit keys
    if isinstance(obj, dict):
        for key in ("email", "buyerEmail", "payerEmail", "customerEmail", "contactEmail"):
            v = obj.get(key)
            if isinstance(v, str) and _is_probably_email(v):
                return _normalize_email(v)
        for v in obj.values():
            e = _find_email_in_obj(v)
            if e:
                return e
    elif isinstance(obj, list):
        for it in obj:
            e = _find_email_in_obj(it)
            if e:
                return e
    elif isinstance(obj, str):
        if _is_probably_email(obj):
            return _normalize_email(obj)
    return ""

def _extract_payment_entity(envelope: Any) -> Dict[str, Any] | None:
    if not isinstance(envelope, dict):
        return None

    # Some envelopes wrap the entity
    for key in ("entity", "paymentLinkPayment", "payment_link_payment", "payment"):
        v = envelope.get(key)
        if isinstance(v, dict):
            return v

    data = envelope.get("data")
    if isinstance(data, dict):
        for key in ("entity", "paymentLinkPayment", "payment_link_payment", "payment"):
            v = data.get(key)
            if isinstance(v, dict):
                return v
        # Sometimes "data" IS the entity
        if "paymentLinkId" in data or "extendedFields" in data or "extended_fields" in data:
            return data

        # Sometimes nested again
        data2 = data.get("data")
        if isinstance(data2, dict):
            for key in ("entity", "paymentLinkPayment"):
                v = data2.get(key)
                if isinstance(v, dict):
                    return v
            if "paymentLinkId" in data2 or "extendedFields" in data2:
                return data2

    # Envelope itself might be the entity
    if "paymentLinkId" in envelope or "extendedFields" in envelope:
        return envelope

    return None

def _extract_member_id(payment: Dict[str, Any]) -> str:
    if not isinstance(payment, dict):
        return ""
    ext = payment.get("extendedFields") or payment.get("extended_fields") or {}
    if isinstance(ext, dict):
        for k in ("memberId", "memberID", "member_id"):
            v = ext.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    # fallback if stored directly on payment
    for k in ("memberId", "member_id"):
        v = payment.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""

def _extract_payment_id(envelope: Dict[str, Any], payment: Dict[str, Any]) -> str:
    for k in ("id", "_id", "paymentId", "payment_id", "paymentLinkPaymentId"):
        v = payment.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    for k in ("eventId", "id", "_id"):
        v = envelope.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    # deterministic hash fallback
    try:
        blob = json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return "sha256:" + hashlib.sha256(blob).hexdigest()
    except Exception:
        return "sha256:" + hashlib.sha256(str(envelope).encode("utf-8")).hexdigest()

def _deep_find_first_str(obj: Any, keys: set[str], max_depth: int = 6, _depth: int = 0) -> str | None:
    """Best-effort nested lookup for a string value by key name.

    We keep this conservative (max_depth) to avoid surprises.
    """
    if _depth > max_depth:
        return None
    if isinstance(obj, dict):
        for k in keys:
            v = obj.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        for v in obj.values():
            found = _deep_find_first_str(v, keys, max_depth=max_depth, _depth=_depth + 1)
            if found:
                return found
    elif isinstance(obj, list):
        for it in obj:
            found = _deep_find_first_str(it, keys, max_depth=max_depth, _depth=_depth + 1)
            if found:
                return found
    return None


def _paygo_process_wix_webhook(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Process Wix Payment Link webhooks to credit PayGo minutes.

    This handler is intentionally defensive:
      - Idempotent per paymentId.
      - Tries to resolve identity via (1) extended field memberId, else (2) pre-registered intent by buyer email.
    """
    # Wix webhooks arrive as a JWT envelope; the decoded payload usually has { eventType, data }.
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        data = payload if isinstance(payload, dict) else {}

    event_type = (
        str(payload.get("eventType") or payload.get("event_type") or data.get("eventType") or data.get("event_type") or "")
        .strip()
        .lower()
    )

    # Only handle Payment Link payment events.
    if "payment_link" not in event_type or "payment" not in event_type:
        return {"ok": True, "ignored": True, "reason": "not_payment_link_payment", "eventType": event_type}

    payment_id = str(data.get("paymentId") or data.get("payment_id") or data.get("id") or "").strip()
    paylink_id = str(data.get("paymentLinkId") or data.get("payment_link_id") or data.get("paymentLink_id") or "").strip()

    buyer_email = None
    for k in ("buyerEmail", "buyer_email", "email"):
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            buyer_email = v.strip()
            break

    buyer_email_norm = (buyer_email or "").strip().lower()

    # Attempt to read memberId from extended fields (if present in this event payload).
    member_id_field = None
    extended_fields = data.get("extendedFields") or data.get("extended_fields") or []
    if isinstance(extended_fields, list):
        for ef in extended_fields:
            if not isinstance(ef, dict):
                continue
            field_key = str(ef.get("key") or ef.get("fieldKey") or ef.get("field_key") or "").strip()
            name = str(ef.get("name") or ef.get("title") or "").strip().lower()
            label = str(ef.get("label") or "").strip().lower()
            if "memberid" in field_key.lower() or name == "member id" or label == "member id":
                candidate = ef.get("value") or ef.get("stringValue") or ef.get("string_value")
                if isinstance(candidate, str) and candidate.strip():
                    member_id_field = candidate.strip()
                    break

    if not payment_id:
        return {
            "ok": False,
            "credited": False,
            "reason": "missing_payment_id",
            "eventType": event_type,
            "paylinkId": paylink_id,
        }

    now_iso = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

    # Single critical section to keep idempotency + credit atomic against the JSON store.
    with _USAGE_LOCK:
        store = _load_usage_store()

        paygo_events = _paygo_events_get(store)
        prev = paygo_events.get(payment_id) or {}
        if isinstance(prev, dict) and prev.get("credited") is True:
            return {
                "ok": True,
                "credited": True,
                "alreadyCredited": True,
                "paymentId": payment_id,
                "paylinkId": paylink_id,
                "identityKey": prev.get("identityKey"),
                "minutes": prev.get("minutes"),
            }

        by_email, by_member, _ = _paygo_intents_get(store)

        intent_rec: Dict[str, Any] | None = None
        identity_key: str | None = None
        matched_via: str | None = None

        if member_id_field:
            identity_key = f"member::{member_id_field}"
            matched_via = "memberIdExtendedField"
            intent_rec = by_member.get(member_id_field) if isinstance(by_member, dict) else None

        if not identity_key and buyer_email_norm and isinstance(by_email, dict):
            intent_candidate = by_email.get(buyer_email_norm)
            if isinstance(intent_candidate, dict):
                ik = intent_candidate.get("identityKey")
                if isinstance(ik, str) and ik.strip():
                    intent_rec = intent_candidate
                    identity_key = ik.strip()
                    matched_via = "intentByEmail"

        if not identity_key:
            # Record the event as seen for troubleshooting, but do not credit.
            paygo_events[payment_id] = {
                "credited": False,
                "seenAt": now_iso,
                "eventType": event_type,
                "paylinkId": paylink_id,
                "buyerEmail": buyer_email,
                "buyerEmailNorm": buyer_email_norm,
                "memberIdField": member_id_field,
                "reason": "no_identity_match",
            }
            _save_usage_store(store)
            return {
                "ok": True,
                "credited": False,
                "paymentId": payment_id,
                "paylinkId": paylink_id,
                "reason": "no_identity_match",
            }

        minutes_to_credit = int(PAYG_INCREMENT_MINUTES)
        if intent_rec and isinstance(intent_rec, dict):
            override = intent_rec.get("minutes")
            if override is None:
                override = intent_rec.get("minutesToCredit")
            try:
                if override is not None:
                    override_int = int(override)
                    if override_int > 0:
                        minutes_to_credit = override_int
            except Exception:
                pass

        # Apply credit inside this store transaction (avoid deadlock by not calling _usage_credit_minutes_sync here).
        _usage_credit_minutes_in_store(
            store,
            identity_key,
            minutes_to_credit,
            meta={
                "source": "wix_paylink",
                "paymentId": payment_id,
                "paymentLinkId": paylink_id,
                "buyerEmail": buyer_email,
                "memberIdField": member_id_field,
                "eventType": event_type,
                "matchedVia": matched_via,
                "creditedAt": now_iso,
            },
        )

        paygo_events[payment_id] = {
            "credited": True,
            "creditedAt": now_iso,
            "eventType": event_type,
            "paylinkId": paylink_id,
            "buyerEmail": buyer_email,
            "buyerEmailNorm": buyer_email_norm,
            "memberIdField": member_id_field,
            "identityKey": identity_key,
            "minutes": minutes_to_credit,
            "matchedVia": matched_via,
        }

        # Best-effort cleanup so old intents don't leak across sessions.
        if buyer_email_norm and isinstance(by_email, dict):
            rec = by_email.get(buyer_email_norm)
            if isinstance(rec, dict) and str(rec.get("identityKey") or "").strip() == identity_key:
                by_email.pop(buyer_email_norm, None)

        if member_id_field and isinstance(by_member, dict):
            rec = by_member.get(member_id_field)
            if isinstance(rec, dict) and str(rec.get("identityKey") or "").strip() == identity_key:
                by_member.pop(member_id_field, None)

        _save_usage_store(store)

    return {
        "ok": True,
        "credited": True,
        "paymentId": payment_id,
        "paylinkId": paylink_id,
        "buyerEmail": buyer_email,
        "identityKey": identity_key,
        "minutes": minutes_to_credit,
        "matchedVia": matched_via,
    }

@app.post("/paygo/intent", response_model=PayGoIntentResponse)
def paygo_create_intent(req: PayGoIntentRequest):
    """
    Register a correlation intent for an upcoming PayGo purchase.

    The intent is stored server-side for a limited time, so that when the Wix webhook
    arrives we can resolve which identity to credit.
    """
    email = (req.email or "").strip()
    email_norm = email.lower() if email else None
    member_id = (req.memberId or "").strip() or None
    session_id = (req.sessionId or "").strip() or None

    if not member_id and not session_id and not email_norm:
        raise HTTPException(status_code=400, detail="Provide memberId, sessionId, or email.")

    # Determine identity key (priority: memberId > sessionId > email).
    if member_id:
        identity_key = f"member::{member_id}"
    elif session_id:
        identity_key = f"session::{session_id}"
    else:
        identity_key = f"email::{email_norm}"

    # Default minutes from env; allow override via rebrandingKey or explicit minutes.
    minutes = int(PAYG_INCREMENT_MINUTES)
    if req.rebrandingKey:
        try:
            cfg = _parse_rebranding_key(req.rebrandingKey)
            rb_minutes = cfg.get("pay_go_minutes")
            if rb_minutes:
                minutes = int(rb_minutes)
        except Exception:
            pass
    if req.minutes is not None:
        # pydantic validates bounds; still coerce.
        try:
            minutes = int(req.minutes)
        except Exception:
            pass
    if minutes < 1:
        minutes = int(PAYG_INCREMENT_MINUTES)

    now = datetime.utcnow().replace(microsecond=0)
    expires_at = now + timedelta(seconds=int(PAYGO_INTENT_TTL_SECONDS))
    now_iso = now.isoformat() + "Z"
    expires_iso = expires_at.isoformat() + "Z"

    record: Dict[str, Any] = {
        "identityKey": identity_key,
        "minutes": minutes,
        "createdAt": now_iso,
        "expiresAt": expires_iso,
    }
    if email_norm:
        record["email"] = email
        record["emailNorm"] = email_norm
    if member_id:
        record["memberId"] = member_id
    if session_id:
        record["sessionId"] = session_id

    with _USAGE_LOCK:
        store = _load_usage_store()
        by_email, by_member, _ = _paygo_intents_get(store)

        if email_norm:
            by_email[email_norm] = dict(record)
        if member_id:
            by_member[member_id] = dict(record)

        _save_usage_store(store)

    return PayGoIntentResponse(
        ok=True,
        identityKey=identity_key,
        minutes=minutes,
        expiresAt=expires_iso,
        email=email if email else None,
        memberId=member_id,
    )

# -----------------------------------------------------------------------------
# BeeStreamed in-memory session state + shared live chat hub
# -----------------------------------------------------------------------------

_BEE_SESSION_LOCK = threading.Lock()
# _BEE_SESSION_STATE[key] = {"active": bool, "event_ref": str, "updated_at": float}
_BEE_SESSION_STATE: Dict[str, Dict[str, Any]] = {}

_LIVECHAT_LOCK = threading.Lock()
# _LIVECHAT_CLIENTS[event_ref] = set(WebSocket)
_LIVECHAT_CLIENTS: Dict[str, Set[WebSocket]] = {}
# Per-connection identity metadata, keyed by websocket instance.
# Used so the server can attach senderRole/name to each broadcast.
_LIVECHAT_CLIENT_META: Dict[WebSocket, Dict[str, str]] = {}
# Simple in-memory message history per event_ref so late-joiners see recent chat.
_LIVECHAT_HISTORY: Dict[str, List[Dict[str, Any]]] = {}
_LIVECHAT_HISTORY_MAX = 200


def _normalize_livechat_role(role: str) -> str:
    r = (role or "").strip().lower()
    if r in ("host", "viewer", "system"):
        return r
    return "viewer"


def _livechat_push_history(event_ref: str, msg: Dict[str, Any]) -> None:
    # Append a chat message to in-memory history (bounded).
    event_ref = (event_ref or "").strip()
    if not event_ref:
        return
    with _LIVECHAT_LOCK:
        hist = _LIVECHAT_HISTORY.get(event_ref)
        if hist is None:
            hist = []
            _LIVECHAT_HISTORY[event_ref] = hist
        hist.append(msg)
        if len(hist) > _LIVECHAT_HISTORY_MAX:
            # Keep the most recent N messages
            del hist[: len(hist) - _LIVECHAT_HISTORY_MAX]



async def _livechat_broadcast(event_ref: str, msg: Dict[str, Any]) -> None:
    """Broadcast a JSON-serializable message to all connected live-chat clients for an event_ref.

    This must work reliably with multiple Uvicorn workers. Each worker maintains its own in-memory
    websocket set, so this broadcasts only to clients connected to THIS worker — which is exactly
    what we want because each websocket connection is pinned to a worker process.

    The frontend already de-dupes echoed messages using clientMsgId, so we broadcast to everyone,
    including the sender.
    """
    ref = (event_ref or "").strip()
    if not ref:
        return

    try:
        payload = json.dumps(msg, ensure_ascii=False)
    except Exception:
        # Fallback: stringify
        payload = json.dumps({"type": "error", "error": "Invalid livechat payload"}, ensure_ascii=False)

    # Snapshot sockets under lock so we don't hold the lock during awaits.
    with _LIVECHAT_LOCK:
        sockets = list(_LIVECHAT_CLIENTS.get(ref, set()))

    if not sockets:
        return

    dead: List[WebSocket] = []
    for ws in sockets:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)

    if dead:
        with _LIVECHAT_LOCK:
            s = _LIVECHAT_CLIENTS.get(ref)
            if s is not None:
                for ws in dead:
                    try:
                        s.discard(ws)
                    except Exception:
                        pass
                    try:
                        _LIVECHAT_CLIENT_META.pop(ws, None)
                    except Exception:
                        pass
                if not s:
                    _LIVECHAT_CLIENTS.pop(ref, None)
                    # Keep history for a bit in case late joiners arrive; do not delete here.


# --- Shared (cross-worker) live chat persistence --------------------------------
#
# IMPORTANT: The API may run with multiple Uvicorn workers. In-memory websocket client
# sets are per-worker, so to mirror messages across ALL connected clients we persist
# live chat messages into the shared SQLite DB and have each websocket connection poll
# for new rows.

_LIVECHAT_DB_TABLE = os.environ.get('LIVECHAT_DB_TABLE', 'livechat_messages').strip() or 'livechat_messages'
_LIVECHAT_DB_HISTORY_LIMIT = int(os.environ.get('LIVECHAT_DB_HISTORY_LIMIT', '80') or '80')
_LIVECHAT_DB_POLL_INTERVAL_SEC = float(os.environ.get('LIVECHAT_DB_POLL_INTERVAL_SEC', '0.35') or '0.35')

def _livechat_db_init_sync(conn) -> None:
    try:
        conn.execute(
            f"""
CREATE TABLE IF NOT EXISTS {_LIVECHAT_DB_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  client_msg_id TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
"""
        )
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{_LIVECHAT_DB_TABLE}_event_id ON {_LIVECHAT_DB_TABLE}(event_ref, id);"
        )
    except Exception:
        # DB is best-effort for live chat. If it fails, the websocket still works per-worker.
        pass

def _livechat_db_connect_sync(db_path: str):
    import sqlite3

    conn = sqlite3.connect(db_path, timeout=5, check_same_thread=False)
    try:
        conn.execute('PRAGMA journal_mode=WAL;')
    except Exception:
        pass
    try:
        conn.execute('PRAGMA synchronous=NORMAL;')
    except Exception:
        pass
    _livechat_db_init_sync(conn)
    return conn

def _livechat_db_insert_sync(event_ref: str, payload: Dict[str, Any]) -> int:
    ref = (event_ref or '').strip()
    if not ref:
        return 0

    db_path = _get_companion_mappings_db_path(for_write=True)
    lock_path = db_path + '.livechat.lock'
    try:
        with FileLock(lock_path):
            conn = _livechat_db_connect_sync(db_path)
            created_at = int(time.time() * 1000)
            client_msg_id = str(payload.get('clientMsgId') or payload.get('client_msg_id') or '').strip() or str(uuid.uuid4())
            payload_json = json.dumps(payload, ensure_ascii=False)
            try:
                conn.execute(
                    f"INSERT INTO {_LIVECHAT_DB_TABLE} (event_ref, created_at, client_msg_id, payload_json) VALUES (?,?,?,?)",
                    (ref, created_at, client_msg_id, payload_json),
                )
                row_id = conn.execute('SELECT last_insert_rowid()').fetchone()[0]
                conn.commit()
                return int(row_id or 0)
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
    except Exception:
        return 0

def _livechat_db_fetch_history_sync(event_ref: str, limit: int) -> Tuple[int, List[Dict[str, Any]]]:
    ref = (event_ref or '').strip()
    if not ref:
        return 0, []

    db_path = _get_companion_mappings_db_path(for_write=False)
    try:
        conn = _livechat_db_connect_sync(db_path)
        rows = conn.execute(
            f"SELECT id, payload_json FROM {_LIVECHAT_DB_TABLE} WHERE event_ref=? ORDER BY id DESC LIMIT ?",
            (ref, int(limit)),
        ).fetchall()
    except Exception:
        try:
            conn.close()
        except Exception:
            pass
        return 0, []
    finally:
        try:
            conn.close()
        except Exception:
            pass

    rows = list(reversed(rows or []))
    msgs: List[Dict[str, Any]] = []
    last_id = 0
    for rid, payload_json in rows:
        try:
            rid_int = int(rid or 0)
            last_id = max(last_id, rid_int)
        except Exception:
            pass
        try:
            obj = json.loads(payload_json) if payload_json else None
            if isinstance(obj, dict):
                msgs.append(obj)
        except Exception:
            pass
    return last_id, msgs


def _livechat_db_clear_event_sync(event_ref: str) -> int:
    """Delete all persisted livechat messages for a given BeeStreamed event_ref.

    We clear per-event history when a new stream session starts so a reused event_ref
    doesn't replay the previous session's chat.
    """
    ref = (event_ref or "").strip()
    if not ref:
        return 0
    db_path = _get_companion_mappings_db_path(for_write=True)
    lock_path = db_path + ".livechat.lock"
    deleted = 0
    try:
        with FileLock(lock_path):
            conn = _livechat_db_connect_sync(db_path)
            try:
                cur = conn.execute(f"DELETE FROM {_LIVECHAT_DB_TABLE} WHERE event_ref=?", (ref,))
                conn.commit()
                try:
                    deleted = int(cur.rowcount or 0)
                except Exception:
                    deleted = 0
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
    except Exception:
        return 0
    return deleted


def _livechat_db_fetch_after_sync(event_ref: str, after_id: int, limit: int = 80) -> Tuple[int, List[Dict[str, Any]]]:
    ref = (event_ref or '').strip()
    if not ref:
        return int(after_id or 0), []

    db_path = _get_companion_mappings_db_path(for_write=False)
    try:
        conn = _livechat_db_connect_sync(db_path)
        rows = conn.execute(
            f"SELECT id, payload_json FROM {_LIVECHAT_DB_TABLE} WHERE event_ref=? AND id>? ORDER BY id ASC LIMIT ?",
            (ref, int(after_id or 0), int(limit)),
        ).fetchall()
    except Exception:
        try:
            conn.close()
        except Exception:
            pass
        return int(after_id or 0), []
    finally:
        try:
            conn.close()
        except Exception:
            pass

    msgs: List[Dict[str, Any]] = []
    last_id = int(after_id or 0)
    for rid, payload_json in (rows or []):
        try:
            rid_int = int(rid or 0)
            last_id = max(last_id, rid_int)
        except Exception:
            pass
        try:
            obj = json.loads(payload_json) if payload_json else None
            if isinstance(obj, dict):
                msgs.append(obj)
        except Exception:
            pass
    return last_id, msgs

async def _livechat_poll_db(websocket: WebSocket, event_ref: str, after_id: int) -> None:
    last_id = int(after_id or 0)
    try:
        while True:
            await asyncio.sleep(_LIVECHAT_DB_POLL_INTERVAL_SEC)
            new_last, msgs = await run_in_threadpool(_livechat_db_fetch_after_sync, event_ref, last_id, 80)
            if not msgs:
                last_id = max(last_id, int(new_last or 0))
                continue
            last_id = max(last_id, int(new_last or 0))
            for m in msgs:
                try:
                    await websocket.send_text(json.dumps(m, ensure_ascii=False))
                except Exception:
                    return
    except asyncio.CancelledError:
        return
    except Exception:
        return

class LiveChatSendRequest(BaseModel):
    eventRef: str = ""
    clientMsgId: Optional[str] = None

    # Accept either 'role' or 'senderRole' from older/newer clients.
    role: Optional[str] = None
    senderRole: Optional[str] = None

    # Display name
    name: Optional[str] = None

    # Accept either 'text' or 'message' from older/newer clients.
    text: Optional[str] = None
    message: Optional[str] = None

    # Accept either 'memberId' or 'senderId' from older/newer clients.
    memberId: Optional[str] = None
    senderId: Optional[str] = None

    ts: Optional[float] = None


@app.websocket("/stream/beestreamed/livechat/{event_ref}")
async def beestreamed_livechat_ws(websocket: WebSocket, event_ref: str):
    event_ref = (event_ref or "").strip()
    await websocket.accept()

    if not event_ref:
        await websocket.close(code=1008)
        return

    # Capture identity from connection query params.
    qs = websocket.query_params
    member_id = (qs.get("memberId") or qs.get("member_id") or qs.get("senderId") or qs.get("sender_id") or "").strip()
    role = _normalize_livechat_role(qs.get("role") or "")
    name = (qs.get("name") or "").strip()

    # Register socket + identity
    with _LIVECHAT_LOCK:
        _LIVECHAT_CLIENTS.setdefault(event_ref, set()).add(websocket)
        _LIVECHAT_CLIENT_META[websocket] = {
            "eventRef": event_ref,
            "memberId": member_id,
            "role": role,
            "name": name,
        }
        history: List[Dict[str, Any]] = []  # per-worker; DB history is fetched below

    # Shared DB history (cross-worker).
    last_db_id, history = await run_in_threadpool(_livechat_db_fetch_history_sync, event_ref, _LIVECHAT_DB_HISTORY_LIMIT)
    poll_task: Optional[asyncio.Task] = None

    # Send recent history to the newly connected client.
    if history:
        try:
            await websocket.send_text(
                json.dumps(
                    {"type": "history", "eventRef": event_ref, "messages": history, "ts": time.time()},
                    ensure_ascii=False,
                )
            )
        except Exception:
            pass

    # Poll shared DB for messages inserted by other API workers and mirror them to this websocket.
    try:
        poll_task = asyncio.create_task(_livechat_poll_db(websocket, event_ref, last_db_id))
    except Exception:
        poll_task = None

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                incoming = json.loads(raw)
                if not isinstance(incoming, dict):
                    incoming = {"text": str(incoming)}
            except Exception:
                incoming = {"text": raw}

            msg_type = str(incoming.get("type") or "chat").strip().lower()

            # Optional ping/pong
            if msg_type == "ping":
                try:
                    await websocket.send_text(json.dumps({"type": "pong", "ts": time.time()}))
                except Exception:
                    pass
                continue

            # We only broadcast chat messages.
            if msg_type not in ("chat", "message"):
                continue

            text_val = incoming.get("text")
            if text_val is None or str(text_val).strip() == "":
                text_val = incoming.get("message") or incoming.get("content") or ""
            text_val = str(text_val).strip()
            if not text_val:
                continue

            # Accept both clientMsgId (preferred) and legacy clientId fields.
            client_msg_id = (
                str(
                    incoming.get("clientMsgId")
                    or incoming.get("client_msg_id")
                    or incoming.get("clientId")
                    or incoming.get("client_id")
                    or ""
                ).strip()
                or str(uuid.uuid4())
            )

            ts_in = incoming.get("ts")
            try:
                ts = float(ts_in) if ts_in is not None else time.time()
            except Exception:
                ts = time.time()

            out: Dict[str, Any] = {
                "type": "chat",
                "eventRef": event_ref,
                "text": text_val,
                "clientMsgId": client_msg_id,
                "ts": ts,
                "senderId": member_id,
                "senderRole": role,
                "name": name,
            }

            _livechat_push_history(event_ref, out)
            await run_in_threadpool(_livechat_db_insert_sync, event_ref, out)
            await _livechat_broadcast(event_ref, out)

    except WebSocketDisconnect:
        pass
    except Exception:
        # Keep the server resilient: drop the connection silently.
        pass
    finally:
        try:
            if poll_task is not None:
                poll_task.cancel()
        except Exception:
            pass

        with _LIVECHAT_LOCK:
            s = _LIVECHAT_CLIENTS.get(event_ref, set())
            try:
                s.discard(websocket)
            except Exception:
                pass
            _LIVECHAT_CLIENT_META.pop(websocket, None)
            if not s:
                _LIVECHAT_CLIENTS.pop(event_ref, None)
                _LIVECHAT_HISTORY.pop(event_ref, None)


@app.post("/stream/beestreamed/livechat/send")
async def beestreamed_livechat_send(req: LiveChatSendRequest):
    event_ref = (req.eventRef or "").strip()
    if not event_ref:
        raise HTTPException(status_code=400, detail="eventRef is required")

    text_val = str((req.text or req.message or "")).strip()
    if not text_val:
        return {"ok": True}

    sender_id = str((req.senderId or req.memberId or "")).strip()
    sender_role = _normalize_livechat_role(req.senderRole or req.role or "viewer")
    name = str((req.name or "")).strip()

    try:
        ts = float(req.ts) if req.ts is not None else time.time()
    except Exception:
        ts = time.time()

    payload: Dict[str, Any] = {
        "type": "chat",
        "eventRef": event_ref,
        "clientMsgId": (req.clientMsgId or str(uuid.uuid4())),
        "text": text_val,
        "ts": ts,
        "senderId": sender_id,
        "senderRole": sender_role,
        "name": name,
    }

    _livechat_push_history(event_ref, payload)
    await run_in_threadpool(_livechat_db_insert_sync, event_ref, payload)
    await _livechat_broadcast(event_ref, payload)
    return {"ok": True}

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
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
      referrerpolicy="no-referrer-when-downgrade"
      allow="autoplay; fullscreen; picture-in-picture; microphone; camera"
      allowfullscreen
    ></iframe>
  </body>
</html>"""

    # No caching: viewer state is time-sensitive.
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

def _beestreamed_start_webrtc_sync(event_ref: str) -> Dict[str, Any]:
    import requests  # type: ignore

    ref = (event_ref or "").strip()
    if not ref:
        return {"ok": False, "error": "event_ref required"}

    api_base = _beestreamed_api_base()
    headers = _beestreamed_auth_headers()

    try:
        r = requests.post(f"{api_base}/events/{ref}/startwebrtcstream", headers=headers, timeout=20)
        return {
            "ok": (r.status_code // 100 == 2),
            "status_code": r.status_code,
            "body": (r.text or ""),
            "authMode": "basic",
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "authMode": "basic"}
def _beestreamed_stop_webrtc_sync(event_ref: str) -> Dict[str, Any]:
    """Stop the BeeStreamed WebRTC stream and fully end the event.

    IMPORTANT:
      - The *Stop* action in our UI must end the live stream in BeeStreamed (no manual "End Live").
      - We do this in two steps:
          1) POST /events/{event_ref}/stopwebrtcstream
          2) PATCH /events/{event_ref} with status = "done"

    Auth:
      - Server-side Basic auth using STREAM_TOKEN_ID / STREAM_SECRET_KEY.
      - Tokens are never exposed to the browser.
    """
    import requests  # type: ignore

    ref = (event_ref or "").strip()
    if not ref:
        return {"ok": False, "error": "event_ref required"}

    api_base = _beestreamed_api_base()
    headers = _beestreamed_auth_headers()

    # 1) Stop WebRTC stream
    try:
        r = requests.post(f"{api_base}/events/{ref}/stopwebrtcstream", headers=headers, timeout=20)
    except Exception as e:
        return {"ok": False, "error": f"stopwebrtcstream request failed: {e!r}"}

    stop_ok = (r.status_code // 100 == 2)
    res: Dict[str, Any] = {
        "stop_ok": stop_ok,
        "stop_status_code": r.status_code,
        "stop_body": (r.text or "")[:1200],
    }
    if not stop_ok:
        res["ok"] = False
        return res

    # 2) Finalize/End the event (equivalent to BeeStreamed UI "End Live")
    # NOTE: We use exact "done" (lowercase) and include both `status` and `Status` keys defensively.
    payload = {"status": "done", "Status": "done"}
    try:
        r2 = requests.patch(f"{api_base}/events/{ref}", headers=headers, json=payload, timeout=20)
        end_ok = (r2.status_code // 100 == 2)
        res.update(
            {
                "end_ok": end_ok,
                "end_status_code": r2.status_code,
                "end_body": (r2.text or "")[:1200],
            }
        )

        # 3) BeeStreamed recommends setting the event back to idle if you want to reuse the same event_ref.
        # We attempt this as a best-effort step after ending the live session.
        if end_ok:
            payload_idle = {"status": "idle", "Status": "idle"}
            try:
                r3 = requests.patch(f"{api_base}/events/{ref}", headers=headers, json=payload_idle, timeout=20)
                idle_ok = (r3.status_code // 100 == 2)
                res.update(
                    {
                        "idle_ok": idle_ok,
                        "idle_status_code": r3.status_code,
                        "idle_body": (r3.text or "")[:1200],
                    }
                )
            except Exception as e:
                res.update({"idle_ok": False, "idle_error": f"idle patch failed: {e!r}"})

        # Ending the live session is the primary requirement for stop.
        # We still include idle_ok diagnostics, but ok tracks end_ok so the UI can recover cleanly.
        res["ok"] = bool(end_ok)
        return res
    except Exception as e:
        res.update({"end_ok": False, "end_error": f"end-event patch failed: {e!r}", "ok": False})
        return res
def _resolve_host_member_id(brand: str, avatar: str, mapping: Optional[Dict[str, Any]]) -> str:
    host = ""
    if mapping:
        host = str(mapping.get("host_member_id") or "").strip()

    # Fallback for current single-host deployment (DulceMoon/Dulce).
    if not host:
        if (brand or "").strip().lower() == "dulcemoon" and (avatar or "").strip().lower().startswith("dulce"):
            host = DULCE_HOST_MEMBER_ID_FALLBACK
    return host

def _persist_event_ref_best_effort(brand: str, avatar: str, event_ref: str) -> bool:
    """Try to persist event_ref into the companion_mappings SQLite DB (if writable). Always updates in-memory mapping."""
    b = (brand or "").strip()
    a = (avatar or "").strip()
    e = (event_ref or "").strip()
    if not b or not a or not e:
        return False

    # Always update in-memory mapping so this process is consistent.
    try:
        key = (b.lower(), a.lower())
        if key in _COMPANION_MAPPINGS:
            _COMPANION_MAPPINGS[key]["event_ref"] = e
    except Exception:
        pass

    db_path = (_COMPANION_MAPPINGS_SOURCE or "").strip()
    if not db_path or not os.path.exists(db_path):
        return False

    try:
        table_name = (_COMPANION_MAPPINGS_TABLE or "companion_mappings").strip() or "companion_mappings"
        # table_name comes from sqlite_master at startup, but keep this defensive.
        if not re.match(r"^[A-Za-z0-9_]+$", table_name):
            table_name = "companion_mappings"

        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute(f"PRAGMA table_info({table_name})")
        cols = [str(r[1] or "").strip() for r in cur.fetchall()]
        cols_l = [c.lower() for c in cols]

        # Ensure event_ref column exists
        if "event_ref" not in cols_l:
            try:
                cur.execute(f"ALTER TABLE {table_name} ADD COLUMN event_ref TEXT")
                conn.commit()
                cols_l.append("event_ref")
            except Exception:
                # read-only DB or unsupported ALTER; give up persistence but keep in-memory update
                return False

        # Determine key columns
        brand_col = "brand" if "brand" in cols_l else ("brand_id" if "brand_id" in cols_l else "")
        avatar_col = "avatar" if "avatar" in cols_l else ("companion" if "companion" in cols_l else "")
        if not brand_col or not avatar_col:
            return False

        cur.execute(
            f"UPDATE {table_name} SET event_ref = ? WHERE lower({brand_col}) = lower(?) AND lower({avatar_col}) = lower(?)",
            (e, b, a),
        )
        conn.commit()
        return True
    except Exception:
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _read_event_ref_from_db(brand: str, avatar: str) -> str:
    """Read event_ref directly from SQLite.

    Uses the same resolved DB path as session_active so that reads reflect any
    updates made at runtime (e.g., when /home/site is read-only and we write to
    the writable /tmp copy).
    """
    b = (brand or "").strip()
    a = (avatar or "").strip()
    if not b or not a:
        return ""

    db_path = _get_companion_mappings_db_path(for_write=False)
    if not db_path or not os.path.exists(db_path):
        return ""

    table_name = (_COMPANION_MAPPINGS_TABLE or "companion_mappings").strip() or "companion_mappings"
    if not re.match(r"^[A-Za-z0-9_]+$", table_name):
        table_name = "companion_mappings"

    conn: Optional[sqlite3.Connection] = None
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()

        # If the column isn't present (older DB), treat as empty.
        cur.execute(f"PRAGMA table_info({table_name})")
        cols = [str(r[1] or "").strip().lower() for r in cur.fetchall()]
        if "event_ref" not in cols:
            return ""

        cur.execute(
            f"SELECT event_ref FROM {table_name} WHERE lower(brand) = lower(?) AND lower(avatar) = lower(?) LIMIT 1",
            (b, a),
        )
        row = cur.fetchone()
        return str(row[0] or "").strip() if row else ""
    except Exception:
        return ""
    finally:
        try:
            if conn:
                conn.close()
        except Exception:
            pass




def _get_companion_mappings_db_path(for_write: bool = False) -> str:
    """Return the SQLite path to use for companion_mappings reads/writes.

    In Azure App Service, /home/site is often read-only at runtime. When we need to
    write (or read what we previously wrote), we use the writable copy under /tmp
    created by _ensure_writable_db_copy().
    """
    db_path = (_COMPANION_MAPPINGS_SOURCE or "").strip()
    if not db_path:
        return ""
    if for_write:
        try:
            return _ensure_writable_db_copy(db_path)
        except Exception:
            return db_path
    # For reads, prefer the writable copy *if it already exists*; otherwise fall back
    # to the source path.
    try:
        writable = _ensure_writable_db_copy(db_path)
        return writable or db_path
    except Exception:
        return db_path


def _is_session_active(brand: str, avatar: str) -> bool:
    """Read session_active from SQLite (fallback to False if missing).

    Defensive: treat a session as active only when it has a non-empty kind and room/ref
    (when those columns exist). This prevents "phantom" active sessions when a flag
    is left true but the room/ref is blank.
    """
    b = (brand or "").strip()
    a = (avatar or "").strip()
    if not b or not a:
        return False

    db_path = _get_companion_mappings_db_path(for_write=False)
    if not db_path or not os.path.exists(db_path):
        return False

    table_name = (_COMPANION_MAPPINGS_TABLE or "companion_mappings").strip() or "companion_mappings"
    if not re.match(r"^[A-Za-z0-9_]+$", table_name):
        table_name = "companion_mappings"

    conn: Optional[sqlite3.Connection] = None
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()

        cur.execute(f"PRAGMA table_info({table_name})")
        cols = [str(r[1] or "").strip().lower() for r in cur.fetchall()]
        if "session_active" not in cols:
            return False

        has_kind = "session_kind" in cols
        has_ref = "session_event_ref" in cols

        select_cols = ["session_active"]
        if has_kind:
            select_cols.append("session_kind")
        if has_ref:
            select_cols.append("session_event_ref")

        cur.execute(
            f"SELECT {', '.join(select_cols)} FROM {table_name} "
            f"WHERE lower(brand) = lower(?) AND lower(avatar) = lower(?) LIMIT 1",
            (b, a),
        )
        row = cur.fetchone()
        if not row:
            return False

        active_raw = row[0]
        try:
            active = bool(int(active_raw)) if active_raw is not None else False
        except Exception:
            active = bool(active_raw)

        if not active:
            return False

        idx = 1
        if has_kind:
            kind = str(row[idx] or "").strip()
            idx += 1
            if not kind:
                return False

        if has_ref:
            ref = str(row[idx] or "").strip()
            if not ref:
                return False

        return True
    except Exception:
        return False
    finally:
        try:
            if conn:
                conn.close()
        except Exception:
            pass
def _set_session_active(brand: str, avatar: str, active: bool, event_ref: Optional[str] = None) -> bool:
    """Persist session_active (and optionally event_ref if currently empty) to SQLite.

    Returns True if an UPDATE/INSERT was attempted successfully.
    """
    b = (brand or "").strip()
    a = (avatar or "").strip()
    if not b or not a:
        return False

    db_path = _get_companion_mappings_db_path(for_write=True)
    if not db_path or not os.path.exists(db_path):
        return False

    table_name = (_COMPANION_MAPPINGS_TABLE or "companion_mappings").strip() or "companion_mappings"
    if not re.match(r"^[A-Za-z0-9_]+$", table_name):
        table_name = "companion_mappings"

    ev = (event_ref or "").strip()

    conn: Optional[sqlite3.Connection] = None
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()

        # Ensure columns exist; if session_active is missing, do nothing (caller already migrated DB).
        cur.execute(f"PRAGMA table_info({table_name})")
        cols = [str(r[1] or "").strip().lower() for r in cur.fetchall()]
        if "session_active" not in cols:
            return False

        # Update existing row.
        if ev and ("event_ref" in cols):
            # Only set event_ref if it's currently NULL/empty, to keep the DB as source of truth.
            cur.execute(
                f"UPDATE {table_name} "
                f"SET session_active = ?, "
                f"    event_ref = CASE WHEN event_ref IS NULL OR trim(event_ref) = '' THEN ? ELSE event_ref END "
                f"WHERE lower(brand) = lower(?) AND lower(avatar) = lower(?)",
                (1 if active else 0, ev, b, a),
            )
        else:
            cur.execute(
                f"UPDATE {table_name} "
                f"SET session_active = ? "
                f"WHERE lower(brand) = lower(?) AND lower(avatar) = lower(?)",
                (1 if active else 0, b, a),
            )

        if cur.rowcount == 0:
            # If row doesn't exist, insert minimal keys (other columns nullable).
            if ev and ("event_ref" in cols):
                cur.execute(
                    f"INSERT INTO {table_name} (brand, avatar, session_active, event_ref) VALUES (?, ?, ?, ?)",
                    (b, a, 1 if active else 0, ev),
                )
            else:
                cur.execute(
                    f"INSERT INTO {table_name} (brand, avatar, session_active) VALUES (?, ?, ?)",
                    (b, a, 1 if active else 0),
                )

        conn.commit()
        return True
    except Exception:
        try:
            if conn:
                conn.rollback()
        except Exception:
            pass
        return False
    finally:
        try:
            if conn:
                conn.close()
        except Exception:
            pass





# =============================================================================
# Session kind/room helpers (shared across workers via the DB)
#
# session_active (0/1) remains the truth source for "is a live session active?"
# session_kind indicates WHAT kind of session is active: "stream" or "conference".
# session_room is used for conference providers (Jitsi room name).
# =============================================================================

def _sanitize_room_token(raw: str, *, max_len: int = 128) -> str:
  """Sanitize a string into a URL-safe token (lowercase, letters/digits/-)."""
  s = (raw or "").strip().lower()
  # Replace any non [a-z0-9] with hyphen
  s = re.sub(r"[^a-z0-9]+", "-", s)
  s = re.sub(r"-+", "-", s).strip("-")
  if not s:
    return "room"
  return s[:max_len]


def _read_session_kind_room(resolved_brand: str, resolved_avatar: str) -> tuple[str, str]:
  """Read session_kind/session_room from DB. Returns (kind, room) or ("", "") if unavailable."""
  try:
    b = (resolved_brand or "").strip()
    a = (resolved_avatar or "").strip()
    if not b or not a:
      return "", ""

    db_path = _get_companion_mappings_db_path(for_write=False)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
      cur = conn.cursor()

      # Columns may not exist yet in older DBs; detect safely.
      cur.execute("PRAGMA table_info(companion_mappings)")
      cols = {row[1].lower() for row in cur.fetchall()}

      if "session_kind" not in cols and "session_room" not in cols:
        return "", ""

      sel_cols = []
      if "session_kind" in cols:
        sel_cols.append("COALESCE(session_kind, '') AS session_kind")
      else:
        sel_cols.append("'' AS session_kind")
      if "session_room" in cols:
        sel_cols.append("COALESCE(session_room, '') AS session_room")
      else:
        sel_cols.append("'' AS session_room")

      cur.execute(
        f"SELECT {', '.join(sel_cols)} FROM companion_mappings WHERE lower(brand)=lower(?) AND lower(avatar)=lower(?)",
        (b, a),
      )
      row = cur.fetchone()
      if not row:
        return "", ""
      kind = (row["session_kind"] or "").strip().lower()
      room = (row["session_room"] or "").strip()
      return kind, room
    finally:
      conn.close()
  except Exception:
    return "", ""


def _set_session_kind_room_best_effort(resolved_brand: str, resolved_avatar: str, *, kind: str | None = None, room: str | None = None) -> bool:
  """Best-effort upsert/update of session_kind/session_room in companion_mappings."""
  if kind is None and room is None:
    return True

  try:
    b = (resolved_brand or "").strip()
    a = (resolved_avatar or "").strip()
    if not b or not a:
      return False

    db_path = _get_companion_mappings_db_path(for_write=True)
    conn = sqlite3.connect(db_path)
    try:
      cur = conn.cursor()

      # Ensure columns exist
      cur.execute("PRAGMA table_info(companion_mappings)")
      cols = {row[1].lower() for row in cur.fetchall()}

      if "session_kind" not in cols:
        cur.execute("ALTER TABLE companion_mappings ADD COLUMN session_kind TEXT")
        cols.add("session_kind")
      if "session_room" not in cols:
        cur.execute("ALTER TABLE companion_mappings ADD COLUMN session_room TEXT")
        cols.add("session_room")

      # Ensure row exists (INSERT OR IGNORE)
      cur.execute(
        "INSERT OR IGNORE INTO companion_mappings (brand, avatar) VALUES (?, ?)",
        (b, a),
      )

      # UPDATE only provided fields
      sets = []
      params = []
      if kind is not None:
        sets.append("session_kind = ?")
        params.append((kind or "").strip().lower() or None)
      if room is not None:
        sets.append("session_room = ?")
        params.append((room or "").strip() or None)

      if sets:
        params.extend([b, a])
        cur.execute(
          f"UPDATE companion_mappings SET {', '.join(sets)} WHERE lower(brand)=lower(?) AND lower(avatar)=lower(?)",
          tuple(params),
        )

      conn.commit()
      return True
    finally:
      conn.close()
  except Exception:
    return False



# =============================================================================
# LiveKit DB columns (non-destructive migrations)
# =============================================================================
def _ensure_livekit_columns_best_effort() -> None:
    """Ensure LiveKit-specific columns exist in companion_mappings.

    This is NON-DESTRUCTIVE: it only adds columns if missing and never drops any
    existing (including BeeStreamed) columns.
    """
    try:
        db_path = _get_companion_mappings_db_path(for_write=True)
        conn = sqlite3.connect(db_path)
        try:
            cur = conn.cursor()
            cur.execute("PRAGMA table_info(companion_mappings)")
            cols = {row[1].lower() for row in cur.fetchall()}

            # Keep event_ref as the reusable identifier (we store LiveKit roomName there for now).
            # Add additional LiveKit operational fields.
            to_add = []
            if "livekit_room_name" not in cols:
                to_add.append(("livekit_room_name", "TEXT"))
            if "livekit_record_egress_id" not in cols:
                to_add.append(("livekit_record_egress_id", "TEXT"))
            if "livekit_hls_egress_id" not in cols:
                to_add.append(("livekit_hls_egress_id", "TEXT"))
            if "livekit_hls_url" not in cols:
                to_add.append(("livekit_hls_url", "TEXT"))
            if "livekit_last_started_at" not in cols:
                to_add.append(("livekit_last_started_at", "INTEGER"))

            for name, typ in to_add:
                try:
                    cur.execute(f"ALTER TABLE companion_mappings ADD COLUMN {name} {typ}")
                except Exception:
                    pass

            conn.commit()
        finally:
            conn.close()
    except Exception:
        # Best-effort: DB may be read-only in some environments.
        return


def _set_livekit_fields_best_effort(
    resolved_brand: str,
    resolved_avatar: str,
    *,
    room_name: str | None = None,
    record_egress_id: str | None = None,
    hls_egress_id: str | None = None,
    hls_url: str | None = None,
    last_started_at_ms: int | None = None,
) -> bool:
    """Best-effort update of LiveKit-specific columns for a (brand, avatar)."""
    if all(v is None for v in (room_name, record_egress_id, hls_egress_id, hls_url, last_started_at_ms)):
        return True
    try:
        b = (resolved_brand or "").strip()
        a = (resolved_avatar or "").strip()
        if not b or not a:
            return False

        db_path = _get_companion_mappings_db_path(for_write=True)
        conn = sqlite3.connect(db_path)
        try:
            cur = conn.cursor()
            _ensure_livekit_columns_best_effort()

            cur.execute(
                "INSERT OR IGNORE INTO companion_mappings (brand, avatar) VALUES (?, ?)",
                (b, a),
            )

            sets = []
            params = []
            if room_name is not None:
                sets.append("livekit_room_name = ?")
                params.append((room_name or "").strip() or None)
            if record_egress_id is not None:
                sets.append("livekit_record_egress_id = ?")
                params.append((record_egress_id or "").strip() or None)
            if hls_egress_id is not None:
                sets.append("livekit_hls_egress_id = ?")
                params.append((hls_egress_id or "").strip() or None)
            if hls_url is not None:
                sets.append("livekit_hls_url = ?")
                params.append((hls_url or "").strip() or None)
            if last_started_at_ms is not None:
                sets.append("livekit_last_started_at = ?")
                params.append(int(last_started_at_ms))

            if sets:
                params.extend([b, a])
                cur.execute(
                    f"UPDATE companion_mappings SET {', '.join(sets)} WHERE lower(brand)=lower(?) AND lower(avatar)=lower(?)",
                    tuple(params),
                )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception:
        return False

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


@app.post("/stream/beestreamed/start_embed")
async def beestreamed_start_embed(req: BeeStreamedStartEmbedRequest):
    mapping = _lookup_companion_mapping(req.brand, req.avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="No mapping for that brand/avatar")

    resolved_brand = mapping.get("brand") or req.brand
    resolved_avatar = mapping.get("avatar") or req.avatar

    # Guardrail: BeeStreamed is ONLY for Human companions configured for Stream video.
    live_lc = str(mapping.get("live") or "").strip().lower()
    ctype_lc = str(mapping.get("companion_type") or "").strip().lower()
    cap_lc = str(mapping.get("channel_cap") or "").strip().lower()

    if live_lc != "stream" or ctype_lc != "human" or cap_lc != "video":
        raise HTTPException(
            status_code=400,
            detail={
                "error": "BeeStreamed is only valid for Human companions with channel_cap=Video and live=Stream",
                "brand": str(resolved_brand),
                "avatar": str(resolved_avatar),
                "companion_type": str(mapping.get("companion_type") or ""),
                "channel_cap": str(mapping.get("channel_cap") or ""),
                "live": str(mapping.get("live") or ""),
            },
        )

    # Host auth: only the configured host can START the stream.
    host_id = (mapping.get("host_member_id") or "").strip()
    member_id = (req.memberId or "").strip()
    is_host = bool(host_id) and bool(member_id) and (host_id.lower() == member_id.lower())

    # We intentionally track "session active" in-memory so viewers can JOIN after the host has started,
    # without needing to be the host themselves.
    session_active = _is_session_active(resolved_brand, resolved_avatar)

    # Always read the latest persisted event_ref (this is the value viewers must use to join).
    event_ref = _read_event_ref_from_db(resolved_brand, resolved_avatar) or ""
    embed_url = f"/stream/beestreamed/embed/{event_ref}" if event_ref else ""

    # Viewer path: allow join only when the host has started a session.
    if not is_host:
        if not session_active or not event_ref:
            return {
                "ok": True,
                "status": "waiting",
                "canStart": False,
                "isHost": False,
                "sessionActive": bool(session_active),
                "eventRef": event_ref,
                "embedUrl": embed_url,
                "message": f"Waiting on {resolved_avatar} to start event",
            }

        return {
            "ok": True,
            "status": "started",
            "canStart": False,
            "isHost": False,
            "sessionActive": True,
            "eventRef": event_ref,
            "embedUrl": embed_url,
            "message": "",
        }

    # Host path: ensure an event_ref exists, then start WebRTC.
    if not event_ref:
        event_ref = _beestreamed_create_event_sync(req.embedDomain)
        embed_url = f"/stream/beestreamed/embed/{event_ref}" if event_ref else ""
        _persist_event_ref_best_effort(resolved_brand, resolved_avatar, event_ref)

    # Ensure event is scheduled "now" and bound to the correct embed domain (prevents pop-out issues).
    _beestreamed_schedule_now_sync(
        event_ref,
        title=f"{resolved_brand} {resolved_avatar}",
        embed_domain=req.embedDomain,
    )

    start_res = _beestreamed_start_webrtc_sync(event_ref)

    # BeeStreamed occasionally returns 404 for a stale event ref. Recreate once and retry.
    if (not start_res.get("ok")) and (start_res.get("status_code") == 404):
        event_ref = _beestreamed_create_event_sync(req.embedDomain)
        embed_url = f"/stream/beestreamed/embed/{event_ref}" if event_ref else ""
        _persist_event_ref_best_effort(resolved_brand, resolved_avatar, event_ref)
        _beestreamed_schedule_now_sync(
            event_ref,
            title=f"{resolved_brand} {resolved_avatar}",
            embed_domain=req.embedDomain,
        )
        start_res = _beestreamed_start_webrtc_sync(event_ref)

    if not start_res.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=f"BeeStreamed start_webrtc failed: {start_res.get('error') or start_res.get('body') or start_res}",
        )


    # If we're starting a new session on a reused event_ref, clear any persisted livechat rows
    # so the new session doesn't replay the previous session's chat history.
    if (not session_active) and event_ref:
        try:
            deleted = await run_in_threadpool(_livechat_db_clear_event_sync, event_ref)
            if deleted:
                _dlog("Cleared prior livechat history", {"event_ref": event_ref, "deleted": deleted})
        except Exception as e:
            _dlog("Failed clearing livechat history (ignored)", {"event_ref": event_ref, "err": str(e)})

    _set_session_active(resolved_brand, resolved_avatar, active=True, event_ref=event_ref)

    _set_session_kind_room_best_effort(resolved_brand, resolved_avatar, kind="stream", room="")

    return {
        "ok": True,
        "status": "started",
        "canStart": True,
        "isHost": True,
        "sessionActive": True,
        "eventRef": event_ref,
        "embedUrl": embed_url,
        "message": "",
    }
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
        _persist_event_ref_best_effort(resolved_brand, resolved_avatar, event_ref)

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
                    _persist_event_ref_best_effort(resolved_brand, resolved_avatar, event_ref)
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

    resolved_brand = mapping.get("brand") or brand
    resolved_avatar = mapping.get("avatar") or avatar

    # Use DB as the source of truth for event_ref.
    # When the app runs with multiple workers, each worker has its own in-memory
    # mapping cache; without this DB read, pollers can observe different eventRef values.
    event_ref = _read_event_ref_from_db(resolved_brand, resolved_avatar)
    mapping["event_ref"] = event_ref

    active = bool(_is_session_active(resolved_brand, resolved_avatar))

    session_kind, session_room = _read_session_kind_room(resolved_brand, resolved_avatar)

    # Back-compat: older DBs won't have session_kind; treat an active session as a stream.

    if active and not session_kind:

        session_kind = "stream"


    return {

        "ok": True,

        "eventRef": event_ref,

        "embedUrl": f"/stream/beestreamed/embed/{event_ref}" if event_ref else "",

        "hostMemberId": str(mapping.get("host_member_id") or "").strip(),

        "companionType": str(mapping.get("companion_type") or "").strip(),

        "live": str(mapping.get("live") or "").strip(),

        "sessionActive": active,

        "sessionKind": session_kind,

        "sessionRoom": session_room,
    }


    



@app.get("/stream/livekit/status_legacy")
async def livekit_status(brand: str, avatar: str):
    """Return current LiveKit mapping state for a companion (does not start anything).

    Mirrors /stream/beestreamed/status but sources LiveKit-specific fields from DB.
    """
    brand = (brand or "").strip()
    avatar = (avatar or "").strip()
    if not brand or not avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required")

    mapping = _lookup_companion_mapping(brand, avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="Companion mapping not found")

    resolved_brand = mapping.get("brand") or brand
    resolved_avatar = mapping.get("avatar") or avatar

    # Canonical durable reference for the session in this app is event_ref (now used as room name for LiveKit).
    event_ref = _read_event_ref_from_db(resolved_brand, resolved_avatar)
    mapping["event_ref"] = event_ref

    active = bool(_is_session_active(resolved_brand, resolved_avatar))
    session_kind, session_room = _read_session_kind_room(resolved_brand, resolved_avatar)
    if active and not session_kind:
        session_kind = "stream"

    # LiveKit fields (best-effort; columns may not exist on older DBs)
    livekit_room_name = ""
    livekit_hls_url = ""
    livekit_record_egress_id = ""
    livekit_hls_egress_id = ""
    livekit_last_started_at = 0
    try:
        db_path = _get_companion_mappings_db_path(for_write=False)
        conn = sqlite3.connect(db_path)
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT livekit_room_name, livekit_hls_url, livekit_record_egress_id, livekit_hls_egress_id, livekit_last_started_at
                FROM companion_mappings
                WHERE brand = ? AND avatar = ?
                LIMIT 1
                """,
                (resolved_brand, resolved_avatar),
            )
            row = cur.fetchone()
            if row:
                livekit_room_name = str(row[0] or "").strip()
                livekit_hls_url = str(row[1] or "").strip()
                livekit_record_egress_id = str(row[2] or "").strip()
                livekit_hls_egress_id = str(row[3] or "").strip()
                try:
                    livekit_last_started_at = int(row[4] or 0)
                except Exception:
                    livekit_last_started_at = 0
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception:
        # ignore; return base fields only
        pass

    # Normalize: prefer session_room, then livekit_room_name, then event_ref
    room = (session_room or "").strip() or livekit_room_name or event_ref

    return {
        "ok": True,
        "eventRef": room,  # frontend uses this as its durable room reference
        "hostMemberId": str(mapping.get("host_member_id") or "").strip(),
        "companionType": str(mapping.get("companion_type") or "").strip(),
        "live": str(mapping.get("live") or "").strip(),
        "sessionActive": active,
        "sessionKind": session_kind,
        "sessionRoom": room,
        "livekit": {
            "roomName": livekit_room_name or room,
            "hlsUrl": livekit_hls_url,
            "recordEgressId": livekit_record_egress_id,
            "hlsEgressId": livekit_hls_egress_id,
            "lastStartedAt": livekit_last_started_at,
        },
    }


@app.post("/stream/livekit/livechat/send")
async def livekit_livechat_send(req: LiveChatSendRequest):
    """Alias LiveKit chat send to the existing livechat pipeline (room is eventRef)."""
    return await beestreamed_livechat_send(req)


@app.websocket("/stream/livekit/livechat/{event_ref}")
async def livekit_livechat_ws(websocket: WebSocket, event_ref: str):
    """Alias LiveKit chat websocket to the existing livechat pipeline."""
    return await beestreamed_livechat_ws(websocket, event_ref)


@app.post("/conference/livekit/livechat/send")
async def conference_livekit_livechat_send(req: LiveChatSendRequest):
    """Conference LiveKit chat send (same pipeline as stream)."""
    return await beestreamed_livechat_send(req)


@app.websocket("/conference/livekit/livechat/{event_ref}")
async def conference_livekit_livechat_ws(websocket: WebSocket, event_ref: str):
    """Conference LiveKit chat websocket (same pipeline as stream)."""
    return await beestreamed_livechat_ws(websocket, event_ref)

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
    """Stop a BeeStreamed stream session.

    - Only the configured host may actually stop/end the stream.
    - Viewers may call this endpoint (e.g., when closing the iframe) but it won't stop the stream.
    """
    mapping = _lookup_companion_mapping(req.brand, req.avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="No mapping for that brand/avatar")

    resolved_brand = mapping.get("brand") or req.brand
    resolved_avatar = mapping.get("avatar") or req.avatar

    host_id = (mapping.get("host_member_id") or "").strip()
    member_id = (req.memberId or "").strip()
    is_host = bool(host_id) and bool(member_id) and (host_id.lower() == member_id.lower())

    # Prefer explicit eventRef from the client; fall back to DB.
    event_ref = (req.eventRef or "").strip() or (_read_event_ref_from_db(resolved_brand, resolved_avatar) or "").strip()

    if not is_host:
        return {
            "ok": True,
            "status": "not_host",
            "isHost": False,
            "canStop": False,
            "sessionActive": bool(_is_session_active(resolved_brand, resolved_avatar)),
            "eventRef": event_ref,
            "message": "",
        }

    if not event_ref:
        # If the host tries to stop without an eventRef, mark the session inactive anyway.
        _set_session_active(resolved_brand, resolved_avatar, active=False)

        _set_session_kind_room_best_effort(resolved_brand, resolved_avatar, kind="", room="")
        _set_livekit_fields_best_effort(resolved_brand, resolved_avatar, record_egress_id=None, hls_egress_id=None, hls_url=None)
        return {
            "ok": True,
            "status": "no_event_ref",
            "isHost": True,
            "canStop": True,
            "sessionActive": False,
            "eventRef": "",
            "message": "No eventRef to stop.",
        }


    # Idempotence: remember whether the session was actually active before stopping, so we don't
    # spam duplicate system lines if stop is called multiple times.
    was_active = bool(_is_session_active(resolved_brand, resolved_avatar))

    stop_res = _beestreamed_stop_webrtc_sync(event_ref)
    if not stop_res.get("ok"):
        raise HTTPException(status_code=502, detail=f"BeeStreamed stop failed: {stop_res}")

    _set_session_active(resolved_brand, resolved_avatar, active=False, event_ref=event_ref)


    _set_session_kind_room_best_effort(resolved_brand, resolved_avatar, kind="", room="")

    # Best-effort: notify any connected shared-live-chat clients.
    if was_active:
        try:
            # 1) Force clients to exit live-chat mode cleanly.
            await _livechat_broadcast(
                event_ref,
                {"type": "session_ended", "eventRef": event_ref, "ts": time.time()},
            )

            # 2) Also emit a visible system line into the chat history/UI.
            sys_msg: Dict[str, Any] = {
                "type": "chat",
                "eventRef": event_ref,
                "text": "Host ended the live stream.",
                "clientMsgId": str(uuid.uuid4()),
                "ts": time.time(),
                "senderId": "",
                "senderRole": "system",
                "name": "System",
            }
            _livechat_push_history(event_ref, sys_msg)
            await run_in_threadpool(_livechat_db_insert_sync, event_ref, sys_msg)
            await _livechat_broadcast(event_ref, sys_msg)
        except Exception:
            pass

    return {
        "ok": True,
        "status": "stopped",
        "isHost": True,
        "canStop": True,
        "sessionActive": False,
        "eventRef": event_ref,
        "message": "",
    }


# =============================================================================
# Jitsi Conference (one-on-one) session control
#
# The front-end embeds Jitsi Meet (External API) when session_active=1 AND
# session_kind == "conference". Viewers never call /start (host-only).
# =============================================================================

class JitsiConferenceStartRequest(BaseModel):
  brand: str
  avatar: str
  memberId: str = ""
  displayName: str = ""


class JitsiConferenceStopRequest(BaseModel):
  brand: str
  avatar: str
  memberId: str = ""


@app.post("/conference/jitsi/start")
async def jitsi_conference_start(req: JitsiConferenceStartRequest):
  resolved_brand = (req.brand or "").strip()
  resolved_avatar = (req.avatar or "").strip()
  if not resolved_brand or not resolved_avatar:
    raise HTTPException(status_code=400, detail="brand and avatar are required.")

  mapping = _lookup_companion_mapping(resolved_brand, resolved_avatar)
  if not mapping:
    raise HTTPException(status_code=404, detail="Unknown brand/avatar mapping.")

  host_member_id = str(mapping.get("host_member_id") or "").strip()
  caller_member_id = str(req.memberId or "").strip()

  if not host_member_id or caller_member_id != host_member_id:
    raise HTTPException(status_code=403, detail="Only the host can start the conference.")

  # Stable, per-companion room name (shared across sessions)
  room = _sanitize_room_token(f"{resolved_brand}-{resolved_avatar}")

  # Persist state for multi-worker viewers
  _set_session_kind_room_best_effort(resolved_brand, resolved_avatar, kind="conference", room=room)
  _set_session_active(resolved_brand, resolved_avatar, True, event_ref=None)

  return {"ok": True, "sessionActive": True, "sessionKind": "conference", "sessionRoom": room}


@app.post("/conference/jitsi/stop")
async def jitsi_conference_stop(req: JitsiConferenceStopRequest):
  resolved_brand = (req.brand or "").strip()
  resolved_avatar = (req.avatar or "").strip()
  if not resolved_brand or not resolved_avatar:
    raise HTTPException(status_code=400, detail="brand and avatar are required.")

  mapping = _lookup_companion_mapping(resolved_brand, resolved_avatar)
  if not mapping:
    raise HTTPException(status_code=404, detail="Unknown brand/avatar mapping.")

  host_member_id = str(mapping.get("host_member_id") or "").strip()
  caller_member_id = str(req.memberId or "").strip()

  if not host_member_id or caller_member_id != host_member_id:
    raise HTTPException(status_code=403, detail="Only the host can stop the conference.")

  _set_session_active(resolved_brand, resolved_avatar, False, event_ref=None)
  # Clear kind/room so next Play click re-prompts host
  _set_session_kind_room_best_effort(resolved_brand, resolved_avatar, kind="", room="")

  return {"ok": True, "sessionActive": False, "sessionKind": "", "sessionRoom": ""}

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
            allowed_seconds = max(0.0, (float(minutes_allowed) * 60.0) + float(purchased_seconds or 0.0))

            # Hard stop: do not allow overage. Clamp used_seconds to allowed_seconds.
            if used_seconds > allowed_seconds:
                used_seconds = allowed_seconds

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
    """
    Return True when the user is asking about their remaining chat time/minutes.
    This is intentionally broad because users phrase this many different ways.
    """
    if not text:
        return False
    t = text.strip().lower()

    # Fast exact-ish contains (covers prior phrases)
    needles = [
        "minutes remaining",
        "minutes left",
        "remaining minutes",
        "time remaining",
        "time left",
        "how many minutes",
        "how much time",
        "minutes balance",
        "balance minutes",
        "what is my balance",
        "what's my balance",
        "how many minutes remain",
        "how many minutes are remaining",
        "how many minutes for chat",
        "chat minutes",
        "minutes for chat",
        "how many minutes do i have",
        "how many minutes do i have left",
        "how many minutes do i have remaining",
        "how much time do i have left",
        "how much time do i have remaining",
        "how much time is left",
        "how many minutes are left",
        "minutes used",
        "how many minutes have i used",
        "how much have i used",
        "usage minutes",
    ]
    if any(n in t for n in needles):
        return True

    # Regex fallback: any question containing "minute(s)" + remaining/left/balance/usage
    if re.search(r"\bminute(s)?\b", t) and re.search(r"\b(remain|remaining|left|balance|used|usage)\b", t):
        return True

    # Or "time" + remaining/left/balance (but avoid generic "time" questions)
    if re.search(r"\btime\b", t) and re.search(r"\b(remain|remaining|left|balance|used|usage)\b", t):
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


def _split_camel_case_words(s: str) -> str:
    """Insert spaces in CamelCase identifiers to improve pronunciation (e.g., DulceMoon -> Dulce Moon)."""
    if not s:
        return s
    if " " in s:
        return s
    s2 = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)
    s2 = re.sub(r"(?<=[A-Za-z])(?=[0-9])", " ", s2)
    s2 = re.sub(r"(?<=[0-9])(?=[A-Za-z])", " ", s2)
    return s2


def _apply_phonetic_word_boundary(text: str, target: str, phonetic: str) -> str:
    """Case-insensitive replace of target as a standalone token (no alnum adjacent)."""
    if not text or not target or not phonetic:
        return text
    pattern = re.compile(rf"(?i)(?<![A-Za-z0-9]){re.escape(target)}(?![A-Za-z0-9])")
    return pattern.sub(phonetic, text)


def _normalize_tts_text(
    text: str,
    *,
    brand: str,
    avatar: str,
    mapping_phonetic: str,
    brand_phonetic: str | None = None,
) -> str:
    """
    Normalize text before any TTS generation.

    Goals:
    - Avoid speaking raw URLs (common in paywall / upgrade messages) which can cause awkward
      pronunciations like "DulceMoon" being read from "dulcemoon.net".
    - Expand CamelCase brand strings ("DulceMoon" -> "Dulce Moon") when they appear in text.
    - Apply companion phonetic pronunciation consistently (e.g., Dulce -> "DOOL-seh").
    """
    if not text:
        return ""

    s = str(text)

    # 0) Replace markdown links: [Label](https://...) => "Label"
    s = re.sub(r"\[([^\]]+)\]\((https?://[^\)]+)\)", r"\1", s)

    # 1) Replace bare URLs with a neutral token so we don't speak domains/paths.
    #    (This is the main fix for paywall pronunciation issues.)
    s = re.sub(r"https?://\S+", " link ", s, flags=re.IGNORECASE)

    # 2) Replace www.* links without scheme.
    s = re.sub(r"\bwww\.[^\s]+\b", " link ", s, flags=re.IGNORECASE)

    # Collapse whitespace early.
    s = re.sub(r"\s+", " ", s).strip()

    # 3) Brand normalization (CamelCase -> spaced) so phonetics can match word boundaries.
    brand = (brand or "").strip()
    if brand:
        spaced_brand = _split_camel_case_words(brand)
        if spaced_brand != brand:
            # Replace literal brand occurrences (case-insensitive)
            s = re.sub(re.escape(brand), spaced_brand, s, flags=re.IGNORECASE)

        # Also handle compact brand tokens (punctuation-delimited), e.g. "dulcemoon" in text.
        brand_compact = re.sub(r"[^A-Za-z0-9]", "", brand)
        if brand_compact:
            spaced_compact = _split_camel_case_words(brand_compact)
            token_pat = re.compile(
                rf"(?i)(?<![A-Za-z0-9]){re.escape(brand_compact)}(?![A-Za-z0-9])"
            )
            s = token_pat.sub(spaced_compact, s)

    # 4) Apply phonetic pronunciation for the companion name.
    avatar = (avatar or "").strip()
    mapping_phonetic = (mapping_phonetic or "").strip()
    if avatar and mapping_phonetic:
        # Handle CamelCase concatenations (e.g., "DulceMoon") by inserting a space.
        s = re.sub(
            rf"(?i)(?<![A-Za-z0-9]){re.escape(avatar)}(?=[A-Z])",
            mapping_phonetic + " ",
            s,
        )
        # Word-boundary replacement (normal case)
        s = _apply_phonetic_word_boundary(s, avatar, mapping_phonetic)

    # 5) Optional brand phonetic (future-proof; not currently required).
    brand_phonetic = (brand_phonetic or "").strip()
    if brand and brand_phonetic:
        s = _apply_phonetic_word_boundary(s, brand, brand_phonetic)

    # Final cleanup
    s = re.sub(r"\s+", " ", s).strip()
    return s

def _tts_audio_url_sync(session_id: str, voice_id: str, text: str, brand: str = "", avatar: str = "") -> str:
    text = (text or "").strip()

    # Pronunciation normalization (runs before caching / audio generation).
    # - Splits CamelCase brand tokens (e.g., DulceMoon -> Dulce Moon)
    # - Applies companion phonetic name (DB mapping) at token boundaries
    try:
        if brand:
            phon = ""
            if avatar:
                m = _lookup_companion_mapping(brand, avatar) or {}
                phon = (m.get("phonetic") or "").strip()
            text = _normalize_tts_text(text, brand=brand, avatar=avatar, phonetic=phon)
    except Exception:
        # Never fail TTS due to normalization
        pass
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
# FILE UPLOADS (Azure Blob)
# ----------------------------
#
# Requirements:
# - Uploads are NOT allowed during Shared Live (BeeStreamed) sessions.
# - The frontend uploads raw bytes (no multipart) to avoid python-multipart dependency.
# - We return a read-only SAS URL so the sender/receiver can open the attachment.
# - Container name: "uploads" (override via UPLOADS_CONTAINER env var).
# - Currently supports image/* uploads (rendered as image previews in the UI).
# ----------------------------

_UPLOADS_CONTAINER = (os.getenv("UPLOADS_CONTAINER", "uploads") or "uploads").strip() or "uploads"
_UPLOAD_MAX_BYTES = int(os.getenv("UPLOAD_MAX_BYTES", "10485760") or 10485760)  # 10 MB
_UPLOAD_SAS_DAYS = int(os.getenv("UPLOAD_SAS_DAYS", "30") or 30)  # SAS validity for attachments


def _slugify_segment(s: str, *, default: str = "x") -> str:
    s = (s or "").strip().lower()
    if not s:
        return default
    # Keep alnum, dash, underscore; collapse whitespace to dashes
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"[^a-z0-9\-_]", "", s)
    s = s.strip("-_")
    return s[:64] or default


def _safe_filename(name: str) -> str:
    n = (name or "").strip()
    if not n:
        return "upload"
    # Only keep the basename and strip dangerous characters.
    n = os.path.basename(n)
    n = re.sub(r"[\r\n\t]+", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    # Avoid extremely long filenames
    return n[:120] or "upload"


def _infer_upload_ext(content_type: str, filename: str) -> str:
    """Infer a safe file extension for uploads.

    Preference order:
    1) Extension from the original filename (if safe)
    2) Extension guessed from the MIME content type
    3) Fallback to .bin

    Always returns a non-empty extension starting with ".".
    """
    fn = (filename or "").strip()
    if fn and "." in fn:
        ext = ("." + fn.rsplit(".", 1)[-1]).lower()
        if len(ext) <= 12 and re.fullmatch(r"\.[a-z0-9]+", ext):
            if ext in (".jpeg", ".jpe"):
                return ".jpg"
            return ext

    ct = (content_type or "").split(";", 1)[0].strip().lower()
    if ct:
        guessed = mimetypes.guess_extension(ct) or ""
        guessed = guessed.lower().strip()
        if guessed:
            if guessed in (".jpeg", ".jpe"):
                return ".jpg"
            return guessed

    return ".bin"


def _infer_image_ext(content_type: str, filename: str) -> str:
    """Backward-compatible alias (historically image-only)."""
    ext = _infer_upload_ext(content_type, filename)
    # Historical default for unknown images was .png; keep that behavior for image/*.
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    if ext == ".bin" and ct.startswith("image/"):
        return ".png"
    return ext

def _azure_upload_bytes_and_get_sas_url(
    *, container_name: str, blob_name: str, content_type: str, data: bytes
) -> str:
    from azure.storage.blob import BlobServiceClient, ContentSettings  # type: ignore
    from azure.storage.blob import BlobSasPermissions, generate_blob_sas  # type: ignore

    storage_conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "").strip()
    if not storage_conn_str:
        raise RuntimeError("AZURE_STORAGE_CONNECTION_STRING is not configured")

    blob_service = BlobServiceClient.from_connection_string(storage_conn_str)
    container_client = blob_service.get_container_client(container_name)

    # Ensure container exists (best-effort).
    try:
        container_client.get_container_properties()
    except Exception:
        try:
            container_client.create_container()
        except Exception:
            pass

    blob_client = container_client.get_blob_client(blob_name)
    blob_client.upload_blob(
        data,
        overwrite=True,
        content_settings=ContentSettings(content_type=(content_type or "application/octet-stream")),
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

    expiry = datetime.utcnow() + timedelta(days=max(1, min(_UPLOAD_SAS_DAYS, 365)))
    sas = generate_blob_sas(
        account_name=account_name,
        container_name=container_name,
        blob_name=blob_name,
        account_key=account_key,
        permission=BlobSasPermissions(read=True),
        expiry=expiry,
    )
    return f"{blob_client.url}?{sas}"


@app.post("/files/upload")
async def files_upload(request: Request) -> Dict[str, Any]:
    """Upload a file and return a read-only SAS URL.

    Client contract (no multipart):
      - Body: raw bytes
      - Headers:
          Content-Type: MIME type (e.g. image/png, application/pdf, etc.)
          X-Filename: original file name
          X-Brand: brand (company) name (for gating against session_active)
          X-Avatar: avatar name (for gating against session_active)
          X-Member-Id: optional member id (for blob path organization)

    Notes:
      - Attachments are **not allowed** during Shared Live (session_active=1).
      - This endpoint intentionally avoids multipart to keep dependencies minimal.
    """
    filename = _safe_filename(request.headers.get("x-filename") or request.headers.get("X-Filename") or "")
    brand = (request.headers.get("x-brand") or request.headers.get("X-Brand") or "").strip()
    avatar = (request.headers.get("x-avatar") or request.headers.get("X-Avatar") or "").strip()
    member_id = (request.headers.get("x-member-id") or request.headers.get("X-Member-Id") or "").strip()
    content_type = (request.headers.get("content-type") or "application/octet-stream").strip()

    if not brand or not avatar:
        raise HTTPException(status_code=400, detail="X-Brand and X-Avatar headers are required")

    # Hard rule: no attachments during shared live streaming.
    if _is_session_active(brand, avatar):
        raise HTTPException(status_code=403, detail="Attachments are disabled during shared live streaming")

    # Only images for now (required by UI preview behavior).

    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload body")
    if len(data) > int(_UPLOAD_MAX_BYTES):
        raise HTTPException(status_code=413, detail=f"Upload too large (max {_UPLOAD_MAX_BYTES} bytes)")

    ext = _infer_upload_ext(content_type, filename)
    blob_name = (
        f"{_slugify_segment(brand, default='core')}/"
        f"{_slugify_segment(avatar, default='companion')}/"
        f"{_slugify_segment(member_id, default='anon')}/"
        f"{uuid.uuid4().hex}{ext}"
    )

    try:
        url = await run_in_threadpool(
            _azure_upload_bytes_and_get_sas_url,
            container_name=_UPLOADS_CONTAINER,
            blob_name=blob_name,
            content_type=content_type,
            data=data,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {type(e).__name__}: {e}")

    return {
        "ok": True,
        "url": url,
        "name": filename,
        "size": len(data),
        "contentType": content_type,
        "container": _UPLOADS_CONTAINER,
        "blobName": blob_name,
    }

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
                    audio_url = await run_in_threadpool(_tts_audio_url_sync, session_id, voice_id, reply, session_state.get("brand", ""), session_state.get("avatar", ""))
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

            brand = (body.get("brand") or "").strip()

            avatar = (body.get("avatar") or "").strip()

            audio_url = await run_in_threadpool(_tts_audio_url_sync, session_id, voice_id, text, brand, avatar)
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

# =============================================================================
# LiveKit (replaces BeeStreamed + Jitsi for stream + conference)
#
# Supports:
# - Persistent roomName per (brand, avatar) (stored in the existing event_ref column when present)
# - Host-controlled start/stop via API (start sets session_active + session_kind + room)
# - Pattern A lobby: viewers create join_request; host admits/denies; token issued on admit
# - Recording / broadcast prep via LiveKit Egress (optional; requires storage env vars)
#
# Environment:
#   NEXT_PUBLIC_LIVEKIT_URL (frontend)
#   LIVEKIT_URL (backend, e.g. https://<project>.livekit.cloud)
#   LIVEKIT_API_KEY / LIVEKIT_API_SECRET
#
# Optional (HLS segments to S3-compatible storage):
#   LIVEKIT_S3_BUCKET
#   LIVEKIT_S3_ACCESS_KEY
#   LIVEKIT_S3_SECRET
#   LIVEKIT_S3_REGION
#   LIVEKIT_S3_ENDPOINT (optional)
#   LIVEKIT_S3_FORCE_PATH_STYLE ("1"|"0", optional)
#   LIVEKIT_HLS_PUBLIC_BASE_URL (public base for serving playlists; e.g. https://cdn.example.com/livekit)
# =============================================================================

try:
    import jwt  # PyJWT
except Exception:  # pragma: no cover
    jwt = None  # type: ignore

_LIVEKIT_JOIN_LOCK = threading.Lock()
# requestId -> request dict
_LIVEKIT_JOIN_REQUESTS: Dict[str, Dict[str, Any]] = {}
# Track active egress jobs per room so STOP can deterministically end recording/broadcast.
# NOTE: This is in-memory. If you run multiple workers, use a shared store (Redis/DB) for production.
_LIVEKIT_ACTIVE_EGRESS: Dict[str, Dict[str, str]] = {}  # roomName -> {"record": egressId, "hls": egressId}


def _livekit_env(name: str, default: str = "") -> str:
    return (os.getenv(name, default) or "").strip()

def _livekit_http_url() -> str:
    """Base URL for LiveKit *server* APIs (Twirp/egress).

    LiveKit server APIs are HTTPS endpoints. Many deployments accidentally set
    LIVEKIT_URL / NEXT_PUBLIC_LIVEKIT_URL to a websocket URL (wss://...). We
    accept that and normalize it for server-side calls.
    """

    raw = _livekit_env("LIVEKIT_URL", _livekit_env("NEXT_PUBLIC_LIVEKIT_URL", ""))
    url = str(raw).strip().rstrip("/")
    if not url:
        return ""

    # Convert websocket scheme -> http(s) for server API calls.
    if url.startswith("wss://"):
        url = "https://" + url[len("wss://") :]
    elif url.startswith("ws://"):
        url = "http://" + url[len("ws://") :]

    # If scheme omitted, assume https.
    if "://" not in url:
        url = "https://" + url

    return url


def _livekit_client_ws_url() -> str:
    """Base URL for LiveKit *client* signaling (Room.connect).

    LiveKit JS expects a websocket URL (ws:// or wss://). If the configured URL
    is https://..., convert it to wss://... for the browser.
    """

    raw = _livekit_env("NEXT_PUBLIC_LIVEKIT_URL", _livekit_env("LIVEKIT_URL", ""))
    url = str(raw).strip().rstrip("/")
    if not url:
        return ""

    if url.startswith("https://"):
        url = "wss://" + url[len("https://") :]
    elif url.startswith("http://"):
        url = "ws://" + url[len("http://") :]

    if "://" not in url:
        url = "wss://" + url

    return url

def _livekit_api_key() -> str:
    return _livekit_env("LIVEKIT_API_KEY")

def _livekit_api_secret() -> str:
    return _livekit_env("LIVEKIT_API_SECRET")

def _livekit_twirp_headers() -> Dict[str, str]:
    # LiveKit server API auth is also JWT-based, but for simplicity we sign with API secret in bearer token.
    # Twirp endpoints accept "Authorization: Bearer <jwt>" with claim "video": {"roomCreate":true, ...} for service tokens.
    # In practice, LiveKit server SDKs use a "service token". We implement minimal bearer token here.
    if jwt is None:
        raise HTTPException(status_code=500, detail="PyJWT is required for LiveKit integration (pip install PyJWT).")
    key = _livekit_api_key()
    secret = _livekit_api_secret()
    if not key or not secret:
        raise HTTPException(status_code=500, detail="LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not configured")

    now = int(time.time())
    payload = {
        "iss": key,
        "sub": "service",
        "nbf": now - 5,
        "exp": now + 60,
        "video": {"roomCreate": True, "roomList": True, "roomRecord": True, "roomAdmin": True},
    }
    token = jwt.encode(payload, secret, algorithm="HS256")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

def _livekit_participant_token(room: str, identity: str, name: str, *, can_publish: bool, can_subscribe: bool, room_admin: bool=False) -> str:
    if jwt is None:
        raise HTTPException(status_code=500, detail="PyJWT is required for LiveKit integration (pip install PyJWT).")
    key = _livekit_api_key()
    secret = _livekit_api_secret()
    if not key or not secret:
        raise HTTPException(status_code=500, detail="LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not configured")

    now = int(time.time())
    video_grant: Dict[str, Any] = {
        "room": room,
        "roomJoin": True,
        "canPublish": bool(can_publish),
        "canSubscribe": bool(can_subscribe),
        "canPublishData": bool(can_publish),
    }
    if room_admin:
        video_grant["roomAdmin"] = True

    payload = {
        "iss": key,
        "sub": identity,
        "name": name or identity,
        "nbf": now - 5,
        "exp": now + 60 * 60,  # 1 hour
        "video": video_grant,
        "metadata": "",
    }
    return jwt.encode(payload, secret, algorithm="HS256")

def _twirp_post_json(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    import requests  # type: ignore
    base = _livekit_http_url()
    if not base:
        raise HTTPException(status_code=500, detail="LIVEKIT_URL is not configured")
    url = f"{base}{path}"
    try:
        r = requests.post(url, headers=_livekit_twirp_headers(), json=payload, timeout=20)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LiveKit API call failed: {e!r}")
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=f"LiveKit API error {r.status_code}: {(r.text or '')[:500]}")
    try:
        return r.json()
    except Exception:
        return {"raw": (r.text or "").strip()}

def _livekit_room_name_for_companion(brand: str, avatar: str) -> str:
    # Reuse your existing stable token helper for rooms.
    return _sanitize_room_token(f"{(brand or '').strip()}-{(avatar or '').strip()}")

def _livekit_storage_s3_config() -> Optional[Dict[str, Any]]:
    bucket = _livekit_env("LIVEKIT_S3_BUCKET")
    access_key = _livekit_env("LIVEKIT_S3_ACCESS_KEY")
    secret = _livekit_env("LIVEKIT_S3_SECRET")
    region = _livekit_env("LIVEKIT_S3_REGION")
    endpoint = _livekit_env("LIVEKIT_S3_ENDPOINT")
    force_path = _livekit_env("LIVEKIT_S3_FORCE_PATH_STYLE", "1")
    if not bucket or not access_key or not secret:
        return None
    cfg: Dict[str, Any] = {
        "access_key": access_key,
        "secret": secret,
        "bucket": bucket,
        "region": region,
        "force_path_style": str(force_path).strip() in ("1", "true", "True", "yes", "YES"),
    }
    if endpoint:
        cfg["endpoint"] = endpoint
    return cfg


def _livekit_storage_azure_config() -> Optional[Dict[str, Any]]:
    account_name = _livekit_env("LIVEKIT_AZURE_ACCOUNT_NAME")
    account_key = _livekit_env("LIVEKIT_AZURE_ACCOUNT_KEY")
    container_name = _livekit_env("LIVEKIT_AZURE_CONTAINER_NAME")
    if not (account_name and account_key and container_name):
        return None
    return {"account_name": account_name, "account_key": account_key, "container_name": container_name}

def _livekit_start_recording_egress(room_name: str) -> Dict[str, Any]:
    """
    Start an MP4 room-composite recording using LiveKit Egress.

    Storage options:
      - Azure Blob: set LIVEKIT_AZURE_ACCOUNT_NAME/KEY/CONTAINER_NAME
      - S3: set LIVEKIT_S3_* (same as HLS)
    Optional:
      - LIVEKIT_RECORDING_PUBLIC_BASE_URL (if you serve recordings via CDN/public URL)
    """
    azure = _livekit_storage_azure_config()
    s3 = _livekit_storage_s3_config()
    if not azure and not s3:
        return {"ok": False, "error": "Recording storage env not configured (LIVEKIT_AZURE_* or LIVEKIT_S3_*)"}

    ts = int(time.time())
    # Do not include file extension in directory portion; LiveKit will store the file at this key/path.
    filepath = f"recordings/{room_name}/{ts}.mp4"

    out: Dict[str, Any] = {"filepath": filepath}
    if azure:
        out["azure"] = azure
    else:
        out["s3"] = s3

    req = {
        "room_name": room_name,
        "layout": "grid",
        "preset": "H264_720P_30",
        "audio_only": False,
        "file_outputs": [out],
    }
    info = _twirp_post_json("/twirp/livekit.Egress/StartRoomCompositeEgress", req)

    pub_base = _livekit_env("LIVEKIT_RECORDING_PUBLIC_BASE_URL").rstrip("/")
    recording_url = f"{pub_base}/{filepath}" if pub_base else ""
    return {"ok": True, "egress": info, "recordingUrl": recording_url, "filepath": filepath}

def _livekit_stop_egress(egress_id: str) -> None:
    if not egress_id:
        return
    try:
        _twirp_post_json("/twirp/livekit.Egress/StopEgress", {"egress_id": egress_id})
    except Exception:
        # Best-effort; stopping a non-existent/ended egress should not break STOP.
        pass

def _livekit_kick_all(room_name: str) -> None:
    try:
        resp = _twirp_post_json("/twirp/livekit.RoomService/ListParticipants", {"room": room_name})
        parts = resp.get("participants") or []
        for p in parts:
            ident = str(p.get("identity") or "").strip()
            if not ident:
                continue
            try:
                _twirp_post_json("/twirp/livekit.RoomService/RemoveParticipant", {"room": room_name, "identity": ident})
            except Exception:
                continue
    except Exception:
        return

def _livekit_start_hls_egress(room_name: str) -> Dict[str, Any]:
    s3 = _livekit_storage_s3_config()
    if not s3:
        return {"ok": False, "error": "S3 storage env not configured for HLS egress"}

    # Use a predictable prefix so the playback URL is reusable.
    prefix = f"hls/{room_name}"
    playlist = "playlist.m3u8"
    live_playlist = "live.m3u8"

    req = {
        "room_name": room_name,
        "layout": "grid",
        "preset": "H264_720P_30",
        "audio_only": False,
        "segment_outputs": [
            {
                "filename_prefix": prefix,
                "playlist_name": playlist,
                "live_playlist_name": live_playlist,
                "segment_duration": 2,
                "s3": s3,
            }
        ],
    }
    info = _twirp_post_json("/twirp/livekit.Egress/StartRoomCompositeEgress", req)
    base = _livekit_env("LIVEKIT_HLS_PUBLIC_BASE_URL").rstrip("/")
    hls_url = f"{base}/{prefix}/{live_playlist}" if base else ""
    return {"ok": True, "egress": info, "hlsUrl": hls_url, "prefix": prefix, "livePlaylist": live_playlist}

class LiveKitStartEmbedRequest(BaseModel):
    brand: str
    avatar: str
    memberId: str = ""
    displayName: str = ""
    embedDomain: str = ""

@app.post("/stream/livekit/start_embed")
async def livekit_stream_start_embed(req: LiveKitStartEmbedRequest):
    """
    Start or join a LiveKit 'stream' session (host-controlled).
    - Host gets an immediate token.
    - Viewer gets roomName + canStart=false and must go through join_request/admit.
    """
    resolved_brand = (req.brand or "").strip()
    resolved_avatar = (req.avatar or "").strip()
    if not resolved_brand or not resolved_avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required.")

    mapping = _lookup_companion_mapping(resolved_brand, resolved_avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="Unknown brand/avatar mapping.")

    host_member_id = str(mapping.get("host_member_id") or "").strip()
    caller_member_id = str(req.memberId or "").strip()


    is_host = bool(host_member_id) and bool(caller_member_id) and (host_member_id.lower() == caller_member_id.lower())

    # Stable room (reuse event_ref storage)
    session_kind, session_room = _read_session_kind_room(resolved_brand, resolved_avatar)
    session_kind = (session_kind or "").strip()
    session_room = (session_room or "").strip()
    hls_url = ""
    room = session_room or (_read_event_ref_from_db(resolved_brand, resolved_avatar) or "").strip() or _livekit_room_name_for_companion(resolved_brand, resolved_avatar)
    if not _read_event_ref_from_db(resolved_brand, resolved_avatar):
        _set_session_active(resolved_brand, resolved_avatar, bool(_is_session_active(resolved_brand, resolved_avatar)), event_ref=room)

    session_active = bool(_is_session_active(resolved_brand, resolved_avatar))
    if is_host:
        # Start session and persist session state.
        _set_session_kind_room_best_effort(resolved_brand, resolved_avatar, kind="stream", room=room)
        _set_session_active(resolved_brand, resolved_avatar, True, event_ref=room)
        _set_livekit_fields_best_effort(resolved_brand, resolved_avatar, room_name=room, last_started_at_ms=int(time.time()*1000))

        # Clear prior live-chat transcript when starting a *new* stream session.
        # (Avoid clearing on host refresh while the session is already active.)
        if (not session_active) or (session_kind != "stream"):
            try:
                _livechat_db_clear_event_sync(room)
            except Exception:
                pass

        # Optionally start HLS egress immediately on host start.
        try:
            autohls = str(_livekit_env("LIVEKIT_AUTO_HLS", "0")).strip().lower() in ("1", "true", "yes")
            if autohls:
                e = await _livekit_start_hls_egress(room)
                hls_url = (e.get("hlsUrl") or "").strip()
        except Exception:
            pass


        token = _livekit_participant_token(
            room,
            identity=f"host:{caller_member_id or 'host'}",
            name=resolved_avatar or "Host",
            can_publish=True,
            can_subscribe=True,
            room_admin=True,
        )
        return {
            "ok": True,
            "canStart": True,
            "role": "host",
            "room": room,
            "roomName": room,
            "sessionRoom": room,
            "sessionActive": True,
            "sessionKind": "stream",
            "hostMemberId": host_member_id,
            # LiveKit JS expects ws(s):// for signaling.
            "serverUrl": _livekit_client_ws_url(),
            "token": token,
            "hlsUrl": hls_url,
        }

    # Viewer: issue a subscribe-only token automatically for livestreams (no approval).
    viewer_token = ""
    if session_active and session_kind == "stream" and room:
        viewer_identity = f"viewer:{caller_member_id}" if caller_member_id else f"viewer:{uuid.uuid4().hex[:10]}"
        viewer_name = (req.displayName or "").strip() or "Viewer"
        viewer_token = _livekit_participant_token(
            room,
            identity=viewer_identity,
            name=viewer_name,
            can_publish=False,
            can_subscribe=True,
            room_admin=False,
        )
    return {
        "ok": True,
        "canStart": False,
        "role": "viewer",
        "room": room,
        "roomName": room,
        "sessionRoom": room,
        "sessionActive": session_active,
        "sessionKind": session_kind,
        "hostMemberId": host_member_id,
        "serverUrl": _livekit_client_ws_url(),
        "token": viewer_token,
        "hlsUrl": hls_url if session_active else "",
    }


@app.get("/stream/livekit/status")
def livekit_stream_status(brand: str = "", avatar: str = "", memberId: str = "") -> Dict[str, Any]:
    """Lightweight stream status for the Companion page.

    IMPORTANT: This endpoint **does not** mint tokens.
    """

    resolved_brand = (brand or "").strip()
    resolved_avatar = (avatar or "").strip()
    if not resolved_brand or not resolved_avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required")

    session_kind, session_room = _read_session_kind_room(resolved_brand, resolved_avatar)
    session_kind = (session_kind or "").strip()
    session_room = (session_room or "").strip()

    session_kind_lower = (session_kind or "").strip().lower()

    # Treat both Stream and Private Conference as "active" for the companion status API.
    # (Front-end needs to know the session is live in order to join the correct room.)
    is_active = bool(session_room) and (session_kind_lower in ("stream", "conference")) and bool(
        _is_session_active(resolved_brand, resolved_avatar)
    )

    mapping = _lookup_companion_mapping(resolved_brand, resolved_avatar) or {}
    host_member_id = str(mapping.get("host_member_id") or "").strip()
    resolved_member_id = str(memberId or "").strip()
    can_start = bool(resolved_member_id and host_member_id and (resolved_member_id == host_member_id))
    hls_url = str(mapping.get("livekit_hls_url") or "").strip() or str(mapping.get("hls_url") or "").strip()

    return {
        "ok": True,
        "sessionActive": bool(is_active),
        "sessionKind": session_kind_lower or session_kind,
        "roomName": session_room,
        "sessionRoom": session_room,
        "room": session_room,
        # Frontend historically uses streamEventRef for its livechat websocket.
        "streamEventRef": session_room,
        "hostMemberId": host_member_id,
        "canStart": bool(can_start),
        "hlsUrl": hls_url,
        "serverUrl": _livekit_client_ws_url(),
    }


@app.post("/stream/livekit/join")
def livekit_stream_join(body: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    """Issue a **viewer** token for an active stream."""

    brand = str(body.get("brand") or body.get("companionName") or "").strip()
    avatar = str(body.get("avatar") or "").strip()
    member_id = str(body.get("memberId") or "").strip()
    username = str(body.get("username") or body.get("displayName") or "").strip()

    if not brand or not avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required")

    session_kind, session_room = _read_session_kind_room(brand, avatar)
    session_kind = (session_kind or "").strip()
    session_room = (session_room or "").strip()

    if not (session_kind.lower() == "stream" and session_room and bool(_is_session_active(brand, avatar))):
        return {
            "ok": True,
            "sessionActive": False,
            "sessionKind": session_kind,
            "roomName": session_room,
            "role": "viewer",
            "serverUrl": _livekit_client_ws_url(),
        }

    display_name = username or f"Viewer-{uuid.uuid4().hex[:4]}"
    identity = member_id or f"viewer_{uuid.uuid4().hex[:12]}"

    token = _livekit_participant_token(
        session_room,
        identity=identity,
        name=display_name,
        can_publish=False,
        can_subscribe=True,
        room_admin=False,
    )

    return {
        "ok": True,
        "sessionActive": True,
        "sessionKind": "stream",
        "role": "viewer",
        "roomName": session_room,
        "token": token,
        "serverUrl": _livekit_client_ws_url(),
    }


class LiveKitStartBroadcastRequest(BaseModel):
    brand: str
    avatar: str
    memberId: str = ""
    embedDomain: str = ""

@app.post("/stream/livekit/start_broadcast")
async def livekit_stream_start_broadcast(req: LiveKitStartBroadcastRequest):
    """Host-only: start the reusable LiveKit broadcast session and return a host token.

    This endpoint is designed for your existing "Broadcast" host button.
    It:
      - sets sessionActive=true and sessionKind='stream'
      - starts recording egress (MP4) if storage is configured
      - starts HLS egress (optional) if LIVEKIT_AUTO_HLS=1 and storage is configured
      - returns {roomName, token, hlsUrl}
    """
    resolved_brand = (req.brand or "").strip()
    resolved_avatar = (req.avatar or "").strip()
    if not resolved_brand or not resolved_avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required.")

    mapping = _lookup_companion_mapping(resolved_brand, resolved_avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="Unknown brand/avatar mapping.")

    host_member_id = str(mapping.get("host_member_id") or "").strip()
    caller_member_id = str(req.memberId or "").strip()
    is_host = bool(host_member_id) and bool(caller_member_id) and (host_member_id.lower() == caller_member_id.lower())
    if not is_host:
        return {"ok": True, "isHost": False}

    room = (_read_event_ref_from_db(resolved_brand, resolved_avatar) or "").strip() or _livekit_room_name_for_companion(resolved_brand, resolved_avatar)
    if not _read_event_ref_from_db(resolved_brand, resolved_avatar):
        _set_session_active(resolved_brand, resolved_avatar, bool(_is_session_active(resolved_brand, resolved_avatar)), event_ref=room)

    _set_session_kind_room_best_effort(resolved_brand, resolved_avatar, kind="stream", room=room)
    _set_session_active(resolved_brand, resolved_avatar, True, event_ref=room)
    _set_livekit_fields_best_effort(resolved_brand, resolved_avatar, room_name=room, last_started_at_ms=int(time.time()*1000))

    # Start/ensure egress jobs (best-effort). Store ids for deterministic stop.
    hls_url = ""
    with _LIVEKIT_JOIN_LOCK:
        _LIVEKIT_ACTIVE_EGRESS.setdefault(room, {})

    if _livekit_env("LIVEKIT_RECORDING_ENABLED", "1") in ("1", "true", "True", "yes", "YES"):
        try:
            rec = _livekit_start_recording_egress(room)
            if rec.get("ok"):
                egress_id = str((rec.get("egress") or {}).get("egress_id") or (rec.get("egress") or {}).get("egressId") or "").strip()
                if egress_id:
                    with _LIVEKIT_JOIN_LOCK:
                        _LIVEKIT_ACTIVE_EGRESS[room]["record"] = egress_id
                    _set_livekit_fields_best_effort(resolved_brand, resolved_avatar, record_egress_id=egress_id)
        except Exception:
            pass

    if _livekit_env("LIVEKIT_AUTO_HLS", "0") in ("1", "true", "True", "yes", "YES"):
        try:
            e = _livekit_start_hls_egress(room)
            if e.get("ok"):
                hls_url = str(e.get("hlsUrl") or "")
                hls_egress_id = str((e.get("egress") or {}).get("egress_id") or (e.get("egress") or {}).get("egressId") or "").strip()
                if hls_egress_id:
                    with _LIVEKIT_JOIN_LOCK:
                        _LIVEKIT_ACTIVE_EGRESS[room]["hls"] = hls_egress_id
                    _set_livekit_fields_best_effort(resolved_brand, resolved_avatar, hls_egress_id=hls_egress_id, hls_url=hls_url)
        except Exception:
            pass

    token = _livekit_participant_token(
        room,
        identity=f"host:{caller_member_id or 'host'}",
        name="Host",
        can_publish=True,
        can_subscribe=True,
        room_admin=True,
    )
    return {
        "ok": True,
        "isHost": True,
        "roomName": room,
        "token": token,
        "hlsUrl": hls_url,
        "sessionActive": True,
        "serverUrl": _livekit_client_ws_url(),
    }


class LiveKitStopRequest(BaseModel):
    brand: str
    avatar: str
    memberId: str = ""

@app.post("/stream/livekit/stop")
async def livekit_stream_stop(req: LiveKitStopRequest):
    resolved_brand = (req.brand or "").strip()
    resolved_avatar = (req.avatar or "").strip()
    if not resolved_brand or not resolved_avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required.")

    mapping = _lookup_companion_mapping(resolved_brand, resolved_avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="Unknown brand/avatar mapping.")

    host_member_id = str(mapping.get("host_member_id") or "").strip()
    caller_member_id = str(req.memberId or "").strip()
    if not host_member_id or caller_member_id != host_member_id:
        return {"ok": True, "status": "not_host", "sessionActive": bool(_is_session_active(resolved_brand, resolved_avatar))}

    room = (_read_event_ref_from_db(resolved_brand, resolved_avatar) or "").strip() or _livekit_room_name_for_companion(resolved_brand, resolved_avatar)

    # Stop any active egress jobs (recording/HLS) and kick participants to force-end the session.
    with _LIVEKIT_JOIN_LOCK:
        e = dict(_LIVEKIT_ACTIVE_EGRESS.get(room) or {})
        _LIVEKIT_ACTIVE_EGRESS.pop(room, None)

    _livekit_stop_egress(str(e.get("record") or ""))
    _livekit_stop_egress(str(e.get("hls") or ""))
    _livekit_kick_all(room)

    # Reset session state in DB.
    _set_session_active(resolved_brand, resolved_avatar, False, event_ref=None)
    _set_session_kind_room_best_effort(resolved_brand, resolved_avatar, kind="", room="")

    # Clear any pending join requests for this companion
    with _LIVEKIT_JOIN_LOCK:
        to_del = [rid for rid, r in _LIVEKIT_JOIN_REQUESTS.items() if (r.get("brand")==resolved_brand and r.get("avatar")==resolved_avatar)]
        for rid in to_del:
            _LIVEKIT_JOIN_REQUESTS.pop(rid, None)

    return {"ok": True, "status": "stopped", "sessionActive": False}


# ---- Conference session control (same room, different kind flag) -----------------

class LiveKitConferenceStartRequest(BaseModel):
    brand: str
    avatar: str
    memberId: str = ""
    displayName: str = ""

class LiveKitConferenceStopRequest(BaseModel):
    brand: str
    avatar: str
    memberId: str = ""

@app.post("/conference/livekit/start")
async def livekit_conference_start(req: LiveKitConferenceStartRequest):
    resolved_brand = (req.brand or "").strip()
    resolved_avatar = (req.avatar or "").strip()
    if not resolved_brand or not resolved_avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required.")

    mapping = _lookup_companion_mapping(resolved_brand, resolved_avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="Unknown brand/avatar mapping.")

    host_member_id = str(mapping.get("host_member_id") or "").strip()
    caller_member_id = str(req.memberId or "").strip()

    if not host_member_id or caller_member_id != host_member_id:
        raise HTTPException(status_code=403, detail="Only the host can start the conference.")

    # Determine whether a conference is already active (used to decide whether
    # we should clear prior live-chat transcript).
    prev_kind, prev_room = _read_session_kind_room(resolved_brand, resolved_avatar)
    prev_kind = (prev_kind or "").strip()
    prev_room = (prev_room or "").strip()
    prev_active = bool(prev_room) and bool(_is_session_active(resolved_brand, resolved_avatar))

    room = (_read_event_ref_from_db(resolved_brand, resolved_avatar) or "").strip() or _livekit_room_name_for_companion(resolved_brand, resolved_avatar)
    if not _read_event_ref_from_db(resolved_brand, resolved_avatar):
        _set_session_active(resolved_brand, resolved_avatar, bool(_is_session_active(resolved_brand, resolved_avatar)), event_ref=room)

    _set_session_kind_room_best_effort(resolved_brand, resolved_avatar, kind="conference", room=room)
    _set_session_active(resolved_brand, resolved_avatar, True, event_ref=room)

    # Always start a host-entered private conference with a clean live-chat transcript.
    # (The room name is stable across sessions, so without this you'll see old message history.)
    try:
        _livechat_db_clear_event_sync(room)
    except Exception:
        pass

    token = _livekit_participant_token(
        room,
        identity=f"host:{caller_member_id or 'host'}",
        name=str(req.displayName or resolved_avatar or "Host").strip() or "Host",
        can_publish=True,
        can_subscribe=True,
        room_admin=True,
    )

    return {
        "ok": True,
        "sessionActive": True,
        "sessionKind": "conference",
        "sessionRoom": room,
        "token": token,
        "serverUrl": _livekit_client_ws_url(),
    }

@app.post("/conference/livekit/stop")
async def livekit_conference_stop(req: LiveKitConferenceStopRequest):
    resolved_brand = (req.brand or "").strip()
    resolved_avatar = (req.avatar or "").strip()
    if not resolved_brand or not resolved_avatar:
        raise HTTPException(status_code=400, detail="brand and avatar are required.")

    mapping = _lookup_companion_mapping(resolved_brand, resolved_avatar)
    if not mapping:
        raise HTTPException(status_code=404, detail="Unknown brand/avatar mapping.")

    host_member_id = str(mapping.get("host_member_id") or "").strip()
    caller_member_id = str(req.memberId or "").strip()
    if not host_member_id or caller_member_id != host_member_id:
        raise HTTPException(status_code=403, detail="Only the host can stop the conference.")

    _set_session_active(resolved_brand, resolved_avatar, False, event_ref=None)
    _set_session_kind_room_best_effort(resolved_brand, resolved_avatar, kind="", room="")

    # Clear pending join requests
    with _LIVEKIT_JOIN_LOCK:
        to_del = [rid for rid, r in _LIVEKIT_JOIN_REQUESTS.items() if (r.get("brand")==resolved_brand and r.get("avatar")==resolved_avatar)]
        for rid in to_del:
            _LIVEKIT_JOIN_REQUESTS.pop(rid, None)

    return {"ok": True, "sessionActive": False, "sessionKind": "", "sessionRoom": ""}

# ---- Pattern A Lobby ------------------------------------------------------------

class LiveKitJoinRequestCreate(BaseModel):
    brand: str
    avatar: str
    memberId: str
    name: str = ""
    roomName: str = ""

@app.post("/livekit/join_request")
async def livekit_join_request(req: LiveKitJoinRequestCreate):
    b = (req.brand or "").strip()
    a = (req.avatar or "").strip()
    if not b or not a:
        raise HTTPException(status_code=400, detail="brand and avatar are required")
    rid = str(uuid.uuid4())

    member_id = (req.memberId or "").strip()
    # LiveKit identity convention (must match what we mint into the token on admit):
    #   - user:<memberId> when memberId is available
    #   - user:<rid> otherwise
    identity = f"user:{member_id}" if member_id else f"user:{rid}"

    # Requirement: if the viewer/attendee does not enter a name, use a LiveKit system identifier.
    name = (req.name or "").strip()[:64] or identity

    with _LIVEKIT_JOIN_LOCK:
        _LIVEKIT_JOIN_REQUESTS[rid] = {
            "requestId": rid,
            "brand": b,
            "avatar": a,
            "roomName": (req.roomName or "").strip() or _livekit_room_name_for_companion(b, a),
            "memberId": member_id,
            "identity": identity,
            "name": name,
            "status": "PENDING",
            "createdAt": int(time.time()),
            "token": "",
        }
    return {"ok": True, "requestId": rid, "status": "PENDING"}

@app.get("/livekit/join_requests")
async def livekit_join_requests(brand: str, avatar: str):
    b = (brand or "").strip()
    a = (avatar or "").strip()
    with _LIVEKIT_JOIN_LOCK:
        reqs = [r for r in _LIVEKIT_JOIN_REQUESTS.values() if r.get("brand")==b and r.get("avatar")==a and r.get("status")=="PENDING"]
    # Most recent first
    reqs.sort(key=lambda r: int(r.get("createdAt") or 0), reverse=True)
    return {"ok": True, "requests": reqs[:50]}

class LiveKitJoinDecision(BaseModel):
    requestId: str
    brand: str = ""
    avatar: str = ""
    memberId: str = ""

@app.post("/livekit/admit")
async def livekit_admit(req: LiveKitJoinDecision):
    rid = (req.requestId or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="requestId is required")

    # Host authorization (use brand/avatar of the request if not provided)
    with _LIVEKIT_JOIN_LOCK:
        r = _LIVEKIT_JOIN_REQUESTS.get(rid)
    if not r:
        raise HTTPException(status_code=404, detail="join request not found")

    b = (r.get("brand") or req.brand or "").strip()
    a = (r.get("avatar") or req.avatar or "").strip()
    mapping = _lookup_companion_mapping(b, a)
    if not mapping:
        raise HTTPException(status_code=404, detail="Unknown brand/avatar mapping.")

    host_member_id = str(mapping.get("host_member_id") or "").strip()
    caller_member_id = str(req.memberId or "").strip()
    if not host_member_id or caller_member_id != host_member_id:
        raise HTTPException(status_code=403, detail="Only host can admit participants.")

    room = str(r.get("roomName") or "").strip() or _livekit_room_name_for_companion(b, a)
    identity = f"user:{str(r.get('memberId') or '').strip() or rid}"
    name = str(r.get("name") or "").strip() or "Guest"

    # IMPORTANT: Do NOT rely on _lookup_companion_mapping() for session_kind.
    # That mapping is loaded once at startup; session_kind/session_room are updated in SQLite
    # via _set_session_kind_room_best_effort(). For conference, viewers must be allowed to publish.
    db_kind, _db_room = _read_session_kind_room(b, a)
    session_kind = (db_kind or str(mapping.get("session_kind") or "")).strip().lower()
    if session_kind not in ("conference", "stream"):
        session_kind = "stream"
    can_publish = session_kind == "conference"
    token = _livekit_participant_token(room, identity=identity, name=name, can_publish=can_publish, can_subscribe=True)

    with _LIVEKIT_JOIN_LOCK:
        rr = _LIVEKIT_JOIN_REQUESTS.get(rid)
        if rr:
            rr["status"] = "ADMITTED"
            rr["token"] = token
            rr["decidedAt"] = int(time.time())

    return {"ok": True, "status": "ADMITTED"}

@app.post("/livekit/deny")
async def livekit_deny(req: LiveKitJoinDecision):
    rid = (req.requestId or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="requestId is required")

    with _LIVEKIT_JOIN_LOCK:
        r = _LIVEKIT_JOIN_REQUESTS.get(rid)
    if not r:
        raise HTTPException(status_code=404, detail="join request not found")

    b = (r.get("brand") or req.brand or "").strip()
    a = (r.get("avatar") or req.avatar or "").strip()
    mapping = _lookup_companion_mapping(b, a)
    if not mapping:
        raise HTTPException(status_code=404, detail="Unknown brand/avatar mapping.")

    host_member_id = str(mapping.get("host_member_id") or "").strip()
    caller_member_id = str(req.memberId or "").strip()
    if not host_member_id or caller_member_id != host_member_id:
        raise HTTPException(status_code=403, detail="Only host can deny participants.")

    with _LIVEKIT_JOIN_LOCK:
        rr = _LIVEKIT_JOIN_REQUESTS.get(rid)
        if rr:
            rr["status"] = "DENIED"
            rr["token"] = ""
            rr["decidedAt"] = int(time.time())

    return {"ok": True, "status": "DENIED"}

@app.get("/livekit/join_request_status")
async def livekit_join_request_status(requestId: str):
    rid = (requestId or "").strip()
    with _LIVEKIT_JOIN_LOCK:
        r = _LIVEKIT_JOIN_REQUESTS.get(rid)
    if not r:
        return {"ok": True, "status": "MISSING", "serverUrl": _livekit_client_ws_url()}

    # Derive the current session kind from the authoritative SQLite mapping table.
    # (The in-memory mapping cache may be stale.)
    b = (r.get("brand") or "").strip()
    a = (r.get("avatar") or "").strip()
    db_kind, _db_room = _read_session_kind_room(b, a)
    return {
        "ok": True,
        "status": r.get("status"),
        "token": r.get("token") or "",
        "serverUrl": _livekit_client_ws_url(),
        "roomName": r.get("roomName") or r.get("room") or "",
        "sessionKind": (db_kind or r.get("session_kind") or ""),
        "identity": r.get("identity") or "",
        "name": r.get("name") or "",
        "displayName": r.get("name") or "",
        "memberId": r.get("memberId") or "",
    }
