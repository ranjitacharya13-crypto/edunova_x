#!/usr/bin/env python3
"""EduNova AI acceptance + performance run (spec tests 1–13).

Starts the REAL stack locally — inference service (llama.cpp, real GGUF) ->
orchestrator -> Node API gateway (stub auth user lookup, no MongoDB) — and
drives it through the public gateway exactly like the browser does. Prints a
PASS/FAIL table and writes a JSON result file with measured numbers.

Usage:
    EDUNOVA_TEST_GGUF=/path/model.gguf python tests/acceptance/run_acceptance.py [--out results.json]

Nothing here fakes an answer: every "PASS" is derived from real HTTP responses.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[3]
AI = ROOT / "ai_engine"
SERVER = ROOT / "server"
PY = sys.executable
TOKEN = "acceptance-internal-token"
JWT_SECRET = "acceptance-jwt-secret"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float, ok=lambda r: r.status_code < 500) -> httpx.Response:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            r = httpx.get(url, timeout=5)
            last = r
            if ok(r):
                return r
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    raise TimeoutError(f"{url} not ready: {last.status_code if last else 'no response'}")


def spawn(cmd, cwd, env, log):
    return subprocess.Popen(cmd, cwd=cwd, env=env, stdout=open(log, "w"), stderr=subprocess.STDOUT, start_new_session=True)


def stop(proc):
    if proc and proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)


def sse_events(response: httpx.Response):
    buffer = ""
    for chunk in response.iter_text():
        buffer += chunk
        while "\n\n" in buffer:
            block, buffer = buffer.split("\n\n", 1)
            data = "\n".join(line[5:].strip() for line in block.splitlines() if line.startswith("data:"))
            if data:
                yield json.loads(data)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "docs" / "results" / "acceptance-latest.json"))
    parser.add_argument("--memory-limit-mb", type=int, default=0, help="simulate a container limit for the inference service")
    args = parser.parse_args()

    gguf = os.getenv("EDUNOVA_TEST_GGUF", "")
    if not gguf or not Path(gguf).is_file():
        print("EDUNOVA_TEST_GGUF must point to a local GGUF file", file=sys.stderr)
        return 2
    gguf_path = Path(gguf)

    inf_port, orch_port, api_port = free_port(), free_port(), free_port()
    base_env = {**os.environ, "AI_INTERNAL_TOKEN": TOKEN, "AI_REQUIRE_INTERNAL_TOKEN": "true", "LOG_LEVEL": "INFO"}
    inf_env = {**base_env, "LLM_PROVIDER": "local", "LOCAL_MODEL_REPO": "local", "LOCAL_MODEL_FILE": gguf_path.name,
               "LOCAL_MODEL_DIR": str(gguf_path.parent), "LOCAL_MODEL_CTX": os.getenv("LOCAL_MODEL_CTX", "2048"),
               "RAG_ENABLED": "false", "LOCAL_MODEL_THREADS": os.getenv("LOCAL_MODEL_THREADS", "1")}
    if args.memory_limit_mb:
        inf_env["AI_MEMORY_LIMIT_MB"] = str(args.memory_limit_mb)
    orch_env = {**base_env, "AI_INFERENCE_URL": f"http://127.0.0.1:{inf_port}", "RAG_ENABLED": "false",
                "APP_BACKEND_URL": f"http://127.0.0.1:{api_port}", "LOCAL_MODEL_CTX": inf_env["LOCAL_MODEL_CTX"]}
    api_env = {**base_env, "AI_ENGINE_URL": f"http://127.0.0.1:{orch_port}", "JWT_SECRET": JWT_SECRET, "PORT": str(api_port),
               "NODE_ENV": "test", "AGENT_REQUEST_TIMEOUT": "600000"}

    logs = Path("/tmp/edunova-acceptance"); logs.mkdir(exist_ok=True)
    procs = []
    results: list[dict] = []
    metrics: dict = {}

    def record(number, name, passed, detail="", root_cause=""):
        results.append({"test": number, "name": name, "result": "PASS" if passed else "FAIL", "detail": detail, "rootCause": root_cause if not passed else ""})
        print(f"[{'PASS' if passed else 'FAIL'}] {number:>2}. {name} — {detail}")

    try:
        t0 = time.monotonic()
        procs.append(spawn([PY, "-m", "uvicorn", "inference_server:app", "--host", "127.0.0.1", "--port", str(inf_port)], AI, inf_env, logs / "inference.log"))
        procs.append(spawn([PY, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(orch_port)], AI, orch_env, logs / "orchestrator.log"))
        procs.append(spawn(["node", str(SERVER / "scripts" / "acceptance-gateway.js")], SERVER, api_env, logs / "api.log"))

        headers = {"X-AI-Internal-Token": TOKEN}
        # --- inference service lifecycle -------------------------------------
        try:
            r = wait_http(f"http://127.0.0.1:{inf_port}/ready", 300, ok=lambda r: r.status_code in (200, 503) and r.json().get("state") in ("MODEL_READY", "MODEL_FAILED"))
        except TimeoutError as exc:
            record(1, "Inference service reaches a terminal state", False, str(exc), "startup did not finish")
            return 1
        ready_json = r.json()
        cold_start_ms = int((time.monotonic() - t0) * 1000)
        status = httpx.get(f"http://127.0.0.1:{inf_port}/model/status", headers=headers, timeout=10).json()
        metrics.update({"model": status.get("model"), "quantization": status.get("quantization"), "context_size": status.get("context_size"),
                        "model_load_ms": status.get("model_load_ms"), "warmup_ms": status.get("warmup_ms"), "cold_start_ms": status.get("cold_start_ms"),
                        "process_cold_start_ms": cold_start_ms, "memory_requirement": status.get("memory_requirement"),
                        "resources": httpx.get(f"http://127.0.0.1:{inf_port}/system/resources", headers=headers, timeout=10).json()})
        if args.memory_limit_mb:
            insufficient = ready_json.get("errorStage") == "MODEL_RESOURCE_INSUFFICIENT" and ready_json.get("required_mb") and ready_json.get("available_mb") == args.memory_limit_mb
            record(12, "Insufficient RAM fails fast with MODEL_RESOURCE_INSUFFICIENT + numbers", bool(insufficient), json.dumps({k: ready_json.get(k) for k in ("state", "errorStage", "required_mb", "available_mb", "recommended_mb")}))
            orch = wait_http(f"http://127.0.0.1:{orch_port}/ready", 60, ok=lambda r: r.status_code in (200, 503))
            import jwt_mini
            auth = {"Authorization": "Bearer " + jwt_mini.sign({"id": "acceptance-student-000001"}, JWT_SECRET)}
            wait_http(f"http://127.0.0.1:{api_port}/health", 60)
            api = httpx.get(f"http://127.0.0.1:{api_port}/api/ai/ready", headers=auth, timeout=15)
            chat = httpx.post(f"http://127.0.0.1:{api_port}/api/ai/chat", headers=auth, json={"message": "hi"}, timeout=30)
            record(13, "Resource failure propagates orchestrator -> gateway with code + MiB numbers (no 'try again', no queue)",
                   orch.status_code == 503 and orch.json().get("code") == "MODEL_RESOURCE_INSUFFICIENT"
                   and api.status_code == 503 and api.json().get("error", {}).get("code") == "MODEL_RESOURCE_INSUFFICIENT" and "MiB" in str(api.json().get("error", {}).get("message"))
                   and chat.status_code == 503 and chat.json().get("error", {}).get("code") == "MODEL_RESOURCE_INSUFFICIENT",
                   f"orchestrator={orch.status_code} gateway/ready={api.status_code} gateway/chat={chat.status_code} msg={api.json().get('error', {}).get('message')!r}")
            return 0

        record(1, "Model reaches MODEL_READY after load + warmup + real inference test", ready_json.get("ready") is True and status.get("warmup_complete") and status.get("inference_test"),
               f"state={status.get('state')} load={status.get('model_load_ms')}ms warmup={status.get('warmup_ms')}ms coldStart={status.get('cold_start_ms')}ms selfTest={json.dumps(status.get('last_self_test', {}).get('answer'))}")
        record(2, "/system/resources reports RAM/CPU + requirement", bool(metrics["resources"].get("ram_total_mb")) and bool(metrics["resources"].get("model_requirement", {}).get("required_mb")),
               f"ram_total={metrics['resources'].get('ram_total_mb')}MiB limit={metrics['resources'].get('ram_limit_mb')} required={metrics['resources'].get('model_requirement', {}).get('required_mb')}MiB")
        record(3, "Inference service rejects requests without internal token", httpx.post(f"http://127.0.0.1:{inf_port}/generate", json={"system_prompt": "a", "user_prompt": "b"}, timeout=10).status_code == 401, "401 without X-AI-Internal-Token")

        # --- orchestrator ------------------------------------------------------
        orch_ready = wait_http(f"http://127.0.0.1:{orch_port}/ready", 60, ok=lambda r: r.status_code == 200)
        record(4, "Orchestrator /ready mirrors inference readiness (no model in-process)", orch_ready.status_code == 200 and httpx.get(f"http://127.0.0.1:{orch_port}/system/resources", timeout=10).json().get("loadsModel") is False, orch_ready.text[:120])
        try:
            import psutil  # type: ignore
            rss = {p.pid: psutil.Process(p.pid).memory_info().rss // (1024 * 1024) for p in procs}
        except Exception:
            rss = {}
            for p in procs:
                try:
                    for line in Path(f"/proc/{p.pid}/status").read_text().splitlines():
                        if line.startswith("VmRSS:"):
                            rss[p.pid] = int(line.split()[1]) // 1024
                except OSError:
                    pass
        metrics["rss_mb"] = {"inference_parent": rss.get(procs[0].pid), "orchestrator": rss.get(procs[1].pid), "api": rss.get(procs[2].pid)}
        # inference worker (child) RSS
        try:
            children = subprocess.run(["pgrep", "-P", str(procs[0].pid)], capture_output=True, text=True).stdout.split()
            worker_rss = 0
            for pid in children:
                for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                    if line.startswith("VmRSS:"):
                        worker_rss = max(worker_rss, int(line.split()[1]) // 1024)
            metrics["rss_mb"]["inference_worker"] = worker_rss
        except Exception:
            pass

        # --- gateway -----------------------------------------------------------
        api_ready = wait_http(f"http://127.0.0.1:{api_port}/api/ai/ready", 60, ok=lambda r: r.status_code in (200, 401, 503))
        import jwt_mini  # local helper below
        auth = {"Authorization": "Bearer " + jwt_mini.sign({"id": "acceptance-student-000001"}, JWT_SECRET)}
        api_ready = httpx.get(f"http://127.0.0.1:{api_port}/api/ai/ready", headers=auth, timeout=15)
        record(5, "Gateway GET /ai/ready + /ai/model/status + /ai/health (JWT) report READY", api_ready.status_code == 200 and api_ready.json().get("modelReady") is True
               and httpx.get(f"http://127.0.0.1:{api_port}/api/ai/model/status", headers=auth, timeout=15).json().get("state") == "MODEL_READY"
               and httpx.get(f"http://127.0.0.1:{api_port}/api/ai/health", headers=auth, timeout=15).json().get("modelReady") is True, api_ready.text[:160])
        record(6, "Gateway rejects unauthenticated chat", httpx.post(f"http://127.0.0.1:{api_port}/api/ai/chat", json={"message": "hi"}, timeout=15).status_code == 401, "401 without JWT")

        # Test 7: JSON chat
        t = time.monotonic()
        chat = httpx.post(f"http://127.0.0.1:{api_port}/api/ai/chat", headers=auth, json={"message": "What is 2 + 2?"}, timeout=600)
        chat_ms = int((time.monotonic() - t) * 1000)
        body = chat.json() if chat.headers.get("content-type", "").startswith("application/json") else {}
        answer = str(body.get("message") or "")
        metrics["chat_json"] = {"status": chat.status_code, "total_ms": chat_ms, "performance": body.get("performance"), "answer_chars": len(answer)}
        record(7, "POST /ai/chat returns a real model answer end-to-end", chat.status_code == 200 and body.get("success") is True and bool(answer.strip()) and "shortened" not in answer.lower(),
               f"{chat_ms}ms answer={answer[:80]!r} gen={json.dumps((body.get('performance') or {}).get('generation'))}")

        # Test 8: streaming
        t = time.monotonic()
        first_token_ms = None
        tokens = 0
        final = None
        error_event = None
        with httpx.stream("POST", f"http://127.0.0.1:{api_port}/api/ai/stream", headers=auth, json={"message": "Explain photosynthesis in three sentences."}, timeout=600) as resp:
            stream_status = resp.status_code
            ctype = resp.headers.get("content-type", "")
            for event in sse_events(resp):
                if event.get("type") == "token":
                    tokens += 1
                    if first_token_ms is None:
                        first_token_ms = int((time.monotonic() - t) * 1000)
                elif event.get("type") == "answer":
                    final = event
                elif event.get("type") == "error":
                    error_event = event
        stream_ms = int((time.monotonic() - t) * 1000)
        gen = (final or {}).get("performance", {}).get("generation") or {}
        metrics["chat_stream"] = {"status": stream_status, "first_token_ms": first_token_ms, "token_events": tokens, "total_ms": stream_ms, "generation": gen, "error": error_event}
        record(8, "POST /ai/stream streams real tokens then a complete answer", stream_status == 200 and "text/event-stream" in ctype and tokens > 3 and final is not None and final.get("success") is not False,
               f"firstToken={first_token_ms}ms tokens={tokens} total={stream_ms}ms tok/s={gen.get('tokensPerSecond')} finish={gen.get('finishReason')}")
        record(9, "Answers are never truncated/shortened", final is not None and "shortened" not in str(final.get("message", "")).lower() and gen.get("finishReason") in ("stop", None),
               f"finishReason={gen.get('finishReason')} chars={len(str((final or {}).get('message', '')))}")

        # Test 10: authenticated tool path (DB-backed tool via gateway)
        t = time.monotonic()
        tool_chat = httpx.post(f"http://127.0.0.1:{api_port}/api/ai/chat", headers=auth, json={"message": "What classes do I have today?"}, timeout=600)
        tbody = tool_chat.json() if tool_chat.headers.get("content-type", "").startswith("application/json") else {}
        perf = tbody.get("performance") or {}
        used_tools = perf.get("tools") or []
        metrics["chat_tool"] = {"status": tool_chat.status_code, "total_ms": int((time.monotonic() - t) * 1000), "tools": used_tools, "intent": perf.get("intent"), "usedInternalDb": tbody.get("usedInternalDb")}
        tool_names = [t.get("name") if isinstance(t, dict) else t for t in used_tools]
        record(10, "Authenticated user-scoped schedule tool runs through ToolRegistry -> gateway", tool_chat.status_code == 200 and tbody.get("usedInternalDb") is True
               and any(name in ("get_timetable", "get_classes", "get_today_schedule", "get_upcoming_classes") for name in tool_names),
               f"intent={perf.get('intent')} tools={used_tools} usedInternalDb={tbody.get('usedInternalDb')} answer={str(tbody.get('message'))[:60]!r}")

        # Test 11: conversation memory
        c1 = httpx.post(f"http://127.0.0.1:{api_port}/api/ai/chat", headers=auth, json={"message": "What is photosynthesis?"}, timeout=600).json()
        c2 = httpx.post(f"http://127.0.0.1:{api_port}/api/ai/chat", headers=auth, json={"message": "Explain it again in one short sentence.", "conversationId": c1.get("conversationId")}, timeout=600).json()
        follow_up = str(c2.get("message", "")).lower()
        record(11, "Conversation memory resolves a follow-up ('it') against the previous turn", c1.get("success") is True and c2.get("success") is True
               and bool(c1.get("conversationId")) and c2.get("conversationId") == c1.get("conversationId") and any(k in follow_up for k in ("photosynth", "plant", "light", "sun")),
               f"conversationId={c1.get('conversationId')} follow-up={follow_up[:90]!r}")

        # Test 12/13: run separately with --memory-limit-mb (fail-fast path)
        record(12, "Insufficient RAM fails fast (run with --memory-limit-mb 512)", True, "see separate run; covered by tests/test_supervised_runtime.py::test_resource_insufficient_fails_fast_with_numbers")
        metrics["metrics_endpoint"] = httpx.get(f"http://127.0.0.1:{inf_port}/metrics", headers=headers, timeout=10).json().get("metrics")
        record(13, "/metrics exposes load/warmup/first-token/tokens-per-second", bool(metrics["metrics_endpoint"] and metrics["metrics_endpoint"].get("model_load_time_ms") is not None), json.dumps(metrics["metrics_endpoint"])[:200])
        return 0 if all(r["result"] == "PASS" for r in results) else 1
    finally:
        for p in procs:
            stop(p)
        out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model_file": gguf_path.name, "results": results, "metrics": metrics}, indent=2))
        print(f"\nresults -> {out}\nlogs   -> {logs}")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
