# Elaralo Drop-in Bundle (v4)

This folder contains drop-in files for:

- `next-frontend/` (Next.js App Router UI)
- `backend/` (FastAPI API for chat + ElevenLabs TTS)

## What changed vs previous bundle (elaralo_dropin_pro.zip)

- `next-frontend/app/companion/page.tsx`
  - Mode pills are **not condensed** (always visible under **Set Mode**).
  - Modes shown are **only those allowed by the member plan** (no disabled pills).
  - **Default plan is Trial** when missing from the companion key.
  - **Audio Mode uses a hidden `<video>` element** for stable audio playback.
  - D‑ID integration is kept **commented out** (future use).

- `next-frontend/app/page.tsx`
  - Fixed Next.js App Router requirements by marking as a **Client Component**.
  - Re-confirmed branding: **Elaralo / Elara** (no legacy product naming).

- `backend/app.py`
  - Fixed prompt assembly and normalization logic.
  - Defaults updated: plan -> **Trial** (when missing), mode -> **friend**.
  - ElevenLabs voice id remains configurable via `ELEVENLABS_VOICE_ID` (defaults included).

- `backend/requirements.txt`
  - Updated minimum versions to reduce dependency conflicts (requests/openai/pydantic).

## Local run

Backend:
```bash
cd backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
# set OPENAI_API_KEY + ELEVENLABS_API_KEY
uvicorn app:app --reload --port 8000
```

Frontend:
```bash
cd next-frontend
npm install
npm run dev
```

Set:
- `NEXT_PUBLIC_ELARALO_API_BASE=http://127.0.0.1:8000`
in `next-frontend/.env.local` (create if missing).

## Production

- Ensure backend App Service has:
  - `OPENAI_API_KEY`
  - `ELEVENLABS_API_KEY`
  - (optional) `ELEVENLABS_VOICE_ID`
  - (optional) `CORS_ALLOW_ORIGINS` set to your frontend URL(s)

- Ensure frontend has:
  - `NEXT_PUBLIC_ELARALO_API_BASE=https://<your-backend-app>.azurewebsites.net`
