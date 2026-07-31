import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import joblib
import psycopg2
from psycopg2.extras import RealDictCursor
from sklearn.linear_model import LinearRegression


SUPPORTED_INTENTS = {
    "TIMETABLE_QUERY",
    "LIVE_CLASS_QUERY",
    "ASSIGNMENT_QUERY",
    "DOUBT_QUERY",
    "ADMIN_ANALYTICS_QUERY",
    "PERFORMANCE_PREDICTION",
}

INTENT_TO_TASK = {
    "TIMETABLE_QUERY": "TASK_TIMETABLE",
    "LIVE_CLASS_QUERY": "TASK_LIVE_CLASS",
    "ASSIGNMENT_QUERY": "TASK_ASSIGNMENT",
    "DOUBT_QUERY": "TASK_DOUBT_SUPPORT",
    "ADMIN_ANALYTICS_QUERY": "TASK_ADMIN_ANALYTICS",
    "PERFORMANCE_PREDICTION": "TASK_PERFORMANCE_PREDICTION",
}

_MODEL = None
_VECTORIZER = None
_CONN = None


# ================================
# SMART DAY DETECTION
# ================================

def detect_day_from_message(message: str) -> str:
    message = message.lower()
    now = datetime.now()

    weekdays = [
        "monday","tuesday","wednesday",
        "thursday","friday","saturday","sunday"
    ]

    for day in weekdays:
        if day in message:
            return day.capitalize()

    if "tomorrow" in message:
        target = now + timedelta(days=1)

    elif "yesterday" in message:
        target = now - timedelta(days=1)
    else:
        target = now

    return target.strftime("%A")


def _today_bounds_utc():
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return start, end


# ================================
# POSTGRES CONNECTION
# ================================

def _database_url() -> str:
    return (
        os.getenv("DATABASE_URL")
        or os.getenv("SUPABASE_DB_URL")
        or os.getenv("POSTGRES_URL")
        or ""
    )


def get_conn():
    """Lazily open (and reopen) the Postgres connection."""
    global _CONN
    if _CONN is None or _CONN.closed:
        _CONN = psycopg2.connect(_database_url(), connect_timeout=10)
        _CONN.autocommit = True
    return _CONN


def _reset_conn():
    global _CONN
    try:
        if _CONN is not None:
            _CONN.close()
    except Exception:
        pass
    _CONN = None


def _fetch_all(sql: str, params=()):
    for attempt in (1, 2):
        try:
            with get_conn().cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(sql, params)
                return cur.fetchall()
        except psycopg2.OperationalError:
            _reset_conn()
            if attempt == 2:
                raise
    return []


def _fetch_one(sql: str, params=()):
    rows = _fetch_all(sql, params)
    return rows[0] if rows else None


def _count(table: str, where: str = "", params=()) -> int:
    row = _fetch_one(f"SELECT count(*)::int AS c FROM {table} {where}", params)
    return int(row["c"]) if row else 0


# ================================
# ML INTENT DETECTION
# ================================

def load_intent_assets():
    global _MODEL, _VECTORIZER
    root = Path(__file__).resolve().parent
    models_path = root / "models"

    _MODEL = joblib.load(models_path / "intent_model.pkl")
    _VECTORIZER = joblib.load(models_path / "vectorizer.pkl")


def detect_intent(message: str):
    if _MODEL is None or _VECTORIZER is None:
        load_intent_assets()

    vector = _VECTORIZER.transform([message])
    intent = str(_MODEL.predict(vector)[0])

    if intent not in SUPPORTED_INTENTS:
        intent = "DOUBT_QUERY"

    return intent


def route_task(intent: str):
    return INTENT_TO_TASK.get(intent, "TASK_DOUBT_SUPPORT")


# ================================
# TASK EXECUTION (SQL)
# ================================

def execute_task(task: str, user_email: str, message: str):

    day_name = detect_day_from_message(message)

    # -----------------------------
    # TIMETABLE
    # -----------------------------
    if task == "TASK_TIMETABLE":
        row = _fetch_one(
            "SELECT days::text AS days FROM timetables ORDER BY created_at ASC LIMIT 1"
        )
        days = row["days"] if row else None
        doc = json.loads(days) if isinstance(days, str) else (days or {})
        entries = doc.get(day_name, [])

        return {
            "task": task,
            "day": day_name,
            "count": len(entries),
            "items": entries,
        }

    # -----------------------------
    # LIVE CLASS
    # -----------------------------
    if task == "TASK_LIVE_CLASS":
        start, end = _today_bounds_utc()
        sessions = _fetch_all(
            """
            SELECT id::text AS id,
                   room_id AS "roomId",
                   teacher_id::text AS "teacherId",
                   class_name AS "className",
                   date,
                   start_time AS "startTime",
                   end_time AS "endTime",
                   recording_url AS "recordingUrl",
                   recording_path AS "recordingPath",
                   assignment,
                   created_at AS "createdAt"
            FROM live_sessions
            WHERE date >= %s AND date < %s
            LIMIT 5
            """,
            (start, end),
        )

        return {
            "task": task,
            "count": len(sessions),
            "items": sessions,
        }

    # -----------------------------
    # ADMIN ANALYTICS
    # -----------------------------
    if task == "TASK_ADMIN_ANALYTICS":
        user = _fetch_one(
            "SELECT role FROM users WHERE email = %s LIMIT 1", (user_email,)
        ) if user_email else None
        if not user or user.get("role") != "admin":
            return {"authorized": False}

        return {
            "authorized": True,
            "summary": {
                "total_users": _count("users"),
                "total_students": _count("users", "WHERE role = %s", ("student",)),
                "total_teachers": _count("users", "WHERE role = %s", ("teacher",)),
                "total_live_sessions": _count("live_sessions"),
                "total_assignments": _count("assignments"),
            },
        }

    # -----------------------------
    # PERFORMANCE PREDICTION
    # -----------------------------
    if task == "TASK_PERFORMANCE_PREDICTION":

        assignment_count = _count("assignments")
        live_count = _count("live_sessions")

        x_train = [[0, 0], [1, 0], [2, 1], [3, 1], [4, 2], [5, 3]]
        y_train = [42, 48, 55, 61, 68, 74]

        reg = LinearRegression()
        reg.fit(x_train, y_train)

        predicted = float(reg.predict([[assignment_count, live_count]])[0])
        predicted = max(0, min(100, round(predicted, 2)))

        return {
            "prediction": predicted
        }

    return {"message": "I couldn't understand your request."}


# ================================
# HUMAN REPLY GENERATOR
# ================================

def generate_human_reply(intent: str, result: Dict[str, Any]):

    if intent == "TIMETABLE_QUERY":
        items = result.get("items", [])
        day = result.get("day")

        if not items:
            return f"You don't have any classes scheduled on {day}. Enjoy your free time 🙂"

        first = items[0]
        subject = first.get("subject") or first.get("class")
        time = first.get("time")

        return f"For {day}, you have {len(items)} classes. Your first class is {subject} at {time}."

    if intent == "LIVE_CLASS_QUERY":
        count = result.get("count", 0)
        if count == 0:
            return "There are no live classes happening today."
        return f"There are {count} live sessions recorded for today."

    if intent == "ADMIN_ANALYTICS_QUERY":
        if not result.get("authorized"):
            return "Admin analytics are available only for admin users."
        summary = result["summary"]
        return (
            f"Platform has {summary['total_users']} users, "
            f"{summary['total_students']} students, "
            f"{summary['total_teachers']} teachers."
        )

    if intent == "PERFORMANCE_PREDICTION":
        score = result.get("prediction")
        return f"Based on current activity, your estimated performance score is {score}."

    return "Can you please clarify your question a bit more?"
