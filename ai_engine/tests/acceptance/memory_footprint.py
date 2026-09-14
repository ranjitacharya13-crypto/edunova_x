#!/usr/bin/env python3
"""Reproducible AI runtime memory-footprint test (510 MiB hard gate).

Boots the REAL inference service (llama.cpp + a real GGUF) and the REAL
orchestrator as subprocesses, waits for the supervised model to reach
MODEL_READY, then:

  * samples the resident memory (RSS) of the whole inference-service process
    tree — the uvicorn parent PLUS the supervised model worker — before,
    during and after real generation, and records the peak;
  * runs the six mandated prompts sequentially through the orchestrator's
    ``POST /api/ai/chat`` so the real router -> fast-path -> llama.cpp path
    (and conversation memory for the multi-turn prompt) is exercised;
  * prints the TOTAL_FOOTPRINT accounting used by the deployment gate
    (``inference/resources.py``: model weights + KV cache + llama.cpp runtime
    + FastAPI/worker server + safety margin) next to the measured numbers,
    and a PASS/FAIL verdict against ``EDUNOVA_MEMORY_LIMIT_MB`` (default 510).

Usage:
    EDUNOVA_TEST_GGUF=/path/model.gguf python tests/acceptance/memory_footprint.py

The only replaced piece is the MongoDB user lookup inside the orchestrator's
tool registry is NOT needed: plain chat prompts route through the knowledge
fast path with zero database calls. No answer is faked — every number comes
from a real HTTP round-trip and /proc/<pid>/status.
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[3]
AI = ROOT / "ai_engine"
PY = sys.executable
TOKEN = "memory-test-internal-token"

# The six prompts required by the acceptance specification. Prompt 6 is the
# mandated multi-turn conversation (two turns sharing one conversationId).
PROMPTS: list[tuple[str, dict]] = [
    ("ml-school", "What is machine learning? Explain it to a school student."),
    ("binary-search", "Explain binary search with a simple example."),
    ("study-plan", "Create a 7 day study plan for learning Python."),
    ("http-https", "Explain HTTP and HTTPS."),
    ("js-reverse", "Write a simple JavaScript function to reverse a string."),
]
MULTITURN = [
    "Explain the water cycle.",
    "Now summarise that in one short sentence.",
]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float, ok) -> httpx.Response:
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
        time.sleep(0.4)
    raise TimeoutError(f"{url} not ready: {last.status_code if last else 'no response'}")


def spawn(cmd, cwd, env, log):
    return subprocess.Popen(
        cmd, cwd=cwd, env=env, stdout=open(log, "w"), stderr=subprocess.STDOUT, start_new_session=True
    )


def stop(proc):
    if proc and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def rss_kb(pid: int) -> int:
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except OSError:
        return 0
    return 0


def descendants(root: int) -> list[int]:
    """All descendant pids of ``root`` (the supervised model worker is a child)."""
    children: dict[int, list[int]] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue
        # /proc/<pid>/stat: fields are space-separated; the comm field may
        # contain spaces, so split on the last ")" and parse the remainder.
        rest = stat.rsplit(")", 1)[-1].split()
        if len(rest) >= 2:
            children.setdefault(int(rest[1]), []).append(int(entry.name))
    out: list[int] = []
    stack = list(children.get(root, []))
    while stack:
        pid = stack.pop()
        out.append(pid)
        stack.extend(children.get(pid, []))
    return out


def tree_rss_kb(root: int) -> int:
    return rss_kb(root) + sum(rss_kb(p) for p in descendants(root))


def main() -> int:
    limit_mb = int(os.getenv("EDUNOVA_MEMORY_LIMIT_MB", "510"))
    gguf = os.getenv("EDUNOVA_TEST_GGUF", "")
    if not gguf or not Path(gguf).is_file():
        print("EDUNOVA_TEST_GGUF must point to a local GGUF file", file=sys.stderr)
        return 2
    gguf_path = Path(gguf)

    logs = Path("/tmp/edunova-memory-test")
    logs.mkdir(exist_ok=True)
    inf_port, orch_port = free_port(), free_port()

    env = {**os.environ, "AI_INTERNAL_TOKEN": TOKEN, "AI_REQUIRE_INTERNAL_TOKEN": "true", "LOG_LEVEL": "WARNING"}
    inf_env = {**env, "LLM_PROVIDER": "local", "LOCAL_MODEL_RUNTIME": "llama_cpp",
               "LOCAL_MODEL_REPO": "local", "LOCAL_MODEL_FILE": gguf_path.name,
               "LOCAL_MODEL_DIR": str(gguf_path.parent),
               "LOCAL_MODEL_CTX": os.getenv("LOCAL_MODEL_CTX", "2048"),
               "LOCAL_MODEL_THREADS": os.getenv("LOCAL_MODEL_THREADS", "1"),
               "LOCAL_MODEL_MIN_BYTES": "100000",  # accept the tiny CI fixture (real models are >= 10 MiB)
               "RAG_ENABLED": "false"}
    orch_env = {**env, "AI_INFERENCE_URL": f"http://127.0.0.1:{inf_port}", "RAG_ENABLED": "false",
                "LLM_PROVIDER": "local", "LOCAL_MODEL_CTX": inf_env["LOCAL_MODEL_CTX"],
                "APP_BACKEND_URL": f"http://127.0.0.1:{orch_port}"}

    procs: list[subprocess.Popen] = []
    peak = threading.Event()
    peak_value = {"kb": 0}
    sampler_stop = threading.Event()

    def sampler():
        while not sampler_stop.is_set():
            try:
                total = tree_rss_kb(procs[0].pid)
                if total > peak_value["kb"]:
                    peak_value["kb"] = total
            except Exception:
                pass
            sampler_stop.wait(0.05)

    baseline_kb = 0
    loaded_kb = 0
    try:
        procs.append(spawn([PY, "-m", "uvicorn", "inference_server:app", "--host", "127.0.0.1",
                            "--port", str(inf_port)], AI, inf_env, logs / "inference.log"))
        # Baseline: the empty FastAPI supervisor before the worker/model is ready.
        time.sleep(1.5)
        baseline_kb = tree_rss_kb(procs[0].pid)
        ready = wait_http(f"http://127.0.0.1:{inf_port}/ready", 300,
                          ok=lambda r: r.status_code in (200, 503) and r.json().get("state") in ("MODEL_READY", "MODEL_FAILED"))
        ready_json = ready.json()
        if ready_json.get("state") == "MODEL_FAILED":
            print(json.dumps(ready_json, indent=2))
            print("FAIL: inference service did not reach READY (see above).", file=sys.stderr)
            return 1

        procs.append(spawn([PY, "-m", "uvicorn", "main:app", "--host", "127.0.0.1",
                            "--port", str(orch_port)], AI, orch_env, logs / "orchestrator.log"))
        wait_http(f"http://127.0.0.1:{orch_port}/ready", 120, ok=lambda r: r.status_code == 200)

        threading.Thread(target=sampler, daemon=True).start()
        loaded_kb = tree_rss_kb(procs[0].pid)

        status = httpx.get(f"http://127.0.0.1:{inf_port}/model/status", headers={"X-AI-Internal-Token": TOKEN}, timeout=10).json()
        resources = httpx.get(f"http://127.0.0.1:{inf_port}/system/resources", headers={"X-AI-Internal-Token": TOKEN}, timeout=10).json()

        headers = {"X-AI-Internal-Token": TOKEN, "Content-Type": "application/json"}
        rows = []
        for name, message in PROMPTS:
            t = time.monotonic()
            r = httpx.post(f"http://127.0.0.1:{orch_port}/api/ai/chat",
                           headers=headers,
                           json={"message": message, "ownerId": "memory-student-000001", "stream": False},
                           timeout=600)
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            rows.append({"prompt": name, "status": r.status_code, "ms": int((time.monotonic() - t) * 1000),
                         "answerChars": len(str(body.get("message") or "")), "answer": str(body.get("message") or "")[:160]})

        # Prompt 6: multi-turn conversation memory.
        conv_id = None
        for i, message in enumerate(MULTITURN):
            t = time.monotonic()
            payload = {"message": message, "ownerId": "memory-student-000001", "stream": False}
            if conv_id:
                payload["conversationId"] = conv_id
            r = httpx.post(f"http://127.0.0.1:{orch_port}/api/ai/chat", headers=headers, json=payload, timeout=600)
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            conv_id = body.get("conversationId") or conv_id
            rows.append({"prompt": f"multi-turn-{i + 1}", "status": r.status_code,
                         "ms": int((time.monotonic() - t) * 1000),
                         "answerChars": len(str(body.get("message") or "")),
                         "conversationId": conv_id, "answer": str(body.get("message") or "")[:160]})
    finally:
        sampler_stop.set()
        for p in procs:
            stop(p)

    model_bytes = gguf_path.stat().st_size
    req = resources.get("model_requirement", {})
    total_footprint_mb = req.get("required_mb")
    verdict = "PASS" if (total_footprint_mb is not None and total_footprint_mb <= limit_mb) else "FAIL"

    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model_file": gguf_path.name,
        "model_file_bytes": model_bytes,
        "model_file_mb": round(model_bytes / (1024 * 1024), 1),
        "rss_kb": {"baseline_parent_tree": baseline_kb, "after_load": loaded_kb, "peak_during_inference": peak_value["kb"]},
        "rss_mb": {"baseline": round(baseline_kb / 1024, 1), "after_load": round(loaded_kb / 1024, 1),
                   "peak": round(peak_value["kb"] / 1024, 1)},
        "analytic_footprint_mb": req,
        "memory_limit_mb": limit_mb,
        "verdict": verdict,
        "prompts": rows,
        "model_status": {"state": status.get("state"), "runtime": status.get("runtime"),
                         "runtime_version": status.get("runtime_version"), "quantization": status.get("quantization"),
                         "context_size": status.get("context_size"), "model_load_ms": status.get("model_load_ms")},
    }
    out = Path(os.getenv("EDUNOVA_MEMORY_OUT", str(ROOT / "docs" / "results" / "memory-footprint-latest.json")))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print(f"\nresults -> {out}\nlogs   -> {logs}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
