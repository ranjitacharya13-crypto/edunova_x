from datetime import datetime, timedelta
import json
import os
import re
import traceback

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import psycopg2
from psycopg2.extras import RealDictCursor

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Postgres connection (works with Supabase, Render Postgres, local, ...).
DATABASE_URL = (
    os.getenv("DATABASE_URL")
    or os.getenv("SUPABASE_DB_URL")
    or os.getenv("POSTGRES_URL")
    or ""
)
STUDENT_TIMETABLE_ID = os.getenv("STUDENT_TIMETABLE_ID", "")
TEACHER_TIMETABLE_ID = os.getenv("TEACHER_TIMETABLE_ID", "")

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

_conn = None


def get_conn():
    """Lazily open (and reopen) the Postgres connection."""
    global _conn
    if _conn is None or _conn.closed:
        _conn = psycopg2.connect(DATABASE_URL, connect_timeout=10)
        _conn.autocommit = True
    return _conn


def _reset_conn():
    global _conn
    try:
        if _conn is not None:
            _conn.close()
    except Exception:
        pass
    _conn = None


def fetch_one(sql: str, params=()):
    for attempt in (1, 2):
        try:
            with get_conn().cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(sql, params)
                return cur.fetchone()
        except psycopg2.OperationalError:
            _reset_conn()
            if attempt == 2:
                raise
    return None


def check_connection():
    for attempt in (1, 2):
        try:
            with get_conn().cursor() as cur:
                cur.execute("SELECT 1")
            return
        except psycopg2.OperationalError:
            _reset_conn()
            if attempt == 2:
                raise


class QueryRequest(BaseModel):
    message: str
    email: str | None = None


@app.get("/")
async def root():
    return {
        "success": True,
        "service": "edu_assistance",
        "system": "ASI: Artificial Superintelligence",
        "architecture": "SNN: Spiking Neural Network",
        "message": "Service is running. Use POST /api/ai/query for edu_assistance responses.",
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


# ------------------------
# INTENT DETECTION
# ------------------------

def detect_intent(message: str):
    msg = message.lower()

    if "today" in msg and "tomorrow" in msg:
        return "today_and_tomorrow"
    if "today's and tomorrow's" in msg:
        return "today_and_tomorrow"
    if "tomorrow" in msg:
        return "tomorrow"
    if "today" in msg:
        return "today"
    if "next class" in msg:
        return "next"
    return "general"


# ------------------------
# DATABASE FETCH (SQL)
# ------------------------

def get_user_role(email: str | None):
    if not email:
        return "student"
    row = fetch_one("SELECT role FROM users WHERE email = %s LIMIT 1", (email,))
    if not row:
        return "student"
    return str(row.get("role", "student")).lower()


def get_timetable(email: str | None):
    role = get_user_role(email)
    # Table names can't be query parameters; `table` is derived only from
    # the fixed set below, so this interpolation is safe.
    table = "teacher_timetables" if role == "teacher" else "timetables"
    preferred_id = TEACHER_TIMETABLE_ID if role == "teacher" else STUDENT_TIMETABLE_ID
    days = None

    if preferred_id and _UUID_RE.match(preferred_id):
        row = fetch_one(f"SELECT days::text AS days FROM {table} WHERE id = %s LIMIT 1", (preferred_id,))
        days = row["days"] if row else None

    if days is None:
        row = fetch_one(f"SELECT days::text AS days FROM {table} ORDER BY created_at ASC LIMIT 1")
        days = row["days"] if row else None

    timetable = json.loads(days) if isinstance(days, str) else (days or None)
    return timetable, table, role


def get_day_name(offset=0):
    day = datetime.now() + timedelta(days=offset)
    return day.strftime("%A")


def get_classes_for_day(day_name, email: str | None):
    timetable, table, role = get_timetable(email)
    if not timetable:
        return [], table, role
    return timetable.get(day_name, []), table, role


# ------------------------
# HUMAN RESPONSE
# ------------------------

PERIOD_TIME_MAP = {
    1: "9:30 - 10:15",
    2: "10:15 - 11:00",
    3: "11:00 - 11:45",
    4: "11:45 - 12:30",
    5: "12:30 - 1:00",
    6: "1:30 - 2:15",
    7: "2:15 - 3:00",
    8: "3:00 - 3:45",
    9: "3:45 - 4:00",
}


def get_subject_suggestion(class_name: str):
    name = str(class_name or "").lower()
    if "math" in name:
        return {
            "focus_tip": "Break each problem into steps and verify your final answer calmly.",
            "quick_action": "Solve one extra practice question after class.",
            "energy_line": "Math confidence grows with every solved step.",
        }
    if "physics" in name:
        return {
            "focus_tip": "Watch the formula, units, and concept meaning together.",
            "quick_action": "Write one real-life example for today's concept.",
            "energy_line": "Think concept first, formula second.",
        }
    if "chemistry" in name:
        return {
            "focus_tip": "Track reactions carefully and notice why each step happens.",
            "quick_action": "Revise one equation pair before your next period.",
            "energy_line": "Small revision now saves big effort later.",
        }
    if "biology" in name:
        return {
            "focus_tip": "Visualize the process using diagrams and keywords.",
            "quick_action": "Summarize the topic in 3 bullet points.",
            "energy_line": "Diagram memory is your superpower here.",
        }
    if "science" in name:
        return {
            "focus_tip": "Connect the theory with a practical example.",
            "quick_action": "Note one key concept and one question to ask.",
            "energy_line": "Curiosity makes science easier.",
        }
    if "english" in name:
        return {
            "focus_tip": "Read actively and observe tone, structure, and key words.",
            "quick_action": "Use 2 new words in your own sentence.",
            "energy_line": "Strong language = strong expression.",
        }
    if "social" in name or "history" in name or "civics" in name or "geography" in name:
        return {
            "focus_tip": "Link events, places, and causes like a story map.",
            "quick_action": "Create one quick timeline or concept map.",
            "energy_line": "Context turns facts into memory.",
        }
    if "tamil" in name or "hindi" in name or "language" in name:
        return {
            "focus_tip": "Read with pronunciation, rhythm, and meaning in mind.",
            "quick_action": "Recite one paragraph and summarize it simply.",
            "energy_line": "Fluency improves with short daily practice.",
        }
    if "library" in name or "revision" in name:
        return {
            "focus_tip": "Use this period to close one weak area fully.",
            "quick_action": "Revise notes and mark one doubt to clear today.",
            "energy_line": "Revision is where marks become stable.",
        }
    if "pt" in name or "activity" in name:
        return {
            "focus_tip": "Stay active, hydrated, and keep your breathing steady.",
            "quick_action": "Reset your focus for the next academic period.",
            "energy_line": "A fresh body supports a sharp mind.",
        }
    return {
        "focus_tip": "Stay engaged and capture one key takeaway from this class.",
        "quick_action": "Write one line summary before moving to the next period.",
        "energy_line": "Consistency beats intensity in learning.",
    }


def resolve_time(period, raw_time):
    text = str(raw_time or "").strip()
    if text:
        return text
    try:
        key = int(period)
    except Exception:
        return "time will be confirmed soon"
    return PERIOD_TIME_MAP.get(key, "time will be confirmed soon")


def get_teacher_suggestion(class_name: str):
    name = str(class_name or "").lower()
    if "lunch" in name or "break" in name:
        return {
            "focus_tip": "Take a real reset so your next class gets your best energy.",
            "quick_action": "Use 5 minutes to prep your first board line for the next session.",
        }
    if "meeting" in name:
        return {
            "focus_tip": "Capture clear decisions and one immediate action to close the loop.",
            "quick_action": "Note top 3 takeaways before you leave the room.",
        }
    if "math" in name:
        return {
            "focus_tip": "Set one anchor problem early to build momentum in the room.",
            "quick_action": "Use a quick checkpoint question before moving to the next concept.",
        }
    if "physics" in name or "chemistry" in name or "biology" in name or "science" in name:
        return {
            "focus_tip": "Open with a real-world hook to trigger curiosity in the first 2 minutes.",
            "quick_action": "Close with one practical example students can relate to today.",
        }
    if "english" in name or "language" in name or "hindi" in name or "tamil" in name:
        return {
            "focus_tip": "Start with one expressive prompt and pull responses from multiple students.",
            "quick_action": "End with a short reflection line to build confidence and fluency.",
        }
    if "history" in name or "social" in name or "geography" in name or "civics" in name:
        return {
            "focus_tip": "Frame the topic as a story, then connect it to one current-day example.",
            "quick_action": "Ask one cause-and-effect question before wrapping up.",
        }
    if "pt" in name or "activity" in name:
        return {
            "focus_tip": "Keep transitions crisp and end with one reflection point.",
            "quick_action": "Reinforce one discipline habit students should carry forward.",
        }
    return {
        "focus_tip": "Stay engaged and capture one key takeaway from this class.",
        "quick_action": "Write one line summary before moving to the next period.",
    }


def format_schedule(classes, label, role="student"):
    if not classes:
        if role == "teacher":
            return (
                f"Nice! You have no classes {label}. "
                "Take a reset break, plan one high-impact activity, and return stronger."
            )
        return (
            f"Nice! You have no classes {label}. "
            "Take a reset break, then do a quick 20-minute revision to stay sharp."
        )

    day_phrase = "today" if label == "today" else "tomorrow"
    opening = (
        f"Let's make {day_phrase} count. You have {len(classes)} classes lined up.\n"
        "Here is your flow, with a quick smart tip for each one:\n"
    )
    reply = opening + "\n"

    for idx, c in enumerate(classes, start=1):
        class_name = c.get("class") or c.get("subject") or "Class"
        period = c.get("period", idx)
        time = resolve_time(period, c.get("time"))

        if role == "teacher":
            grade = c.get("grade") or c.get("standard") or c.get("year") or ""
            section = c.get("section") or c.get("batch") or ""
            title = " ".join([p for p in [grade, section] if p]).strip() or class_name
            tip = get_teacher_suggestion(class_name)
            reply += (
                f"{idx}. Period {period} • {title}\n"
                f"   ⏰ {time}\n"
                f"   🎯 {tip['focus_tip']}\n"
                f"   ⚡ {tip['quick_action']}\n"
            )
        else:
            suggestion = get_subject_suggestion(class_name)
            reply += (
                f"{idx}. Period {period} • {class_name}\n"
                f"   ⏰ {time}\n"
                f"   🎯 {suggestion['focus_tip']}\n"
                f"   ⚡ {suggestion['quick_action']}\n"
            )

        if idx == 3 and len(classes) > 4:
            reply += "   🔥 Pace check: Great rhythm so far. Keep the focus tight.\n"
        reply += "\n"

    reply += "You are on track. One focused class at a time and you'll finish strong."
    return reply


def get_next_class(classes):
    now = datetime.now()
    for c in classes:
        start_time = str(c.get("time", "")).split("-")[0].strip()
        try:
            class_time = datetime.strptime(start_time, "%H:%M").replace(
                year=now.year, month=now.month, day=now.day
            )
            if class_time > now:
                class_name = c.get("class") or c.get("subject") or "Class"
                return (
                    f"Your next class is {class_name} at {c.get('time', 'time will be confirmed soon')}.\n"
                    "Quick prep: open your notes now, review for 2 minutes, and join a little early."
                )
        except Exception:
            continue
    return "Great job, you've wrapped up all classes for today. Take a short break and revise one key concept before you log off."


# ------------------------
# MAIN ROUTE
# ------------------------

@app.post("/api/ai/query")
async def ai_query(request: QueryRequest):
    try:
        # Validate DB connectivity for every request to avoid silent fallback behaviour.
        check_connection()

        intent = detect_intent(request.message)
        email = request.email

        if intent == "today_and_tomorrow":
            today = get_day_name(0)
            tomorrow = get_day_name(1)
            today_classes, table, role = get_classes_for_day(today, email)
            tomorrow_classes, _, _ = get_classes_for_day(tomorrow, email)
            print("Detected intent:", intent)
            print("Today:", today)
            print("Tomorrow:", tomorrow)
            print("Classes found:", {"today": today_classes, "tomorrow": tomorrow_classes})
            return {
                "success": True,
                "reply": f"{format_schedule(today_classes, 'today', role)}\n\n{format_schedule(tomorrow_classes, 'tomorrow', role)}",
                "source_table": table,
                "role": role,
            }

        if intent == "today":
            today = get_day_name(0)
            classes, table, role = get_classes_for_day(today, email)
            print("Detected intent:", intent)
            print("Today:", get_day_name(0))
            print("Tomorrow:", get_day_name(1))
            print("Classes found:", classes)
            return {
                "success": True,
                "reply": format_schedule(classes, "today", role),
                "source_table": table,
                "role": role,
            }

        if intent == "tomorrow":
            tomorrow = get_day_name(1)
            classes, table, role = get_classes_for_day(tomorrow, email)
            print("Detected intent:", intent)
            print("Today:", get_day_name(0))
            print("Tomorrow:", get_day_name(1))
            print("Classes found:", classes)
            return {
                "success": True,
                "reply": format_schedule(classes, "tomorrow", role),
                "source_table": table,
                "role": role,
            }

        if intent == "next":
            today = get_day_name(0)
            classes, table, role = get_classes_for_day(today, email)
            print("Detected intent:", intent)
            print("Today:", get_day_name(0))
            print("Tomorrow:", get_day_name(1))
            print("Classes found:", classes)
            return {
                "success": True,
                "reply": get_next_class(classes),
                "source_table": table,
                "role": role,
            }

        classes = []
        print("Detected intent:", intent)
        print("Today:", get_day_name(0))
        print("Tomorrow:", get_day_name(1))
        print("Classes found:", classes)
        return {
            "success": True,
            "reply": "I can help you with your timetable. Try asking about today or tomorrow."
        }

    except Exception as exc:
        traceback.print_exc()
        return {
            "success": False,
            "reply": f"AI encountered an internal error: {exc}"
        }
