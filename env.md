# Elaralo Drop-in (Frontend + Backend)

This package contains:
- `next-frontend/` (Next.js 14 app router)
- `backend/` (FastAPI API server)
- `app.py` (root wrapper for Azure App Service startup command compatibility)
- `requirements.txt` (root requirements that references `backend/requirements.txt`)

## Key Behavior

- Single companion persona: **Elara**
- Plan label is displayed to the right of the avatar (e.g., **Plan: Trial**)
- Mode pills are **only shown** if allowed by the plan (no disabled pills)
- If an incoming mode is **"trial"**, it is mapped to **Romantic**
- If no mode is provided, it defaults to **Friend**
- Video Mode embeds a conference/stream URL (no avatar synthesis vendors)
- TTS in Video Mode uses **browser speech synthesis** (no ElevenLabs in Video Mode)
- Audio TTS uses ElevenLabs voice id: `rJ9XoWu8gbUhVKZnKY8X`
- STT uses backend transcription (requires OpenAI API key)

## Local Run (optional)

Backend:
```bash
cd backend
python -m venv .venv
# activate venv
pip install -r requirements.txt
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Frontend:
```bash
cd next-frontend
npm install
npm run dev
```

Set `NEXT_PUBLIC_API_BASE=http://localhost:8000`

## Azure Notes

- Backend startup command (App Service):
  - `gunicorn app:app -w 4 -k uvicorn.workers.UvicornWorker`

- Required App Settings:
  - `OPENAI_API_KEY`
  - `ELEVENLABS_API_KEY`
  - Optional: `CORS_ORIGINS`, `ELEVENLABS_VOICE_ID`, `NEXT_PUBLIC_VIDEO_MODE_URL`
