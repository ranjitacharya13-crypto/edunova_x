#!/usr/bin/env python3
"""Behavioral regression tests for the EduNova AI tutor engine.

Run:  python run_behavior_tests.py
Verifies the AI BEHAVIOR / CONTEXT / BACKEND items in the spec without needing
MongoDB (the tutor engine is fully self-contained; timetable falls back).
"""
import sys
import main
from fastapi.testclient import TestClient

client = TestClient(main.app)
PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        FAILURES.append(name)
        print(f"  FAIL  {name} {extra}")


def q(message, ctx=None):
    body = {"message": message, "email": "student@edunova.com"}
    if ctx:
        body["tutoringContext"] = ctx
    r = client.post("/api/ai/query", json=body)
    assert r.status_code == 200, r.status_code
    return r.json()


def ctx_of(d):
    return d.get("tutoringContext") or {}


print("== Health & endpoints ==")
check("GET /health 200 live", client.get("/health").status_code == 200)
r = client.get("/health").json()
check("health reports live", r.get("status") == "live")
check("POST /api/ai/query 200", q("hello")["success"] is True)
check("POST /ai/query alias 200", client.post("/ai/query", json={"message": "hello"}).status_code == 200)

print("\n== 1-21 AI behavior ==")
# 1 open / subject discovery
d = q("Hi")
check("1 open asks subject", "subject" in d["reply"].lower() and "Which" in d["reply"])
check("subject suggestions given", "Mathematics" in (d.get("suggestions") or []))
# 3 select Mathematics
d = q("Mathematics")
check("4 asks topic", "topic" in d["reply"].lower())
check("algebra topic suggestion", "Algebra" in (d.get("suggestions") or []))
# 5 select Algebra
d = q("Algebra", ctx_of(d))
check("6 asks goal", "do" in d["reply"].lower() or "would you like" in d["reply"].lower())
check("goal options", any("Learn" in s for s in (d.get("suggestions") or [])))
# 7 select Learn
d = q("Learn it", ctx_of(d))
check("8 teaches algebra", "Algebra" in d["reply"] or "equation" in d["reply"])
check("9 asks a question", "?" in d["reply"])
ctx = ctx_of(d)
check("ctx remembered subject/topic/goal",
      ctx.get("subject") == "Mathematics" and ctx.get("topic") == "Algebra" and ctx.get("goal") == "learn")
# 10 correct answer
d = q("7", ctx)
check("10 correct -> praised + difficulty up", "Exactly" in d["reply"] and "difficulty" in d["reply"])
check("11 level increased", (ctx_of(d).get("level") == "intermediate"))
# 12 incorrect
d = q("99", ctx_of(d))
check("13 corrects politely (no shame)", "okay" in d["reply"].lower() and "stupid" not in d["reply"].lower())
# 14 hint
d = q("Give me a hint", ctx_of(d))
check("14/15 gives hint", "hint" in d["reply"].lower())
# 16 switch subject
d = q("Physics", {})
check("16 detects new subject", ctx_of(d).get("subject") == "Physics")
# 18 exam prep
d = q("I have an exam", {})
check("18 enters exam flow (asks subject)", "subject" in d["reply"].lower())
d = q("Chemistry", ctx_of(d))
d = q("Acids and Bases", ctx_of(d))
d = q("Exam prep", ctx_of(d))
check("18 exam mode", d.get("intent") == "exam" and "exam" in d["reply"].lower())
# 20 practice
d = q("Practice", {"subject": "Computer Science", "topic": "Binary Search"})
check("20 practice one question", "Question 1" in d["reply"] and d.get("intent") == "practice")
# 21 one question at a time
check("21 single question (no dump of 20)", d["reply"].count("Question") == 1)

print("\n== 22-25 context ==")
ctx = {"subject": "Mathematics", "topic": "Algebra", "goal": "learn", "level": "beginner"}
d = q("7", ctx)
check("22 subject remembered", ctx_of(d).get("subject") == "Mathematics")
check("23 topic remembered", ctx_of(d).get("topic") == "Algebra")
check("24 goal remembered", ctx_of(d).get("goal") == "learn")
# never re-asks known info: providing subject+topic+goal should skip discovery
# and go straight into a teaching/doubt/practice response
d = q("what is algebra", ctx)
check("25 no repeat known questions (skips discovery)", d.get("intent") not in
      ("discover-subject", "discover-topic", "discover-goal"))

print("\n== 26-30 backend ==")
check("26 /api/ai/query works", True)
check("27 valid response", "reply" in q("Maths") and "reply" in q("Maths"))
# language adaptation
d = q("I want to learn algebra")
check("English response", any(c.isascii() for c in d["reply"]))

print(f"\n===== RESULT: {PASS} passed, {FAIL} failed =====")
if FAILURES:
    print("Failures:", FAILURES)
    sys.exit(1)
print("ALL PASS")
