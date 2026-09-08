"""Backend-owned schema validation. Never blindly trust model JSON."""

from __future__ import annotations

from typing import Any

QUIZ_TYPES = {"mcq", "true_false", "fill_blank", "short_answer", "long_answer"}
DIFFICULTIES = {"easy", "medium", "hard", "mixed"}


class ValidationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def validate_quiz(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValidationError("INVALID_QUIZ_OUTPUT", "Quiz must be an object")
    title = str(payload.get("title") or "").strip()
    questions = payload.get("questions")
    if not title or not isinstance(questions, list) or not 1 <= len(questions) <= 20:
        raise ValidationError("INVALID_QUIZ_OUTPUT", "Quiz requires a title and 1-20 questions")
    difficulty = str(payload.get("difficulty") or "medium").lower()
    if difficulty not in DIFFICULTIES:
        raise ValidationError("INVALID_QUIZ_OUTPUT", "Invalid difficulty")
    clean = []
    seen = set()
    for item in questions:
        if not isinstance(item, dict):
            raise ValidationError("INVALID_QUIZ_OUTPUT", "Each question must be an object")
        qtype = str(item.get("type") or "mcq").lower()
        if qtype not in QUIZ_TYPES:
            raise ValidationError("INVALID_QUIZ_OUTPUT", f"Unsupported question type {qtype}")
        question = str(item.get("question") or "").strip()
        if not question or question.lower() in seen:
            raise ValidationError("INVALID_QUIZ_OUTPUT", "Questions must be nonempty and unique")
        seen.add(question.lower())
        record: dict[str, Any] = {"type": qtype, "question": question[:1000]}
        if qtype == "mcq":
            options = item.get("options")
            if not isinstance(options, list) or not 2 <= len(options) <= 6:
                raise ValidationError("INVALID_QUIZ_OUTPUT", "MCQ needs 2-6 options")
            options = [str(o).strip()[:500] for o in options]
            if any(not o for o in options) or len(set(o.lower() for o in options)) != len(options):
                raise ValidationError("INVALID_QUIZ_OUTPUT", "MCQ options must be distinct")
            answer = item.get("answer")
            if isinstance(answer, int):
                if not 0 <= answer < len(options):
                    raise ValidationError("INVALID_QUIZ_OUTPUT", "MCQ answer index out of range")
                record["answer"] = options[answer]
                record["answerIndex"] = answer
            else:
                answer_s = str(answer or "").strip()
                if answer_s not in options:
                    raise ValidationError("INVALID_QUIZ_OUTPUT", "MCQ answer must match an option")
                record["answer"] = answer_s
                record["answerIndex"] = options.index(answer_s)
            record["options"] = options
        elif qtype == "true_false":
            answer = str(item.get("answer") or "").strip().lower()
            if answer not in {"true", "false"}:
                raise ValidationError("INVALID_QUIZ_OUTPUT", "True/False answer must be true or false")
            record["answer"] = answer
        else:
            record["answer"] = str(item.get("answer") or "").strip()[:2000]
        if item.get("explanation"):
            record["explanation"] = str(item["explanation"])[:2000]
        clean.append(record)
    return {
        "type": "QUIZ",
        "title": title[:200],
        "subject": str(payload.get("subject") or "General")[:100],
        "difficulty": difficulty,
        "questions": clean,
    }


def validate_study_plan(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValidationError("INVALID_PLAN_OUTPUT", "Study plan must be an object")
    title = str(payload.get("title") or "").strip()
    schedule = payload.get("schedule") or payload.get("days") or payload.get("items")
    if not title or not isinstance(schedule, list) or not 1 <= len(schedule) <= 30:
        raise ValidationError("INVALID_PLAN_OUTPUT", "Study plan requires a title and 1-30 sessions")
    items = []
    for row in schedule:
        if not isinstance(row, dict):
            raise ValidationError("INVALID_PLAN_OUTPUT", "Each session must be an object")
        day = str(row.get("day") or "").strip()
        topic = str(row.get("topic") or "").strip()
        task = str(row.get("task") or row.get("activity") or "").strip()
        subject = str(row.get("subject") or payload.get("subject") or "General").strip()
        time = str(row.get("time") or "flexible").strip()
        if not day or not topic or not task:
            raise ValidationError("INVALID_PLAN_OUTPUT", "Each session needs day, topic and task")
        items.append({"day": day[:80], "time": time[:40], "subject": subject[:100], "topic": topic[:200], "task": task[:500]})
    return {"type": "STUDY_PLAN", "title": title[:200], "subject": str(payload.get("subject") or "General")[:100], "schedule": items}


def validate_ar_scene(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValidationError("INVALID_AR_OUTPUT", "AR scene must be an object")
    topic = str(payload.get("topic") or payload.get("title") or "").strip()
    objects = payload.get("objects")
    if not topic or not isinstance(objects, list) or not 1 <= len(objects) <= 24:
        raise ValidationError("INVALID_AR_OUTPUT", "AR scene requires a topic and 1-24 objects")
    names = []
    clean_objects = []
    for obj in objects:
        if not isinstance(obj, dict):
            raise ValidationError("INVALID_AR_OUTPUT", "Each AR object must be an object")
        name = str(obj.get("name") or "").strip()
        if not name:
            raise ValidationError("INVALID_AR_OUTPUT", "AR object needs a name")
        pos = obj.get("position") or [0, 0, 0]
        if not (isinstance(pos, list) and len(pos) == 3):
            raise ValidationError("INVALID_AR_OUTPUT", "AR position must be [x,y,z]")
        try:
            pos = [float(pos[0]), float(pos[1]), float(pos[2])]
        except (TypeError, ValueError) as exc:
            raise ValidationError("INVALID_AR_OUTPUT", "AR position values must be numeric") from exc
        names.append(name)
        clean_objects.append({"name": name[:80], "position": pos, "description": str(obj.get("description") or "")[:500]})
    connections = []
    for conn in payload.get("connections") or []:
        if not isinstance(conn, dict):
            continue
        src, dst = str(conn.get("from") or ""), str(conn.get("to") or "")
        if src in names and dst in names:
            connections.append({"from": src, "to": dst})
    allowed_interactions = {"tap_to_explain", "rotate", "zoom", "highlight", "explode"}
    interactions = [i for i in (payload.get("interactions") or ["tap_to_explain", "rotate", "zoom"]) if i in allowed_interactions]
    return {
        "type": "AR_SCENE",
        "topic": topic[:200],
        "objects": clean_objects,
        "connections": connections,
        "interactions": interactions or ["tap_to_explain"],
    }
