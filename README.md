# StillWithYou

StillWithYou is an AI-powered emotional communication assistant that starts as a lightweight chat skeleton and grows into a richer conversational experience.

## Requirements

- Node.js 18+ and npm
- Python 3.11+

## Setup

Run the backend and the frontend in two separate terminals. The frontend calls the
backend at `http://localhost:8000`, so both need to be running for the chat to work.

### Backend

The API must be started from inside the `backend/` directory, because
`app.main:app` and the `.env` lookup are both relative to it.

**Windows (PowerShell):**

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload --port 8000
```

**macOS / Linux (bash or zsh):**

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

The API will be available at <http://localhost:8000>, with interactive docs at
<http://localhost:8000/docs>.

Copying `.env` is optional — `app/core/config.py` defaults match `.env.example`,
so the server runs without it.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The app will be available at <http://localhost:5173>. Type a message and press Enter
(or click Send): the bubble is added immediately and a `POST /ping` request is sent
to the backend, with the response logged to the browser console.

To produce a production build instead:

```bash
cd frontend
npm run build
```

## Verifying the backend

With the API running:

```bash
curl http://localhost:8000/health
# {"status":"ok"}

curl -X POST http://localhost:8000/ping \
  -H "Content-Type: application/json" \
  -d '{"text":"hello"}'
# {"echo":"hello","received_at":"2026-07-27T12:01:24.422274+00:00"}
```

On Windows PowerShell, use `Invoke-RestMethod` instead:

```powershell
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod http://localhost:8000/ping -Method Post `
  -ContentType 'application/json' -Body '{"text":"hello"}'
```

## Configuration

Backend settings are read from environment variables or `backend/.env` by
`app/core/config.py`. See `backend/.env.example` for the full list. The most
relevant one is `CORS_ORIGINS`, a comma-separated list of browser origins allowed
to call the API — it defaults to the Vite dev server at `http://localhost:5173`.

## Project layout

```text
backend/app
  main.py            app creation + router registration only
  core/config.py     pydantic-settings Settings, reads .env
  routers/health.py  GET  /health
  routers/chat.py    POST /ping
  schemas/message.py Pydantic request/response models

frontend/src
  components/        ChatWindow, MessageBubble, MessageInput
  hooks/useChat.ts   message state + send logic
  api/client.ts      typed API calls
  types/message.ts   shared Message type
```

## Phases

- Phase 1: chat skeleton
  - React + TypeScript chat UI
  - FastAPI ping endpoint
  - CORS and basic project structure
- Phase 1 continued: persistence and AI integration
  - Postgres persistence
  - Gemini API calls
  - Redis/ARQ queue and real-time updates
  - multi-language support
