\
from __future__ import annotations

import base64
import os
import time
from typing import Any, Dict, List, Literal, Optional

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore


# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

DEFAULT_OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
DEFAULT_ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "rJ9XoWu8gbUhVKZnKY8X")
DEFAULT_ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")

CORS_ALLOW_ORIGINS = os.getenv("CORS_ALLOW_ORIGINS", "*")
if CORS_ALLOW_ORIGINS.strip() == "*":
    _cors_origins = ["*"]
else:
    _cors_origins = [o.strip() for o in CORS_ALLOW_ORIGINS.split(",") if o.strip()]


# -----------------------------------------------------------------------------
# App
# -----------------------------------------------------------------------------

app = FastAPI(title="Elaralo API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -----------------------------------------------------------------------------
# Models
# -----------------------------------------------------------------------------

Role = Literal["system", "user", "assistant"]


class ChatMessage(BaseModel):
    role: Role
    content: str


class SessionState(BaseModel):
    # Companion/session routing
    companion_key: Optional[str] = None

    # Display/brand
    companion_name: str = "Elara"

    # Membership gating
    plan_name: str = "Trial"  # default per product requirement
    mode: str = "friend"

    # Safety toggle: this should be set earlier in your flow if you support adult content
    explicit_allowed: bool = False

    # Optional user identity (if included in the companion_key on the frontend)
    member_id: Optional[str] = None


class ChatRequest(BaseModel):
    session_id: str = Field(..., description="Client-generated session id (uuid recommended).")
    message: str = Field(..., description="The user's message.")
    history: List[ChatMessage] = Field(default_factory=list, description="Prior conversation turns.")
    companion_key: Optional[str] = Field(default=None, description="Opaque companion key forwarded from frontend.")
    session_state: Optional[SessionState] = Field(default=None, description="Normalized state derived from companion_key.")


class ChatResponse(BaseModel):
    reply: str
    mode: str
    plan_name: str
    session_id: str


class TtsRequest(BaseModel):
    session_id: str
    text: str
    companion_key: Optional[str] = None
    voice_id: Optional[str] = None


class TtsResponse(BaseModel):
    audio_url: str  # data:audio/mpeg;base64,...
    voice_id: str


# -----------------------------------------------------------------------------
# Normalization helpers (defense in depth)
# -----------------------------------------------------------------------------

def _norm(s: Optional[str]) -> str:
    return (s or "").strip()


def normalize_plan_name(plan_name: Optional[str]) -> str:
    p = _norm(plan_name).lower()
    if p in {"", "none", "null"}:
        return "Trial"

    if p in {"trial", "free"}:
        return "Trial"
    if p in {"friend", "basic"}:
        return "Friend"
    if p in {"romantic", "romance"}:
        return "Romantic"
    if p in {"intimate", "adult"}:
        return "Intimate"
    if p in {"pro", "premium", "plus"}:
        return "Pro"

    # Unknown -> Trial (per requirement)
    return "Trial"


def normalize_mode(mode: Optional[str]) -> str:
    m = _norm(mode).lower()
    if m in {"", "none", "null"}:
        return "friend"
    if m in {"friend", "friendly", "companion"}:
        return "friend"
    if m in {"romantic", "romance", "flirty"}:
        return "romantic"
    if m in {"trial"}:
        # Legacy mapping: Trial pill -> Romantic pill
        return "romantic"
    if m in {"intimate", "adult"}:
        return "intimate"
    return "friend"


def allowed_modes_for_plan(plan_name: str, explicit_allowed: bool) -> List[str]:
    plan = normalize_plan_name(plan_name)
    modes = ["friend"]

    if plan in {"Trial", "Romantic", "Pro"}:
        modes.append("romantic")

    # Intimate is only enabled if explicit_allowed is true.
    # (Consent/age verification should happen before companion access, per requirement.)
    if plan in {"Intimate", "Pro"} and explicit_allowed:
        modes.append("intimate")

    # De-dup while preserving order
    seen = set()
    out: List[str] = []
    for x in modes:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


# -----------------------------------------------------------------------------
# Prompting
# -----------------------------------------------------------------------------

SYSTEM_PROMPT_BASE = """\
You are Elara, the Elaralo companion.
You are warm, attentive, and conversational. You are not a therapist or medical professional.
You must not claim real-world actions you did not perform. You must not fabricate account status, payments, or identity.

Conversation goals:
- Keep responses helpful, succinct, and natural.
- Ask a single, targeted question when you need more context.
- Maintain continuity with the session history.
"""

STYLE_FRIEND = """\
Relationship style: Friend
- Tone: supportive, respectful, and platonic.
- Do not be sexually explicit.
"""

STYLE_ROMANTIC = """\
Relationship style: Romantic
- Tone: affectionate, playful, flirty, but keep it non-explicit (PG-13).
- Avoid explicit sexual content.
"""

STYLE_INTIMATE = """\
Relationship style: Intimate
- Tone: consensual, adult, and sexually explicit only if the user requests it and explicit_allowed is true.
- If explicit_allowed is false, refuse explicit sexual content and steer to non-explicit conversation.
"""

def build_system_prompt(state: SessionState) -> str:
    plan_name = normalize_plan_name(state.plan_name)
    mode = normalize_mode(state.mode)
    allowed = allowed_modes_for_plan(plan_name, state.explicit_allowed)

    # If the mode is not allowed, snap to the first allowed mode.
    if mode not in allowed:
        mode = allowed[0] if allowed else "friend"

    if mode == "romantic":
        style = STYLE_ROMANTIC
    elif mode == "intimate":
        style = STYLE_INTIMATE
    else:
        style = STYLE_FRIEND

    header = f"Companion name: {state.companion_name}\nPlan: {plan_name}\nMode: {mode}\nExplicitAllowed: {state.explicit_allowed}"
    return "\n".join([header, SYSTEM_PROMPT_BASE, style]).strip()


# -----------------------------------------------------------------------------
# OpenAI client
# -----------------------------------------------------------------------------

def get_openai_client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set on the backend.")
    if OpenAI is None:
        raise HTTPException(status_code=500, detail="openai package is not installed.")
    return OpenAI(api_key=api_key)


# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------

@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": "elaralo-backend", "ts": int(time.time())}


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    state = req.session_state or SessionState()

    # Normalize with defense-in-depth fallbacks
    state.companion_key = req.companion_key or state.companion_key
    state.plan_name = normalize_plan_name(state.plan_name)
    state.mode = normalize_mode(state.mode)

    # Enforce plan gating
    allowed = allowed_modes_for_plan(state.plan_name, state.explicit_allowed)
    if state.mode not in allowed:
        state.mode = allowed[0] if allowed else "friend"

    system_prompt = build_system_prompt(state)

    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]

    # Keep a bounded history to control token usage
    history = req.history[-24:] if req.history else []
    for m in history:
        if m.role in {"user", "assistant"} and m.content:
            messages.append({"role": m.role, "content": m.content})

    messages.append({"role": "user", "content": req.message})

    try:
        client = get_openai_client()
        resp = client.chat.completions.create(
            model=DEFAULT_OPENAI_MODEL,
            messages=messages,
            temperature=0.7,
        )
        reply = (resp.choices[0].message.content or "").strip()
        if not reply:
            reply = "I’m here. What would you like to talk about next?"
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Chat failed: {type(e).__name__}: {e}")

    return ChatResponse(
        reply=reply,
        mode=state.mode,
        plan_name=state.plan_name,
        session_id=req.session_id,
    )


@app.post("/tts/audio-url", response_model=TtsResponse)
def tts_audio_url(req: TtsRequest) -> TtsResponse:
    eleven_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not eleven_key:
        raise HTTPException(status_code=500, detail="ELEVENLABS_API_KEY is not set on the backend.")

    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Missing text.")

    voice_id = (req.voice_id or DEFAULT_ELEVENLABS_VOICE_ID).strip()
    model_id = DEFAULT_ELEVENLABS_MODEL_ID

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {
        "xi-api-key": eleven_key,
        "accept": "audio/mpeg",
        "content-type": "application/json",
    }

    body = {
        "text": text,
        "model_id": model_id,
        "voice_settings": {
            "stability": 0.45,
            "similarity_boost": 0.8,
            "style": 0.35,
            "use_speaker_boost": True,
        },
    }

    try:
        r = requests.post(url, headers=headers, json=body, timeout=60)
        if r.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"ElevenLabs error: {r.status_code} {r.text[:500]}",
            )
        audio_bytes = r.content
        b64 = base64.b64encode(audio_bytes).decode("utf-8")
        data_url = f"data:audio/mpeg;base64,{b64}"
        return TtsResponse(audio_url=data_url, voice_id=voice_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS failed: {type(e).__name__}: {e}")


# -----------------------------------------------------------------------------
# Optional STT endpoint (kept for parity with the original baseline)
# -----------------------------------------------------------------------------

class SttRequest(BaseModel):
    audio_base64: str
    filename: str = "audio.webm"
    mimetype: str = "audio/webm"


class SttResponse(BaseModel):
    text: str


@app.post("/stt/transcribe", response_model=SttResponse)
def stt_transcribe(req: SttRequest) -> SttResponse:
    """
    Optional server-side STT (not required if you use browser speech recognition).
    Kept for parity with the original baseline.

    Expects base64-encoded audio bytes.
    """
    if OpenAI is None:
        raise HTTPException(status_code=500, detail="openai package is not installed.")

    audio_b64 = (req.audio_base64 or "").strip()
    if not audio_b64:
        raise HTTPException(status_code=400, detail="Missing audio_base64.")

    try:
        audio_bytes = base64.b64decode(audio_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 audio.")

    try:
        client = get_openai_client()
        # The OpenAI SDK expects a file-like object with a name attribute.
        import io

        f = io.BytesIO(audio_bytes)
        f.name = req.filename  # type: ignore[attr-defined]

        tr = client.audio.transcriptions.create(
            model="whisper-1",
            file=f,
        )
        text = getattr(tr, "text", "") or ""
        return SttResponse(text=text)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STT failed: {type(e).__name__}: {e}")
