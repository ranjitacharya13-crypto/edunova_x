#!/usr/bin/env python3
"""Authenticated production smoke test for the real EduNova AI SSE pipeline.

Uses the documented demo student account, never prints its JWT, and records
TTFT/total time plus the model's own token metrics from authenticated health.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("API_URL", "https://edunova-api-y3rx.onrender.com/api").rstrip("/")
# Split literals so production-source scans can prove none of the banned UI
# messages exist while the smoke test still rejects them at runtime.
FORBIDDEN = (
    "answer " + "shortened",
    "ask me to " + "continue",
    "response time " + "limit",
    "response " + "truncated",
)


def request_json(path: str, *, token: str | None = None, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(API + path, data=data, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.load(response)


def stream_chat(token: str, message: str, conversation_id: str | None) -> dict:
    payload = {"message": message, "conversationId": conversation_id}
    request = urllib.request.Request(
        API + "/ai/chat",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    started = time.monotonic()
    first_token = None
    final = None
    with urllib.request.urlopen(request, timeout=600) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            event = json.loads(line[5:].strip())
            if event.get("type") == "token" and first_token is None:
                first_token = time.monotonic()
            if event.get("type") == "error":
                raise RuntimeError(event.get("message") or "AI stream error")
            if event.get("type") == "answer":
                final = event
    ended = time.monotonic()
    if not final:
        raise RuntimeError("stream ended without a terminal answer event")
    answer = str(final.get("message") or final.get("reply") or "").strip()
    if not answer:
        raise RuntimeError("terminal answer was empty")
    if any(phrase in answer.lower() for phrase in FORBIDDEN):
        raise RuntimeError("answer contained a forbidden truncation marker")
    return {
        "prompt": message,
        "answer": answer,
        "conversationId": final.get("conversationId"),
        "ttftMs": int(((first_token or ended) - started) * 1000),
        "totalMs": int((ended - started) * 1000),
        "responseChars": len(answer),
        "usedWeb": bool(final.get("usedWeb")),
        "usedInternalDb": bool(final.get("usedInternalDb")),
    }


def main() -> int:
    try:
        login = request_json(
            "/auth/login",
            body={"email": "student@edunova.com", "password": "123456"},
        )
    except urllib.error.HTTPError as exc:
        print(f"Demo login failed with HTTP {exc.code}; live authenticated smoke test cannot run.", file=sys.stderr)
        return 2
    token = login.get("token")
    if not token:
        raise RuntimeError("login returned no token")

    prompts = [
        "hello",
        "what is ML?",
        "Explain it like I'm 10.",
        "Give me a real-world example.",
        "What is my Monday timetable?",
        "What is my weakest subject?",
        "What should I study today?",
        "What are the latest AI developments?",
        "Write a Python program for binary search.",
    ]
    conversation_id = None
    results = []
    for prompt in prompts:
        result = stream_chat(token, prompt, conversation_id)
        conversation_id = result["conversationId"] or conversation_id
        print(json.dumps({key: value for key, value in result.items() if key != "conversationId"}, ensure_ascii=False))
        results.append(result)

    ml = results[1]
    if ml["responseChars"] < 120:
        raise RuntimeError(f"ML answer is too short to be useful ({ml['responseChars']} chars)")
    if "machine learning" not in ml["answer"].lower():
        raise RuntimeError("ML answer did not explain Machine Learning")
    code = results[-1]["answer"].lower()
    if "def " not in code or "binary" not in code:
        raise RuntimeError("binary-search response did not contain complete Python code")
    if not results[7]["usedWeb"]:
        raise RuntimeError("latest-AI request did not route through web search")

    health = request_json("/ai/health", token=token)
    report = {
        "passed": True,
        "tests": len(results),
        "ml": {key: ml[key] for key in ("ttftMs", "totalMs", "responseChars", "answer")},
        "lastGeneration": (health.get("model") or {}).get("lastGeneration"),
        "model": (health.get("model") or {}).get("modelId"),
        "contextSize": (health.get("model") or {}).get("contextSize"),
        "threads": (health.get("model") or {}).get("threads"),
    }
    with open("live-ai-report.json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False)
    print("LIVE_AI_SMOKE_PASS")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
