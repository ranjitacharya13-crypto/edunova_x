"""Deterministic fast-path routing for the EduNova unified agent.

The self-hosted model runs on a small shared CPU. The full goal-oriented
``AgentEngine`` loop (multiple JSON planning iterations) stays available for
complex, ambiguous requests, but most student questions follow well-known
shapes. This module classifies those shapes deterministically (zero model
calls), executes the exact EduNova tools needed through the *same*
``ToolRegistry`` (same permissions, same auth context, same audit trail), and
then uses the local model for a single synthesis/generation turn.

Routing contract (which source the AI uses):
- student-specific questions  -> EduNova database tools (authenticated)
- current/external questions  -> web_search, then local-model synthesis
- stable concept questions    -> the local model's own knowledge
- follow-ups ("explain it simply") -> conversation context + local model
- action requests (quiz/plan) -> database context + local model generation,
  then saved through the existing backend services with user confirmation
- anything ambiguous          -> full AgentEngine autonomous loop

The model NEVER picks a user id: tool executions receive the authenticated
user id from the request context, exactly like the full agent loop.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import inspect
import json
import logging
import re
from typing import Any

from config import Settings
from .engine import ObservationManager, SourceManager
from .events import EventCallback, EventEmitter
from .models import AgentResult, AgentState, Observation
from .tools.base import ToolRegistry

logger = logging.getLogger("edunova.agent.router")

# Fast-path intents handled without the autonomous loop.
FAST_INTENTS = {
    "knowledge",
    "schedule_today",
    "schedule_general",
    "subjects",
    "profile",
    "assignments",
    "exams",
    "attendance",
    "progress",
    "performance_analysis",
    "study_history",
    "materials",
    "syllabus",
    "notes_goals",
    "events",
    "study_recommendation",
    "web_research",
    "action_create_quiz",
    "action_study_plan",
}


@dataclass(frozen=True, slots=True)
class RouteDecision:
    intent: str
    tools: tuple[str, ...] = ()
    subject: str | None = None
    reason: str = ""


_SUBJECT_LEXICON = (
    "physics", "chemistry", "biology", "mathematics", "maths", "math", "computer science",
    "computers", "english", "tamil", "hindi", "social science", "social", "history",
    "geography", "economics", "commerce", "accountancy", "botany", "zoology",
    "statistics", "python", "java", "machine learning", "data structures",
)

# ---------------------------------------------------------------- patterns --
_RE_QUIZ_ACTION = re.compile(
    r"\b(create|make|generate|prepare|give me|build|set)\b[\s\S]{0,40}?\b(quiz|mcq|test|questions|question paper|mock)\b"
    r"|\bquiz\b[\s\S]{0,40}?\bon\b",
    re.IGNORECASE,
)
_RE_PLAN_ACTION = re.compile(
    r"\b(create|make|generate|prepare|plan|build|draft)\b[\s\S]{0,50}?\b(study plan|revision plan|study schedule|timetable for studying|exam plan)\b",
    re.IGNORECASE,
)
_RE_WEB = re.compile(
    r"\b(latest|recent|current|today'?s news|breaking)\b[\s\S]{0,60}?\b(news|development|developments|update|updates|release|releases|announcement|research|breakthrough|trend|trends|advancements?)\b"
    r"|\bnews\b[\s\S]{0,30}?\b(about|on|in)\b"
    r"|\bwho won\b|\bcurrent affairs\b|\bwhat'?s new in\b|\brecent advances in\b|\bupcoming (release|version)\b",
    re.IGNORECASE,
)
_RE_SCHEDULE_TODAY = re.compile(
    r"\b(classes|class|periods?|schedule|timetable|lectures?)\b[\s\S]{0,30}?\btoday\b"
    r"|\btoday'?s\b[\s\S]{0,30}?\b(classes|class|periods?|schedule|timetable|lectures?)\b"
    r"|\bwhat\b[\s\S]{0,20}?\b(classes|periods?)\b[\s\S]{0,20}?\bhave\b",
    re.IGNORECASE,
)
_RE_SCHEDULE_GENERAL = re.compile(
    r"\b(timetable|schedule|weekly classes|class schedule|periods?)\b"
    r"|\bclasses\b[\s\S]{0,25}?\b(tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
    re.IGNORECASE,
)
_RE_ASSIGNMENTS = re.compile(r"\bassignments?\b|\bhomework\b|\bdeadlines?\b|\bsubmissions?\b", re.IGNORECASE)
_RE_EXAMS = re.compile(r"\bexams?\b|\bupcoming tests?\b|\bexam (dates?|schedule)\b", re.IGNORECASE)
_RE_ATTENDANCE = re.compile(r"\battendance\b|\bpresent\b[\s\S]{0,10}?\brate\b|\babsent\b", re.IGNORECASE)
_RE_WEAK_STRONG = re.compile(
    r"\b(weak|weakest|strong|strongest|worst|best)\b[\s\S]{0,25}?\b(subjects?|topics?|areas?)\b"
    r"|\b(subjects?|topics?)\b[\s\S]{0,30}?\b(weak|struggling|poor|bad|fail(ed|ing)?|improve)\b"
    r"|\bhow am i (doing|performing)\b|\bmy performance\b|\bquiz (scores?|results?)\b|\bmy grades?\b|\bmy scores?\b",
    re.IGNORECASE,
)
_RE_PROGRESS = re.compile(r"\bprogress\b|\bstreak\b|\btrack record\b", re.IGNORECASE)
_RE_STUDY_HISTORY = re.compile(
    r"\bstudy (history|sessions?)\b|\b(what|when) did i study\b|\bhow much (did i|have i) stud(y|ied)\b",
    re.IGNORECASE,
)
_RE_STUDY_REC = re.compile(
    r"\bwhat should i study\b|\bwhat (to|shall i) study\b|\bstudy what\b|\bwhat do i study\b"
    r"|\bsuggest\b[\s\S]{0,25}?\bstudy\b|\bplan my (day|studies today)\b|\bhow should i study today\b",
    re.IGNORECASE,
)
_RE_MATERIALS = re.compile(
    r"\b(study materials?|learning materials?|notes|recordings?|files?|resources?)\b", re.IGNORECASE
)
_RE_SYLLABUS = re.compile(r"\bsyllabus\b|\bcurriculum\b|\btopics? to cover\b", re.IGNORECASE)
_RE_SUBJECTS = re.compile(r"\bmy subjects?\b|\benrolled\b|\bcourses?\b", re.IGNORECASE)
_RE_PROFILE = re.compile(r"\bmy profile\b|\bwho am i\b|\bmy (name|grade|class|account)\b", re.IGNORECASE)
_RE_GOALS = re.compile(r"\bmy goals?\b|\bmy targets?\b|\bmy notes\b", re.IGNORECASE)
_RE_EVENTS = re.compile(r"\bupcoming events?\b|\bnotifications?\b|\bannouncements?\b", re.IGNORECASE)
_RE_STUDENT_CONTEXT = re.compile(
    r"\b(my|me|i)\b[\s\S]{0,30}?\b(class|classes|timetable|schedule|subjects?|quiz|score|grade|attendance|assignment|exam|progress|study|notes|goals|syllabus)\b"
    r"|\b(classes|timetable|assignments?|exams?|attendance)\b[\s\S]{0,25}?\b(today|tomorrow|this week)\b",
    re.IGNORECASE,
)
_RE_FOLLOWUP = re.compile(
    r"^[\s]*(explain|simplif|elaborate|expand|shorten|summar|why|how|what about|example|give (an )?example|retry|again|continue|more|like i'?m|in simple|in detail|easier)",
    re.IGNORECASE,
)
_RE_REFERENCE = re.compile(r"\b(it|that|this|those|them|he|she|the same)\b", re.IGNORECASE)
_RE_CONCEPTUAL = re.compile(
    r"^(what is|what are|what'?s|explain|define|describe|how do(es)?|why do(es)?|why is|why are|difference between|compare|derive|prove|solve|calculate|list|advantages|disadvantages|applications? of|uses of)\b",
    re.IGNORECASE,
)


def _extract_subject(message: str) -> str | None:
    lowered = message.lower()
    for subject in _SUBJECT_LEXICON:
        if re.search(rf"\b{re.escape(subject)}\b", lowered):
            return subject.title() if len(subject) > 3 else subject
    return None


class IntentRouter:
    """Zero-cost rule-based router with a safe fallback to the full agent loop."""

    def __init__(self, settings: Settings):
        self.settings = settings

    def classify(self, message: str, conversation: list[dict[str, str]], *, decision_enabled: bool = True) -> RouteDecision:
        if not decision_enabled:
            return RouteDecision(intent="complex", reason="fast path disabled")
        text = message.strip()
        lowered = text.lower()
        words = lowered.split()
        subject = _extract_subject(text)

        # Compound/multistep requests need the full autonomous loop: they chain
        # several independent goals and cannot be served by a single tool bundle.
        compound = (
            " then " in f" {lowered} "
            or " after that " in lowered
            or lowered.count(", and") >= 1
            or len(words) > 30
        )
        if compound and not _RE_QUIZ_ACTION.search(lowered) and not _RE_PLAN_ACTION.search(lowered):
            return RouteDecision(intent="complex", reason="compound request")

        # 1) Action intents first — they imply database context + a write.
        if _RE_QUIZ_ACTION.search(lowered):
            tools = ["get_today_schedule"]
            if subject:
                tools += ["get_syllabus", "get_learning_materials"]
            return RouteDecision(intent="action_create_quiz", tools=tuple(dict.fromkeys(tools)), subject=subject, reason="quiz action")
        if _RE_PLAN_ACTION.search(lowered):
            return RouteDecision(
                intent="action_study_plan",
                tools=("get_exams", "get_progress", "get_syllabus"),
                subject=subject,
                reason="study plan action",
            )

        # 2) Explicitly student-specific data questions (never web/model guess).
        if _RE_SCHEDULE_TODAY.search(lowered):
            return RouteDecision(intent="schedule_today", tools=("get_today_schedule",), reason="today schedule")
        if _RE_WEAK_STRONG.search(lowered):
            tools = ["get_quiz_history", "get_progress", "get_subjects"]
            if subject:
                tools.append("get_quiz_results")
            return RouteDecision(intent="performance_analysis", tools=tuple(tools), subject=subject, reason="performance data")
        if _RE_STUDY_REC.search(lowered):
            return RouteDecision(
                intent="study_recommendation",
                tools=("get_today_schedule", "get_progress", "get_quiz_history", "get_assignments", "get_study_history", "get_exams"),
                reason="multi-source study recommendation",
            )
        if _RE_ASSIGNMENTS.search(lowered) and _RE_STUDENT_CONTEXT.search(lowered) or (
            _RE_ASSIGNMENTS.search(lowered) and len(words) <= 12
        ):
            return RouteDecision(intent="assignments", tools=("get_assignments",), reason="assignments")
        if _RE_EXAMS.search(lowered):
            return RouteDecision(intent="exams", tools=("get_exams",), subject=subject, reason="exams")
        if _RE_ATTENDANCE.search(lowered):
            return RouteDecision(intent="attendance", tools=("get_attendance",), reason="attendance")
        if _RE_STUDY_HISTORY.search(lowered):
            return RouteDecision(intent="study_history", tools=("get_study_history",), subject=subject, reason="study history")
        if _RE_PROGRESS.search(lowered) and _RE_STUDENT_CONTEXT.search(lowered):
            return RouteDecision(intent="progress", tools=("get_progress",), subject=subject, reason="progress")
        if _RE_SYLLABUS.search(lowered):
            return RouteDecision(intent="syllabus", tools=("get_syllabus",), subject=subject, reason="syllabus")
        if _RE_MATERIALS.search(lowered) and _RE_STUDENT_CONTEXT.search(lowered):
            return RouteDecision(intent="materials", tools=("get_learning_materials",), subject=subject, reason="materials")
        if _RE_SCHEDULE_GENERAL.search(lowered) and _RE_STUDENT_CONTEXT.search(lowered):
            return RouteDecision(intent="schedule_general", tools=("get_timetable",), reason="general schedule")
        if _RE_SUBJECTS.search(lowered):
            return RouteDecision(intent="subjects", tools=("get_subjects",), reason="subjects")
        if _RE_PROFILE.search(lowered):
            return RouteDecision(intent="profile", tools=("get_student_profile",), reason="profile")
        if _RE_GOALS.search(lowered):
            return RouteDecision(intent="notes_goals", tools=("get_notes", "get_goals"), reason="notes/goals")
        if _RE_EVENTS.search(lowered):
            return RouteDecision(intent="events", tools=("get_upcoming_events", "get_notifications"), reason="events")

        # 3) Current / external info — web search provides data, the local
        #    model performs the reasoning and writes the answer.
        if _RE_WEB.search(lowered) and not _RE_STUDENT_CONTEXT.search(lowered):
            return RouteDecision(intent="web_research", tools=("web_search",), reason="external current info")

        # 4) Follow-ups resolve through conversation context.
        if conversation and (len(words) <= 12) and (_RE_FOLLOWUP.search(text) or _RE_REFERENCE.search(lowered)):
            return RouteDecision(intent="knowledge", reason="follow-up uses conversation context")

        # 5) Stable concepts are answered from model knowledge.
        if _RE_CONCEPTUAL.search(text):
            return RouteDecision(intent="knowledge", reason="stable concept")

        # 6) Short unambiguous questions: model knowledge; longer/ambiguous
        #    requests go through the full autonomous agent loop.
        if len(words) <= 8 and not _RE_STUDENT_CONTEXT.search(lowered):
            return RouteDecision(intent="knowledge", reason="short question")
        return RouteDecision(intent="complex", reason="ambiguous/complex request")


# --------------------------------------------------------------------------

_QUIZ_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "maxLength": 200},
        "subject": {"type": "string", "maxLength": 100},
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}},
                    "answerIndex": {"type": "integer"},
                },
                "required": ["question", "options", "answerIndex"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "subject", "questions"],
    "additionalProperties": False,
}

_PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "maxLength": 200},
        "subject": {"type": "string", "maxLength": 100},
        "schedule": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "day": {"type": "string"},
                    "time": {"type": "string"},
                    "subject": {"type": "string"},
                    "topic": {"type": "string"},
                    "task": {"type": "string"},
                },
                "required": ["day", "topic"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "schedule"],
    "additionalProperties": False,
}


def validate_quiz_payload(payload: dict[str, Any], *, fallback_subject: str = "General") -> dict[str, Any]:
    """Validate LLM-generated quiz JSON before it reaches application services."""
    title = str(payload.get("title") or "Practice Quiz").strip()[:200] or "Practice Quiz"
    subject = str(payload.get("subject") or fallback_subject or "General").strip()[:100] or "General"
    raw_questions = payload.get("questions")
    if not isinstance(raw_questions, list):
        raise ValueError("quiz JSON has no questions array")

    questions: list[dict[str, Any]] = []
    for raw in raw_questions[:10]:
        if not isinstance(raw, dict):
            continue
        question = str(raw.get("question") or "").strip()
        options = [
            str(option).strip()
            for option in (raw.get("options") if isinstance(raw.get("options"), list) else [])
            if str(option).strip()
        ][:6]
        if not question or len(options) < 2:
            continue
        try:
            answer_index = int(raw.get("answerIndex"))
        except (TypeError, ValueError):
            continue
        if answer_index < 0 or answer_index >= len(options):
            continue
        questions.append({"question": question[:500], "options": options, "answerIndex": answer_index})
        if len(questions) >= 8:
            break

    if not questions:
        raise ValueError("no valid questions in generated quiz")
    return {"title": title, "subject": subject, "questions": questions}


def validate_plan_payload(payload: dict[str, Any], *, fallback_subject: str = "General") -> dict[str, Any]:
    title = str(payload.get("title") or "Study Plan").strip()[:200] or "Study Plan"
    subject = str(payload.get("subject") or fallback_subject or "General").strip()[:100] or "General"
    raw_schedule = payload.get("schedule")
    if not isinstance(raw_schedule, list) or not raw_schedule:
        raise ValueError("study plan JSON has no schedule array")
    schedule: list[dict[str, Any]] = []
    for item in raw_schedule[:10]:
        if not isinstance(item, dict):
            continue
        schedule.append(
            {
                "day": str(item.get("day") or f"Day {len(schedule) + 1}")[:60],
                "time": str(item.get("time") or "")[:60] or "17:00 - 18:30",
                "subject": str(item.get("subject") or subject)[:100] or subject,
                "topic": str(item.get("topic") or "Topic Review")[:200] or "Topic Review",
                "task": str(item.get("task") or "Study and practice")[:200] or "Study and practice",
            }
        )
    if not schedule:
        raise ValueError("no valid schedule items in generated study plan")
    return {"title": title, "subject": subject, "schedule": schedule}


def _format_recent_conversation(conversation: list[dict[str, str]], max_turns: int = 6) -> str:
    turns = conversation[-max_turns * 2 :]
    lines: list[str] = []
    for turn in turns:
        role = "Student" if turn.get("role") == "user" else "EduNova AI"
        lines.append(f"{role}: {str(turn.get('content', ''))[:800]}")
    return "\n".join(lines)


def _format_db_facts(state: AgentState, budget: int = 2200) -> str:
    blocks: list[str] = []
    for observation in state.observations:
        if observation.source_type not in {"database", "application"}:
            continue
        if observation.success:
            body = json.dumps(observation.observation, ensure_ascii=False, default=str)
        else:
            body = f"ERROR: {observation.error_code or 'unavailable'} - {json.dumps(observation.observation, ensure_ascii=False, default=str)[:200]}"
        blocks.append(f"[{observation.tool}] {body}")
    joined = "\n".join(blocks)
    if len(joined) > budget:
        joined = joined[:budget] + "\n…(facts trimmed)"
    return joined


def _format_web_sources(state: AgentState, budget: int = 2200) -> str:
    lines: list[str] = []
    for source in state.sources.values():
        lines.append(f"{source.id}) {source.title} — {source.snippet[:600]} ({source.domain})")
    joined = "\n".join(lines)
    if len(joined) > budget:
        joined = joined[:budget] + "\n…(sources trimmed)"
    return joined


_KNOWLEDGE_SYSTEM = """You are EduNova AI, a capable general-purpose assistant and patient tutor inside the EduNova study app.
Rules:
- Answer the student's actual question directly, accurately, and completely at the requested level.
- Use the recent conversation to resolve references like "it", "that", or "simpler".
- For educational concepts, normally include a definition, a clear explanation, and a concrete example; add key points when useful.
- For coding requests, provide complete runnable code plus a brief explanation. Never omit required closing syntax or replace code with placeholders.
- Adapt length to the task: concise for greetings and simple facts, thorough for explanations, reasoning, writing, and code.
- Do not mention token limits, timers, truncation, or ask the user to continue because of system limits.
- Do NOT invent the student's personal data (scores, timetable, deadlines). You have no access to it on this path.
- If uncertain, state the uncertainty rather than making up facts."""

_DB_SYSTEM = """You are EduNova AI, the student's personal learning assistant.
You are given EDUNOVA DATABASE FACTS retrieved from the authenticated student's own account.
Rules:
- These facts are authoritative. NEVER invent or guess timetable entries, scores, grades, dates, or attendance numbers.
- If a fact block is empty, missing, or shows an error, say plainly that the data is not in EduNova yet. Do not fill gaps with guesses.
- Phrase naturally: "According to your timetable…", "Based on your quiz history…".
- Be concise and useful: short paragraphs or compact bullet points."""

_WEB_SYSTEM = """You are EduNova AI, a research assistant for a student.
You are given CURRENT WEB RESULTS retrieved just now. The local model (you) reasons over them and writes the final answer.
Rules:
- Summarize what the sources actually say; cite each fact with its source id like [S1], [S2].
- Only cite source ids that exist in the list. Never invent sources.
- If results look thin or conflicting, say so honestly.
- End with one line: "Sources:" followed by the cited ids and titles."""


async def _run_tools(
    *,
    registry: ToolRegistry,
    tools: tuple[str, ...],
    subject: str | None,
    goal: str,
    state: AgentState,
    sources: SourceManager,
    events: EventEmitter,
    tool_context: dict[str, Any],
) -> list[Observation]:
    observations: list[Observation] = []
    argument_map: dict[str, dict[str, Any]] = {}
    if subject:
        for name in ("get_syllabus", "get_learning_materials", "get_progress", "get_quiz_history", "get_quiz_results"):
            argument_map[name] = {"subject": subject}
    # web_search requires the user's actual question as its query.
    argument_map["web_search"] = {"query": goal[:480]}
    # Preserve an explicitly requested weekday. Without this, "my Monday
    # timetable" fetched the whole week, wasting context and making the small
    # local model infer which day to display.
    weekday = re.search(
        r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
        goal,
        re.IGNORECASE,
    )
    if weekday:
        argument_map["get_timetable"] = {"day": weekday.group(1).title()}
    # External/database calls have per-tool timeouts. These protect against a
    # genuinely unavailable dependency but do not limit model generation.

    for tool_name in tools[:6]:  # fast paths stay cheap by construction
        args = argument_map.get(tool_name, {})
        await events.emit("agent.tool_selected", iteration=1, tool=tool_name)
        await events.emit("agent.tool_started", iteration=1, tool=tool_name)
        per_tool = 10.0
        try:
            observation, record = await asyncio.wait_for(
                registry.execute(tool_name, args, context=tool_context),
                timeout=per_tool,
            )
        except asyncio.TimeoutError:
            logger.warning("FAST_PATH_TOOL_TIMEOUT tool=%s after_s=%.1f", tool_name, per_tool)
            observation = Observation(
                iteration=1,
                tool=tool_name,
                source_type="database",
                observation={"error": f"TOOL_TIMEOUT: {tool_name} did not respond in time"},
                success=False,
                error_code="TOOL_TIMEOUT",
            )
            state.tool_call_count += 1
            ObservationManager.record(state, sources, observation)
            observations.append(observation)
            await events.emit("agent.tool_completed", iteration=1, tool=tool_name, success=False)
            continue
        state.tool_call_count += 1
        state.tool_history.append(record)
        if tool_name.startswith(( "get_", "create_", "save_", "update_", "mark_", "set_")):
            state.used_internal_db = True
        if tool_name in {"web_search", "open_url", "extract_webpage"}:
            state.used_web = True
        ObservationManager.record(state, sources, observation)
        observations.append(observation)
        await events.emit(
            "agent.tool_completed",
            iteration=1,
            tool=tool_name,
            success=observation.success,
        )
    return observations


def _answer_token_budget(settings: Settings, goal: str, *, base: int) -> int:
    """Choose a quality-oriented output cap from the actual task.

    This is a token ceiling, not a timer: llama.cpp normally stops at EOS. The
    budget is never reduced based on elapsed wall-clock time or measured decode
    speed. Detailed and coding tasks get enough room to finish valid output.
    """
    text = goal.lower().strip()
    words = len(text.split())
    if re.match(r"^(hi|hello|hey|thanks|thank you|ok|okay|yo|good (morning|evening|afternoon))\b", text):
        desired = 128
    elif re.search(r"\b(code|program|implement|function|class|html|css|javascript|python|java|sql|debug|algorithm)\b", text):
        desired = 1800
    elif re.search(
        r"\b(in detail|detailed|step[- ]by[- ]step|compare|comparison|essay|elaborate|"
        r"thoroughly|full|complete|multiple examples?|walk me through|teach me|summarize)\b",
        text,
    ):
        desired = 1600
    elif words <= 10:
        # Enough for a complete definition, explanation, example and key points.
        desired = 640
    else:
        desired = 1000
    return min(settings.llm_max_output_tokens, max(base, desired))


async def _generate_streaming(
    *,
    llm: Any,
    events: EventEmitter,
    system_prompt: str,
    user_prompt: str,
    max_output_tokens: int,
) -> str:
    """Generate text and emit REAL tokens as llama.cpp decodes them.

    The token callback fires on the llama.cpp worker thread, so it cannot await
    the event emitter directly. It pushes pieces onto a queue that this
    coroutine drains on the event loop, which keeps the SSE stream flowing
    during generation. This is genuine streaming: the student sees the answer
    appear token by token, and the connection carries traffic throughout
    inference so no proxy can consider it idle.

    If the LLM implementation does not support token callbacks (the external
    provider used only for emergency rollback), this degrades to a normal
    single call rather than faking a stream.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    def on_token(piece: str) -> None:
        # Called from the generation thread — hand off to the loop thread-safely.
        loop.call_soon_threadsafe(queue.put_nowait, piece)

    supports_streaming = "on_token" in inspect.signature(llm.complete_text).parameters
    kwargs: dict[str, Any] = {
        "system_prompt": system_prompt,
        "user_prompt": user_prompt,
        "max_output_tokens": max_output_tokens,
    }
    if supports_streaming:
        kwargs["on_token"] = on_token

    task = asyncio.create_task(llm.complete_text(**kwargs))
    if not supports_streaming:
        return await task

    task.add_done_callback(lambda _: loop.call_soon_threadsafe(queue.put_nowait, None))

    emitted = 0
    while True:
        piece = await queue.get()
        if piece is None:
            break
        emitted += 1
        await events.emit_token(piece)

    text = await task  # re-raises any generation error, unchanged
    logger.info("STREAMED_TOKENS pieces=%s chars=%s", emitted, len(text))
    return text


async def run_fast_path(
    *,
    settings: Settings,
    llm: Any,
    registry: ToolRegistry,
    decision: RouteDecision,
    goal: str,
    conversation: list[dict[str, str]],
    conversation_id: str,
    user_id: str,
    user_name: str,
    user_role: str = "student",
    user_email: str = "",
    application_context: dict[str, Any] | None = None,
    event_callback: EventCallback | None = None,
) -> dict[str, Any]:
    """Execute a deterministic single-generation path and return the public payload."""
    state = AgentState(
        goal=goal,
        conversation=conversation,
        user_id=user_id,
        user_role=user_role,
        user_name=user_name,
        user_email=user_email,
        application_context=application_context or {},
    )
    sources = SourceManager(state)
    events = EventEmitter(state.session_id, event_callback)
    tool_context = {
        "user_id": user_id,
        "conversation_id": conversation_id,
        "user_role": user_role,
        "user_name": user_name,
        "user_email": user_email,
    }

    await events.emit("agent.started", iteration=0)
    await events.emit("agent.goal_identified", iteration=0)
    await events.emit("agent.planning", iteration=1)
    state.iteration_count = 1

    answer = ""

    if decision.intent == "knowledge":
        # THE fast path: zero tools, zero database calls, zero web search,
        # exactly ONE local-model inference. "what is ml" must reach the model
        # this way — nothing else runs.
        convo = _format_recent_conversation(conversation)
        user_prompt = (
            (f"Recent conversation (use it to resolve any references in the question):\n{convo}\n\n" if convo else "")
            + f"Student question: {goal}"
        )
        await events.emit("agent.generating", iteration=1)
        answer = await _generate_streaming(
            llm=llm,
            events=events,
            system_prompt=_KNOWLEDGE_SYSTEM,
            user_prompt=user_prompt,
            max_output_tokens=_answer_token_budget(settings, goal, base=640),
        )
        state.used_web = False

    elif decision.intent == "web_research":
        await _run_tools(
            registry=registry,
            tools=("web_search",),
            subject=None,
            goal=goal,
            state=state,
            sources=sources,
            events=events,
            tool_context=tool_context,
        )
        search_observation = state.observations[-1] if state.observations else None
        web_ok = bool(search_observation and search_observation.success and state.sources)
        if not web_ok:
            answer = (
                "I couldn't verify current information because web search is temporarily unavailable. "
                "Please try again in a moment."
            )
        else:
            user_prompt = (
                f"Question: {goal}\n\nCURRENT WEB RESULTS (cite as [S#]):\n{_format_web_sources(state)}\n\n"
                "Write a clear, student-friendly answer about the latest developments, citing sources."
            )
            await events.emit("agent.generating", iteration=1)
            answer = await _generate_streaming(
                llm=llm,
                events=events,
                system_prompt=_WEB_SYSTEM,
                user_prompt=user_prompt,
                max_output_tokens=_answer_token_budget(settings, goal, base=560),
            )

    elif decision.intent == "action_create_quiz":
        await _run_tools(
            registry=registry,
            tools=decision.tools,
            subject=decision.subject,
            goal=goal,
            state=state,
            sources=sources,
            events=events,
            tool_context=tool_context,
        )
        db_facts = _format_db_facts(state)
        quiz_system = (
            "You generate a multiple-choice quiz as strict JSON for a student, using ONLY the class/syllabus/material "
            "context provided. If context is thin, generate general curriculum-appropriate questions for the subject. "
            "Return exactly this JSON shape: {\"title\": string, \"subject\": string, \"questions\": [{\"question\": string, "
            "\"options\": [string, string, string, string], \"answerIndex\": integer 0-based}]}. Create 5 questions. "
            "No text outside the JSON object."
        )
        quiz_user = (
            f"Request: {goal}\n\n"
            f"Class / syllabus / material context from EduNova:\n{db_facts or '(no class context found in EduNova)'}"
        )
        try:
            raw_quiz = await llm.complete_json(
                system_prompt=quiz_system,
                user_prompt=quiz_user,
                json_schema=_QUIZ_SCHEMA,
                max_output_tokens=min(max(settings.llm_max_output_tokens, 768), 1100),
            )
            quiz = validate_quiz_payload(raw_quiz, fallback_subject=decision.subject or "General")
        except Exception:
            logger.exception("QUIZ_GENERATION_FAILED")
            answer = "EduNova AI is temporarily unavailable. Please try again."
        else:
            await events.emit("agent.tool_started", iteration=2, tool="save_quiz")
            observation, record = await registry.execute(
                "save_quiz", quiz, context=tool_context
            )
            state.tool_history.append(record)
            state.used_internal_db = True
            ObservationManager.record(state, sources, observation)
            await events.emit("agent.tool_completed", iteration=2, tool="save_quiz", success=observation.success)
            preview = quiz["questions"][0]
            options_preview = "; ".join(f"{chr(65 + i)}) {o}" for i, o in enumerate(preview["options"][:4]))
            backend_error = observation.observation.get("error") if isinstance(observation.observation, dict) else None
            if (not observation.success) or backend_error:
                answer = (
                    f"I generated a {len(quiz['questions'])}-question quiz on **{quiz['subject']}**, but saving "
                    f"through EduNova failed: {str(backend_error or 'unknown error')[:140]}."
                )
            elif observation.observation.get("requiresConfirmation"):
                answer = (
                    f"I've drafted a {len(quiz['questions'])}-question quiz on **{quiz['subject']}**: "
                    f"\"{quiz['title']}\".\n\nSample question 1: {preview['question']}\n{options_preview}\n\n"
                    "Confirm below to save it to EduNova."
                )
            elif observation.success:
                answer = (
                    f"Your {len(quiz['questions'])}-question quiz on **{quiz['subject']}** (\"{quiz['title']}\") "
                    "has been saved to EduNova."
                )

    elif decision.intent == "action_study_plan":
        await _run_tools(
            registry=registry,
            tools=decision.tools,
            subject=decision.subject,
            goal=goal,
            state=state,
            sources=sources,
            events=events,
            tool_context=tool_context,
        )
        db_facts = _format_db_facts(state)
        plan_system = (
            "You design a realistic study plan as strict JSON, using the student's exams/progress/syllabus context. "
            "Return exactly: {\"title\": string, \"subject\": string, \"schedule\": [{\"day\": string, \"time\": string, "
            "\"subject\": string, \"topic\": string, \"task\": string}]}. 4-7 day-by-day items. No text outside JSON."
        )
        plan_user = f"Request: {goal}\n\nStudent context from EduNova:\n{db_facts or '(no exam/progress context found)'}"
        try:
            raw_plan = await llm.complete_json(
                system_prompt=plan_system,
                user_prompt=plan_user,
                json_schema=_PLAN_SCHEMA,
                max_output_tokens=min(max(settings.llm_max_output_tokens, 700), 1000),
            )
            plan = validate_plan_payload(raw_plan, fallback_subject=decision.subject or "General")
        except Exception:
            logger.exception("STUDY_PLAN_GENERATION_FAILED")
            answer = "EduNova AI is temporarily unavailable. Please try again."
        else:
            await events.emit("agent.tool_started", iteration=2, tool="create_study_plan")
            observation, record = await registry.execute(
                "create_study_plan", plan, context=tool_context
            )
            state.tool_history.append(record)
            state.used_internal_db = True
            ObservationManager.record(state, sources, observation)
            await events.emit("agent.tool_completed", iteration=2, tool="create_study_plan", success=observation.success)
            plan_backend_error = observation.observation.get("error") if isinstance(observation.observation, dict) else None
            if (not observation.success) or plan_backend_error:
                answer = (
                    f"I generated a study plan but saving through EduNova failed: "
                    f"{str(plan_backend_error or 'unknown error')[:140]}."
                )
            elif observation.observation.get("requiresConfirmation"):
                first = plan["schedule"][0]
                answer = (
                    f"I've prepared a {len(plan['schedule'])}-day study plan: \"{plan['title']}\".\n"
                    f"It starts with **{first['day']}**: {first['topic']} ({first['task']}).\n\n"
                    "Confirm below to save it to EduNova."
                )
            else:
                answer = f"Your study plan \"{plan['title']}\" ({len(plan['schedule'])} days) has been saved to EduNova."


    else:  # student data retrieval + synthesis
        await _run_tools(
            registry=registry,
            tools=decision.tools,
            subject=decision.subject,
            goal=goal,
            state=state,
            sources=sources,
            events=events,
            tool_context=tool_context,
        )
        convo = _format_recent_conversation(conversation, max_turns=3)
        user_prompt = (
            f"Question: {goal}\n\n"
            f"EDUNOVA DATABASE FACTS (authoritative; never invent beyond these):\n{_format_db_facts(state) or '(no facts returned)'}\n\n"
            + (f"Recent conversation:\n{convo}\n\n" if convo else "")
            + "Now answer the question using only these facts."
        )
        await events.emit("agent.generating", iteration=1)
        answer = await _generate_streaming(
            llm=llm,
            events=events,
            system_prompt=_DB_SYSTEM,
            user_prompt=user_prompt,
            max_output_tokens=_answer_token_budget(settings, goal, base=600),
        )

    state.final_answer = answer.strip()
    state.goal_completed = True
    await events.emit("agent.response_generated", iteration=state.iteration_count)
    await events.emit("agent.goal_completed", iteration=state.iteration_count, confidence=state.confidence)

    result = AgentResult(
        success=True,
        message=sources.enforce_integrity(state.final_answer),
        sources=sources.public_sources(state.final_answer),
        internal_sources=state.internal_sources,
        actions=state.executed_actions,
        used_web=state.used_web,
        used_internal_db=state.used_internal_db,
        agent_status="completed",
        conversation_id=conversation_id,
        limit_reached=False,
    )
    payload = result.public()
    logger.info(
        "FAST_PATH intent=%s tools=%s used_web=%s used_db=%s tools_used=%s",
        decision.intent,
        ",".join(decision.tools) or "-",
        payload.get("usedWeb"),
        payload.get("usedInternalDb"),
        state.tool_call_count,
    )
    return payload
