import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import joblib
from pymongo import MongoClient
from sklearn.linear_model import LinearRegression


DEFAULT_MONGO_URI = (
    "mongodb+srv://ranjit5201314_db_user:admin12345@cluster1edunovax.8q5lafw.mongodb.net/edunova"
)

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
_MONGO_CLIENT: Optional[MongoClient] = None


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


def get_db():
    global _MONGO_CLIENT
    mongo_uri = os.getenv("MONGO_URI") or DEFAULT_MONGO_URI

    if _MONGO_CLIENT is None:
        _MONGO_CLIENT = MongoClient(mongo_uri, serverSelectionTimeoutMS=10000)

    _MONGO_CLIENT.admin.command("ping")

    default_db = _MONGO_CLIENT.get_default_database()
    if default_db:
        return default_db

    return _MONGO_CLIENT["edunova"]


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
# TASK EXECUTION
# ================================

def execute_task(task: str, user_email: str, message: str):

    db = get_db(edunova_db)
    day_name = detect_day_from_message(message)

    # -----------------------------
    # TIMETABLE
    # -----------------------------
    if task == "TASK_TIMETABLE":
        doc = db["timetables"].find_one({}, {"_id": 0, day_name: 1}) or {}
        entries = doc.get(day_name, [])

        return {
            "task": task,
            "day": day,
            "count": len(entries),
            "items": entries,
        }

    # -----------------------------
    # LIVE CLASS
    # -----------------------------
    if task == "TASK_LIVE_CLASS":
        start, end = _today_bounds_utc()
        sessions = list(
            db["livesessions"]
            .find({"date": {"$gte": start, "$lt": end}})
            .limit(5)
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
        user = db["users"].find_one({"email": user_email})
        if not user or user.get("role") != "admin":
            return {"authorized": False}

        return {
            "authorized": True,
            "summary": {
                "total_users": db["users"].count_documents({}),
                "total_students": db["users"].count_documents({"role": "student"}),
                "total_teachers": db["users"].count_documents({"role": "teacher"}),
                "total_live_sessions": db["livesessions"].count_documents({}),
                "total_assignments": db["assignments"].count_documents({}),
            },
        }

    # -----------------------------
    # PERFORMANCE PREDICTION
    # -----------------------------
    if task == "TASK_PERFORMANCE_PREDICTION":

        assignment_count = db["assignments"].count_documents({})
        live_count = db["livesessions"].count_documents({})

        x_train = [[0, 0], [1, 0], [2, 1], [3, 1], [4, 2], [5, 3]]
        y_train = [42, 48, 55, 61, 68, 74]

        reg = LinearRegression()
        reg.fit(x_train, y_train)

        predicted = float(reg.predict([[assignment_count, live_count]])[0])
        predicted = max(0, min(100, round(predicted, 2)))

        return {
            "prediction": predicted
        }

    return {"message": "I couldn’t understand your request."}


# ================================
# HUMAN REPLY GENERATOR
# ================================

def generate_human_reply(intent: str, result: Dict[str, Any]):

    if intent == "TIMETABLE_QUERY":
        items = result.get("items", [])
        day = result.get("day")

        if not items:
            return f"You don’t have any classes scheduled on {day}. Enjoy your free time 🙂"

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
