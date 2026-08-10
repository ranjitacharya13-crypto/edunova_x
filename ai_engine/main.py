from datetime import datetime, timedelta
import os
import traceback
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Local-dev convenience: load MONGO_URI from ../server/.env when present.
# In production (Render) the MONGO_URI env var is injected directly, so no
# credentials are ever hardcoded in this repository.
try:
    from dotenv import load_dotenv

    _server_env = Path(__file__).resolve().parents[1] / "server" / ".env"
    if _server_env.exists():
        load_dotenv(_server_env)
except ImportError:
    pass

import tutor
import timetable

app = FastAPI(title="EduNova_X AI Engine", version="2.0.0")

# CORS: allow the deployed frontend. Comma-separated list via CORS_ORIGIN;
# defaults to "*" (any origin) when unset or empty.
_cors_raw = os.getenv("CORS_ORIGIN", "").strip()
CORS_ORIGINS = [o.strip() for o in _cors_raw.split(",") if o.strip()] or [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://edunova-x.ranjitacharya13.workers.dev",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# MongoDB — lazy + optional
# ---------------------------------------------------------------------------
# FIX (502 root cause): the AI engine must NOT hard-crash at import time when
# MONGO_URI is missing or the database is unreachable. A crash at startup makes
# the hosting proxy (Render / Cloudflare) return 502 Bad Gateway for every
# /api/ai/query request. Instead we initialise the client lazily and degrade
# gracefully: timetable intents fall back to a friendly message and the tutor
# engine works entirely without Mongo (it has its own knowledge base).
MONGO_URI = os.getenv("MONGO_URI", "").strip()
DB_NAME = os.getenv("MONGO_DB_NAME", "edunova")
STUDENT_TIMETABLE_ID = os.getenv("STUDENT_TIMETABLE_ID", "693c1a9a3ea4ac84aaf771cd")
TEACHER_TIMETABLE_ID = os.getenv("TEACHER_TIMETABLE_ID", "6943f4e22fc13232ae03fe2a")

_client = None


def _get_mongo():
    global _client
    if _client is not None:
        return _client
    if not MONGO_URI:
        return None
    try:
        from pymongo import MongoClient

        _client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=8000)
        _client.admin.command("ping")
        timetable.configure(_client, DB_NAME, STUDENT_TIMETABLE_ID, TEACHER_TIMETABLE_ID)
        return _client
    except Exception as exc:  # pragma: no cover - depends on network/db state
        print(f"[edunova-ai] Mongo unavailable, running without DB: {exc}")
        _client = None
        return None


class QueryRequest(BaseModel):
    message: str
    email: str | None = None
    conversationHistory: list | None = None
    studentContext: dict | None = None
    tutoringContext: dict | None = None


@app.get("/")
async def root():
    return {
        "success": True,
        "service": "edunova-ai",
        "tutor": "EduNova AI Tutor",
        "message": "Service is running. Use POST /api/ai/query for EduNova AI tutoring responses.",
    }


@app.get("/health")
async def health():
    # Always report live even if Mongo is down — the engine still serves the tutor.
    db_ok = False
    try:
        c = _get_mongo()
        if c is not None:
            c.admin.command("ping")
            db_ok = True
    except Exception:
        db_ok = False
    return {"status": "live", "service": "edunova-ai", "database": "connected" if db_ok else "unavailable"}


# Backwards-compatible simple ping (some old probes used /api/health).
@app.get("/api/health")
async def api_health():
    return await health()


@app.post("/api/ai/query")
async def ai_query(request: QueryRequest):
    try:
        # Warm Mongo (lazy) so timetable data is available when possible.
        try:
            _get_mongo()
        except Exception:
            pass

        response = tutor.generate_tutor_response(
            message=request.message,
            email=request.email or "guest",
            conversation_history=request.conversationHistory or [],
            tutoring_context=request.tutoringContext or {},
            student_context=request.studentContext or {},
        )
        response["success"] = True
        return response
    except Exception as exc:
        traceback.print_exc()
        return {
            "success": False,
            "reply": "I hit a small hiccup on my side. Please try again in a moment.",
        }


# Backwards-compatible alias without the /api prefix (the Express route tries
# both /api/ai/query and /ai/query).
@app.post("/ai/query")
async def ai_query_alias(request: QueryRequest):
    return await ai_query(request)
