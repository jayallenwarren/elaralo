import os
import time
import uuid
from io import BytesIO
from typing import Any, Dict, List, Literal, Optional, Tuple

import requests
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

try:
    # Optional dependency; only required if you want OpenAI-backed chat + STT.
    from openai import OpenAI  # type: ignore
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore


# -----------------------------
# Configuration
# -----------------------------

APP_NAME = "elaralo-api"

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()  # safe default; override in App Settings
OPENAI_TRANSCRIBE_MODEL = os.getenv("OPENAI_TRANSCRIBE_MODEL", "whisper-1").strip()

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2").strip()
DEFAULT_ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "rJ9XoWu8gbUhVKZnKY8X").strip()

# Audio cache on disk (shared across gunicorn workers). Azure App Service: /home is writable & persistent.
TTS_CACHE_DIR = os.getenv("TTS_CACHE_DIR", "/home/elaralo/tts_cache").strip()
TTS_CACHE_TTL_SECONDS = int(os.getenv("TTS_CACHE_TTL_SECONDS", "3600"))  # 1 hour

# CORS
# Comma-separated list. Use "*" only if you understand the implications.
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]


# -----------------------------
# App
# -----------------------------

app = FastAPI(title=APP_NAME)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS if CORS_ORIGINS else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(TTS_CACHE_DIR, exist_ok=True)


# -----------------------------
# Domain Logic
# -----------------------------

PlanName = Literal["Free", "Trial", "Starter", "Plus", "Pro"]
Mode = Literal["friend", "romantic", "intimate", "video"]


def normalize_mode(raw: Any) -> Mode:
    t = str(raw or "").strip().lower()
    if not t:
        return "friend"
    if t == "trial":  # Trial is a plan label; treat as Romantic mode request
        return "romantic"
    if t in ("friend", "friendly"):
        return "friend"
    if t in ("romantic", "romance"):
        return "romantic"
    if t in ("intimate", "explicit", "adult", "18+", "18"):
        return "intimate"
    if t in ("video", "call", "conference", "stream"):
        return "video"
    return "friend"


def normalize_plan(raw: Any) -> PlanName:
    t = str(raw or "").strip()
    if t in ("Free", "Trial", "Starter", "Plus", "Pro"):
        return t  # type: ignore
    return "Trial"


def allowed_modes_for_plan(plan: PlanName) -> List[Mode]:
    allowed: List[Mode] = ["friend", "video"]
    if plan in ("Trial", "Starter", "Plus", "Pro"):
        allowed.append("romantic")
    if plan in ("Starter", "Plus", "Pro"):
        allowed.append("intimate")
    return allowed


def ensure_allowed_mode(requested: Mode, plan: PlanName) -> Tuple[Mode, bool]:
    allowed = allowed_modes_for_plan(plan)
    if requested in allowed:
        return requested, True
    return "friend", False


def now_ms() -> int:
    return int(time.time() * 1000)


def build_system_prompt(mode: Mode) -> str:
    # IMPORTANT: No mention of any other companion names.
    base = (
        "You are Elara, the Elaralo AI companion. "
        "You are warm, emotionally attuned, and conversational. "
        "You do not mention policy or internal rules unless asked. "
        "You are not a doctor or lawyer; for medical/legal issues, encourage professional help."
    )

    if mode == "friend":
        return base + " Style: supportive friend, calm, practical, lightly playful, non-explicit."
    if mode == "romantic":
        return base + (
            " Style: affectionate, romantic, emotionally intimate, but keep language tasteful and non-graphic."
        )
    if mode == "intimate":
        # Keep this non-graphic; access gating is handled outside this page per product design.
        return base + (
            " Style: sensual and intimate, but avoid graphic sexual content. Focus on feelings, closeness, and flirtation."
        )
    if mode == "video":
        return base + (
            " Style: concise, spoken-friendly replies suitable for a video call. Use short paragraphs and clarity."
        )
    return base


def get_openai_client() -> Optional[Any]:
    if not OPENAI_API_KEY or OpenAI is None:
        return None
    try:
        return OpenAI(api_key=OPENAI_API_KEY)
    except Exception:
        return None


# In-memory chat sessions; you can replace with Redis/DB later.
SESSIONS: Dict[str, Dict[str, Any]] = {}


def session_get(session_id: str) -> Dict[str, Any]:
    s = SESSIONS.get(session_id)
    if not s:
        s = {"created_at_ms": now_ms(), "messages": []}
        SESSIONS[session_id] = s
    return s


def append_history(session_id: str, role: str, content: str) -> None:
    s = session_get(session_id)
    msgs: List[Dict[str, str]] = s["messages"]
    msgs.append({"role": role, "content": content})
    # keep last N
    if len(msgs) > 30:
        del msgs[:-30]


def chat_generate_reply(
    mode: Mode,
    user_text: str,
    session_id: str,
) -> str:
    client = get_openai_client()
    if client is None:
        # Safe fallback (keeps app functional without keys)
        return (
            "Backend is running, but OPENAI_API_KEY is not set. "
            "Set it in Azure App Service → Configuration → Application settings, then restart. "
            f"You said: {user_text}"
        )

    # Build message list with short history.
    s = session_get(session_id)
    history: List[Dict[str, str]] = s.get("messages", [])
    sys = {"role": "system", "content": build_system_prompt(mode)}
    msgs = [sys] + history[-20:] + [{"role": "user", "content": user_text}]

    try:
        resp = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=msgs,
            temperature=0.8 if mode in ("romantic", "intimate") else 0.6,
        )
        out = resp.choices[0].message.content or ""
        return out.strip() or "…"
    except Exception as e:
        return f"Chat error: {str(e)}"


def elevenlabs_tts(text: str, voice_id: str) -> bytes:
    if not ELEVENLABS_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="ELEVENLABS_API_KEY is not set. Add it in Azure App Service → Configuration → Application settings.",
        )

    vid = voice_id.strip() or DEFAULT_ELEVENLABS_VOICE_ID
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{vid}"

    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "accept": "audio/mpeg",
        "content-type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": ELEVENLABS_MODEL_ID,
        "voice_settings": {
            "stability": 0.45,
            "similarity_boost": 0.8,
            "style": 0.2,
            "use_speaker_boost": True,
        },
    }

    r = requests.post(url, headers=headers, json=payload, timeout=60)
    if r.status_code >= 300:
        raise HTTPException(status_code=500, detail=f"ElevenLabs TTS failed: {r.status_code} {r.text[:500]}")
    return r.content


def write_tts_cache(mp3_bytes: bytes) -> str:
    token = uuid.uuid4().hex
    path = os.path.join(TTS_CACHE_DIR, f"{token}.mp3")
    with open(path, "wb") as f:
        f.write(mp3_bytes)
    return token


def read_tts_cache(token: str) -> Optional[str]:
    path = os.path.join(TTS_CACHE_DIR, f"{token}.mp3")
    if not os.path.exists(path):
        return None
    # TTL enforcement
    age = time.time() - os.path.getmtime(path)
    if age > TTS_CACHE_TTL_SECONDS:
        try:
            os.remove(path)
        except Exception:
            pass
        return None
    return path


def openai_transcribe(audio_bytes: bytes, filename: str) -> str:
    client = get_openai_client()
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set; STT requires it.")
    bio = BytesIO(audio_bytes)
    bio.name = filename
    try:
        # OpenAI python SDK supports file-like objects.
        tr = client.audio.transcriptions.create(model=OPENAI_TRANSCRIBE_MODEL, file=bio)
        # SDK returns either a dict-like or an object with `text`.
        text = getattr(tr, "text", None) or (tr.get("text") if isinstance(tr, dict) else None)
        return (text or "").strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STT error: {str(e)}")


# -----------------------------
# Routes
# -----------------------------


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "service": APP_NAME,
        "time_ms": now_ms(),
        "openai_configured": bool(OPENAI_API_KEY),
        "elevenlabs_configured": bool(ELEVENLABS_API_KEY),
    }


@app.post("/tts/audio-url")
async def tts_audio_url(request: Request) -> Dict[str, Any]:
    data = await request.json()
    text = str(data.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Missing 'text'.")

    voice_id = str(data.get("voice_id") or DEFAULT_ELEVENLABS_VOICE_ID).strip() or DEFAULT_ELEVENLABS_VOICE_ID

    mp3 = elevenlabs_tts(text=text, voice_id=voice_id)
    token = write_tts_cache(mp3)

    base = str(request.base_url).rstrip("/")
    return {"audio_url": f"{base}/tts/audio/{token}.mp3"}


@app.get("/tts/audio/{token}.mp3")
def tts_audio(token: str):
    path = read_tts_cache(token)
    if not path:
        raise HTTPException(status_code=404, detail="Audio not found or expired.")
    return FileResponse(path, media_type="audio/mpeg", filename=f"{token}.mp3")


@app.post("/stt/transcribe")
async def stt_transcribe(
    audio: UploadFile = File(...),
    companion_key: str = Form(""),
    member_id: str = Form(""),
    plan: str = Form(""),
) -> Dict[str, Any]:
    # companion_key/member_id/plan are accepted for wiring parity; not strictly required here.
    _ = companion_key, member_id, plan

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio upload.")

    text = openai_transcribe(audio_bytes, audio.filename or "audio.webm")
    return {"text": text}


@app.post("/chat")
async def chat(request: Request) -> JSONResponse:
    body = await request.json()

    user_text = str(body.get("message") or "").strip()
    if not user_text:
        raise HTTPException(status_code=400, detail="Missing 'message'.")

    session_state = body.get("session_state") or {}
    session_id = str(session_state.get("session_id") or body.get("session_id") or "").strip() or uuid.uuid4().hex

    plan = normalize_plan(body.get("plan") or session_state.get("plan"))
    requested_mode = normalize_mode(body.get("mode") or session_state.get("mode"))
    mode, ok = ensure_allowed_mode(requested_mode, plan)

    # Update session meta
    sess = session_get(session_id)
    sess["plan"] = plan
    sess["member_id"] = str(body.get("member_id") or session_state.get("member_id") or "")
    sess["member_email"] = str(body.get("member_email") or session_state.get("member_email") or "")
    sess["companion_key"] = str(body.get("companion_key") or session_state.get("companion_key") or "Elara")

    append_history(session_id, "user", user_text)
    reply = chat_generate_reply(mode=mode, user_text=user_text, session_id=session_id)
    append_history(session_id, "assistant", reply)

    # Time tracking: accept client-reported elapsed seconds
    incoming_elapsed = session_state.get("session_elapsed_seconds")
    if isinstance(incoming_elapsed, (int, float)):
        sess["session_elapsed_seconds"] = float(incoming_elapsed)

    out_state: Dict[str, Any] = {
        "session_id": session_id,
        "plan": plan,
        "mode": mode,
        "mode_allowed": ok,
        "allowed_modes": allowed_modes_for_plan(plan),
        "server_time_ms": now_ms(),
    }

    return JSONResponse({"reply": reply, "session_state": out_state})


@app.post("/chat/save-summary")
async def chat_save_summary(request: Request) -> Dict[str, Any]:
    """
    Optional endpoint: the frontend may call this after sends.
    This implementation is intentionally lightweight (no persistence) but keeps compatibility.
    """
    body = await request.json()
    # Keep compatible fields for future use:
    _ = body.get("companion_key"), body.get("plan"), body.get("member_id"), body.get("session_state"), body.get("messages")
    return {"ok": True}
