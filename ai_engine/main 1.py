from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import traceback

app = FastAPI()

# Allow frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request model
class QueryRequest(BaseModel):
    message: str
    email: Optional[str] = None


# Simple ML-like intent logic (safe placeholder)
def detect_intent(message: str):
    message = message.lower()

    if "tomorrow" in message:
        return "timetable_tomorrow"
    if "today" in message:
        return "timetable_today"
    if "next class" in message:
        return "next_class"
    return "general"


def generate_response(intent: str):
    if intent == "timetable_today":
        return "Here is today's timetable."
    if intent == "timetable_tomorrow":
        return "Here is tomorrow's timetable."
    if intent == "next_class":
        return "Your next class starts soon."
    return "I am here to help with your learning."


@app.post("/api/ai/query")
async def ai_query(request: QueryRequest):
    try:
        if not request.message:
            return {
                "success": False,
                "reply": "Message cannot be empty"
            }

        intent = detect_intent(request.message)
        response = generate_response(intent)

        return {
            "success": True,
            "reply": response,
            "intent": intent
        }

    except Exception as e:
        print("AI ENGINE ERROR:")
        traceback.print_exc()

        return {
            "success": False,
            "reply": "AI internal error"
        }
