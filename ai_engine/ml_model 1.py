import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import joblib
from pymongo import MongoClient
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
_MONGO_CLIENT = None


def _serialize(doc: Dict[str, Any]) -> Dict[str, Any]:
    clean = {}
    for key, value in doc.items():
        if key == "_id":
            clean["id"] = str(value)
        elif isinstance(value, datetime):
            clean[key] = value.isoformat()
        else:
            clean[key] = value
    return clean


def _today_bounds_utc() -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return start, end


def _today_name() -> str:
    return datetime.now().strftime("%A")


def get_db():
    global _MONGO_CLIENT
    mongo_uri = os.getenv("MONGO_URI")
    if not mongo_uri:
        raise RuntimeError("MONGO_URI is missing in environment")
    if _MONGO_CLIENT is None:
        _MONGO_CLIENT = MongoClient(mongo_uri)

    default_db = _MONGO_CLIENT.get_default_database()
    if default_db is not None:
        return default_db
    return _MONGO_CLIENT["edunova"]


def load_intent_assets(models_dir: Optional[Path] = None):
    global _MODEL, _VECTORIZER
    root = Path(__file__).resolve().parent
    models_path = models_dir or (root / "models")
    _MODEL = joblib.load(models_path / "intent_model.pkl")
    _VECTORIZER = joblib.load(models_path / "vectorizer.pkl")


def detect_intent(message: str) -> Dict[str, Any]:
    if _MODEL is None or _VECTORIZER is None:
        load_intent_assets()

    clean_message = str(message or "").strip()
    if not clean_message:
        raise ValueError("message cannot be empty")

    vector = _VECTORIZER.transform([clean_message])
    intent = str(_MODEL.predict(vector)[0])
    confidence = None
    if hasattr(_MODEL, "predict_proba"):
        probs = _MODEL.predict_proba(vector)[0]
        confidence = float(max(probs))

    if intent not in SUPPORTED_INTENTS:
        intent = "DOUBT_QUERY"

    return {"intent": intent, "confidence": confidence}


def route_task(intent: str) -> str:
    return INTENT_TO_TASK.get(intent, "TASK_DOUBT_SUPPORT")


def execute_task(task: str, user_email: str) -> Dict[str, Any]:
    db = get_db()
    users = db["users"]
    user = users.find_one({"email": user_email}, {"password": 0}) if user_email else None
    user_role = str(user.get("role", "guest")) if user else "guest"

    if task == "TASK_TIMETABLE":
        day_name = _today_name()
        if user_role == "teacher":
            doc = db["teacher_timetables"].find_one({}, {"_id": { "$oid": "6943f4e22fc13232ae03fe2a"
  
}, day_name: 1}) or {}
            entries = doc.get(day_name, [])
            return {
                "task": task,
                "role": user_role,
                "day": day_name,
                "count": len(entries),
                "items": entries,
            }
        doc = db["timetables"].find_one({}, {"_id": 0, day_name: 1}) or {}
        entries = doc.get(day_name, [])
        return {
            "task": task,
            "role": user_role,
            "day": day_name,
            "count": len(entries),
            "items": entries,
        }

    if task == "TASK_LIVE_CLASS":
        start, end = _today_bounds_utc()
        query = {"date": {"$gte": start, "$lt": end}}
        if user and user_role == "teacher":
            query["teacherId"] = user["_id"]
        sessions = (
            db["livesessions"]
            .find(query, {"recordingPath": 0})
            .sort([("createdAt", -1)])
            .limit(10)
        )
        items = [_serialize(doc) for doc in sessions]
        return {"task": task, "count": len(items), "items": items}

    if task == "TASK_ASSIGNMENT":
        query: Dict[str, Any] = {}
        if user and user_role == "teacher":
            query["createdBy.email"] = user_email
        assignments = (
            db["assignments"]
            .find(
                query,
                {
                    "title": 1,
                    "room": 1,
                    "createdAt": 1,
                    "filename": 1,
                    "createdBy.name": 1,
                    "createdBy.email": 1,
                },
            )
            .sort([("createdAt", -1)])
            .limit(10)
        )
        items = [_serialize(doc) for doc in assignments]
        return {"task": task, "count": len(items), "items": items}

    if task == "TASK_DOUBT_SUPPORT":
        tips = [
            "Break the topic into 3 sub-parts and ask one precise question for each.",
            "Use today's timetable topic first, then compare with assignment quiz questions.",
            "Share where you got stuck: concept, formula, or application.",
        ]
        context = {}
        day_name = _today_name()
        if user_role == "teacher":
            context_doc = db["teacher_timetables"].find_one({}, {"_id": 0, day_name: 1}) or {}
            context["today_classes"] = context_doc.get(day_name, [])
        else:
            context_doc = db["timetables"].find_one({}, {"_id": 0, day_name: 1}) or {}
            context["today_classes"] = context_doc.get(day_name, [])
        return {"task": task, "tips": tips, "context": context}

    if task == "TASK_ADMIN_ANALYTICS":
        if user_role != "admin":
            return {
                "task": task,
                "error": "Admin analytics are restricted to admin users.",
                "authorized": False,
            }
        summary = {
            "total_users": db["users"].count_documents({}),
            "total_students": db["users"].count_documents({"role": "student"}),
            "total_teachers": db["users"].count_documents({"role": "teacher"}),
            "total_live_sessions": db["livesessions"].count_documents({}),
            "total_assignments": db["assignments"].count_documents({}),
            "total_recordings": db["recordings"].count_documents({}),
            "total_messages": db["contactmessages"].count_documents({}),
        }
        return {"task": task, "authorized": True, "summary": summary}

    if task == "TASK_PERFORMANCE_PREDICTION":
        assignment_count = db["assignments"].count_documents({"createdBy.email": user_email}) if user_email else 0
        live_count = db["livesessions"].count_documents({"teacherId": user["_id"]}) if user and user_role == "teacher" else 0

        # Tiny local regressor trained on synthetic engagement->score data.
        x_train = [
            [0, 0],
            [1, 0],
            [2, 1],
            [3, 1],
            [4, 2],
            [5, 3],
            [7, 5],
            [10, 8],
        ]
        y_train = [42, 48, 55, 61, 68, 74, 84, 93]
        reg = LinearRegression()
        reg.fit(x_train, y_train)
        predicted_score = float(reg.predict([[assignment_count, live_count]])[0])
        predicted_score = max(0.0, min(100.0, round(predicted_score, 2)))

        level = "high"
        if predicted_score < 55:
            level = "low"
        elif predicted_score < 75:
            level = "medium"

        return {
            "task": task,
            "features": {
                "assignment_count": assignment_count,
                "live_class_count": live_count,
            },
            "prediction": {
                "predicted_score": predicted_score,
                "confidence_band": level,
            },
        }

    return {"task": task, "message": "No executor available"}


# HRM naming aliases requested by architecture spec.
def routeTask(intent: str) -> str:
    return route_task(intent)


def executeTask(task: str, user_email: str) -> Dict[str, Any]:
    return execute_task(task, user_email)
