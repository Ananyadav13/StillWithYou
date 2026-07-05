# StillWithYou

StillWithYou is an AI-powered emotional communication assistant that starts as a lightweight chat skeleton and grows into a richer conversational experience.

## Setup

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The app will be available at http://localhost:5173.

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at http://localhost:8000.

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
