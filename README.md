# StillWithYou

StillWithYou is an AI-powered emotional communication assistant that starts as a lightweight chat skeleton and grows into a richer conversational experience.

## Requirements

- Node.js 18+ and npm
- Python 3.11+
- Docker (Postgres, Redis and Prometheus run in `docker-compose.yml`)

## Documentation

- [docs/progress.md](docs/progress.md) — current state, measured numbers, and every
  gotcha worth not rediscovering. **Start here.**
- [docs/phase2-slo.md](docs/phase2-slo.md) — the reliability target and failure modes.
- [docs/phase2-runbook.md](docs/phase2-runbook.md) — what to check when something breaks.

## Setup

### Services

Bring up Postgres, Redis and Prometheus first — the API and the worker both need
them:

```bash
docker compose up -d
```

### Backend

The API and the ARQ worker are two processes. The API accepts and stores messages;
the worker analyses them. Messages are still saved if the worker is down — they
just stay `analysis_status: pending` until one runs.

The API must be started from inside the `backend/` directory, because
`app.main:app` and the `.env` lookup are both relative to it.

**Windows (PowerShell):**

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env   # then add your GEMINI_API_KEY
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

In a second terminal, with the same venv activated:

```powershell
cd backend
.venv\Scripts\Activate.ps1
arq app.worker.WorkerSettings
```

**macOS / Linux (bash or zsh):**

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then add your GEMINI_API_KEY
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

In a second terminal, with the same venv activated:

```bash
cd backend
source .venv/bin/activate
arq app.worker.WorkerSettings
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

# Send a message. Returns immediately with analysis_status "pending" —
# Gemini is never called on the request path.
curl -X POST http://localhost:8000/messages \
  -H "Content-Type: application/json" \
  -d '{"content":"you never listen to me"}'

# Poll for the analysis using the id from above.
curl http://localhost:8000/messages/<id>/analysis
# {"analysis_status":"complete","analysis_source":"local_fallback","mood":"angry",...}

# Metrics
curl http://localhost:8000/metrics
```

`analysis_source` tells you which engine produced the scores: `gemini` for a
full-fidelity result, `local_fallback` when the circuit breaker was open.

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
  main.py                     app creation + router registration
  worker.py                   ARQ worker: analyze_message_job
  core/config.py              pydantic-settings Settings, reads .env
  core/db.py                  async SQLAlchemy engine + session
  core/logging.py             structured JSON logging
  core/queue.py               ARQ pool
  core/redis.py               shared Redis client
  core/metrics.py             Prometheus counters (kept in Redis)
  models/message.py           messages table
  services/gemini.py          analyze_message() + key rotation
  services/circuit_breaker.py CLOSED/OPEN/HALF_OPEN, Redis + Lua
  services/local_fallback.py  lexicon analyzer used when Gemini is down
  services/cache.py           content-hash result cache
  routers/health.py           GET  /health
  routers/chat.py             POST /messages, GET /messages/{id}/analysis
  routers/metrics.py          GET  /metrics
  schemas/                    Pydantic request/response models
backend/tests                 failure-injection suite

frontend/src
  components/        ChatWindow, MessageBubble, MessageInput
  hooks/useChat.ts   message state + send logic
  api/client.ts      typed API calls
  types/message.ts   shared Message type
```

## Phases

- **Phase 1 — chat skeleton** ✅
  - React + TypeScript chat UI, FastAPI, CORS, project structure
- **Phase 1 backfill — persistence and AI** ✅
  - Postgres + Alembic, `messages` table, Gemini `analyze_message()`, `POST /messages`
- **Phase 2 — resilience layer** ✅
  - Analysis moved off the request path into an ARQ job (POST returns in ~40ms)
  - Redis-backed circuit breaker (CLOSED/OPEN/HALF_OPEN), shared across workers
  - Local lexicon fallback so analysis never depends on Gemini being up
  - Content-hash result cache, structured JSON logging, Prometheus `/metrics`
  - Failure-injection test suite
- **Phase 3 — later**
  - Rendering mood/toxicity in the UI, avatar, multi-language support
