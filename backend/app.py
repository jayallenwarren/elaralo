import os
import uuid
import json
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from openai import OpenAI


# --------------------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------------------

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_DEFAULT_VOICE_ID = os.getenv("ELEVENLABS_DEFAULT_VOICE_ID", "rJ9XoWu8gbUhVKZnKY8X")

CORS_ALLOW_ORIGINS = os.getenv(
    "CORS_ALLOW_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000",
)

STATIC_DIR = Path(__file__).parent / "static"
TTS_DIR = STATIC_DIR / "tts"
SUMMARY_DIR = STATIC_DIR / "summaries"

for d in [STATIC_DIR, TTS_DIR, SUMMARY_DIR]:
    d.mkdir(parents=True, exist_ok=True)

client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None


def _parse_origins(raw: str) -> List[str]:
    origins: List[str] = []
    for part in (raw or "").split(","):
        s = part.strip()
        if s:
            origins.append(s)
    return origins or ["*"]


# --------------------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage] = Field(default_factory=list)
    session_state: Dict[str, Any] = Field(default_factory=dict)


class ChatResponse(BaseModel):
    reply: str


class SaveSummaryRequest(BaseModel):
    messages: List[ChatMessage] = Field(default_factory=list)
    session_state: Dict[str, Any] = Field(default_factory=dict)


class SaveSummaryResponse(BaseModel):
    summary: str
    summary_url: str


class TtsRequest(BaseModel):
    text: str
    voice_id: Optional[str] = None
    session_state: Dict[str, Any] = Field(default_factory=dict)


class TtsResponse(BaseModel):
    audio_url: str


# --------------------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------------------

app = FastAPI(title="Elaralo API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_origins(CORS_ALLOW_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


def _system_prompt(companion_name: str, mode: str) -> str:
    mode_l = (mode or "Friend").strip().lower()
    if mode_l == "romantic":
        tone = (
            "You are warm, affectionate, and lightly playful. "
            "You keep content non-explicit and within a PG-13 romantic tone."
        )
    elif mode_l == "intimate":
        # Explicit consent is expected to be handled before the companion page is accessed.
        tone = (
            "You are affectionate and intimate. "
            "You must remain compliant with all safety constraints and avoid disallowed content."
        )
    else:
        tone = (
            "You are friendly, supportive, and conversational. "
            "You keep a helpful, respectful tone."
        )

    return (
        f"You are {companion_name}, a conversational companion.\n"
        f"Mode: {mode}.\n"
        f"{tone}\n"
        "Keep replies concise unless the user asks for more detail."
    )


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    if client is None:
        return ChatResponse(reply="Server is missing OPENAI_API_KEY.")

    companion = req.session_state.get("companion") or {}
    companion_name = str(companion.get("name") or "Elara")
    mode = str(req.session_state.get("mode") or companion.get("mode") or "Friend")

    openai_messages: List[Dict[str, str]] = [{"role": "system", "content": _system_prompt(companion_name, mode)}]

    for m in req.messages:
        role = m.role if m.role in ("user", "assistant") else "user"
        openai_messages.append({"role": role, "content": m.content})

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=openai_messages,
        temperature=0.7,
    )

    reply = (resp.choices[0].message.content or "").strip()
    if not reply:
        reply = "…"
    return ChatResponse(reply=reply)


@app.post("/chat/save-summary", response_model=SaveSummaryResponse)
def save_summary(req: SaveSummaryRequest) -> SaveSummaryResponse:
    if client is None:
        summary = "Server is missing OPENAI_API_KEY."
        filename = f"summary_{uuid.uuid4().hex}.txt"
        out_path = SUMMARY_DIR / filename
        out_path.write_text(summary, encoding="utf-8")
        return SaveSummaryResponse(summary=summary, summary_url=f"/static/summaries/{filename}")

    # Build a plain transcript.
    lines: List[str] = []
    for m in req.messages:
        role = "User" if m.role == "user" else "Assistant"
        lines.append(f"{role}: {m.content}")
    transcript = "\n".join(lines)

    prompt = (
        "Summarize the following conversation in 1-2 short paragraphs. "
        "Then provide 3 bullet takeaways.\n\n"
        f"{transcript}"
    )

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.4,
    )

    summary = (resp.choices[0].message.content or "").strip()
    if not summary:
        summary = "(no summary returned)"

    filename = f"summary_{uuid.uuid4().hex}.txt"
    out_path = SUMMARY_DIR / filename
    out_path.write_text(summary, encoding="utf-8")

    return SaveSummaryResponse(summary=summary, summary_url=f"/static/summaries/{filename}")


def _elevenlabs_tts_bytes(text: str, voice_id: str) -> bytes:
    if not ELEVENLABS_API_KEY:
        raise RuntimeError("Missing ELEVENLABS_API_KEY")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "accept": "audio/mpeg",
        "content-type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {
            "stability": 0.45,
            "similarity_boost": 0.85,
            "style": 0.15,
            "use_speaker_boost": True,
        },
    }

    r = requests.post(url, headers=headers, data=json.dumps(payload), timeout=60)
    if r.status_code >= 300:
        raise RuntimeError(f"ElevenLabs error {r.status_code}: {r.text[:200]}")
    return r.content


@app.post("/tts/audio-url", response_model=TtsResponse)
def tts_audio_url(req: TtsRequest) -> TtsResponse:
    voice_id = (req.voice_id or "").strip() or ELEVENLABS_DEFAULT_VOICE_ID
    audio_bytes = _elevenlabs_tts_bytes(req.text, voice_id)

    filename = f"tts_{uuid.uuid4().hex}.mp3"
    out_path = TTS_DIR / filename
    out_path.write_bytes(audio_bytes)

    return TtsResponse(audio_url=f"/static/tts/{filename}")


@app.post("/stt/transcribe")
async def stt_transcribe(file: UploadFile = File(...)) -> Dict[str, str]:
    if client is None:
        return {"text": ""}

    audio_bytes = await file.read()
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        with open(tmp_path, "rb") as f:
            transcription = client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
            )
        text = (getattr(transcription, "text", "") or "").strip()
        return {"text": text}
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
