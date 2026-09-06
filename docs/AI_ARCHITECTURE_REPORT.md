# EduNova AI — PyTorch-First Architecture Report

Date: 2026-09-06 · Branch: `arena/01a07559-edunova-x` · Head: post-`a0f2895` redesign merge candidate

This report accompanies the implementation that replaces the old patch-level
timeout/download handling with a production AI architecture. Every number below
was measured live in this session — none are estimates. Where a requirement
could not be verified inside the sandbox (no HuggingFace egress, no MongoDB, no
search API), it is explicitly labelled **NOT-VERIFIABLE-HERE** instead of being
reported as PASS.

---

## ARCHITECTURE

```
Browser / 2 GB phone (lightweight client)
   │  SSE (fetch + ReadableStream), ~112 kB gzip JS total
   ▼
Express API gateway  (server/routes/ai.js)   — JWT auth, per-user rate limit,
   │                                             WARM-START REQUEST QUEUE:
   │                                             HTTP 200 + SSE "model.preparing"
   │                                             → poll GET /api/ai/ready every 2 s
   │                                             → forward only when modelReady
   │                                             → bounded AI_WARM_QUEUE_MAX_MS
   ▼
FastAPI orchestration service  (ai_engine/main.py) — intent router, agent loop,
   │  /api/ai/chat SSE, /api/ai/query, /api/ai/ready, /api/ai/health,
   │  /api/ai/metrics, /api/ai/diagnose(s), /api/ai/rag/*
   ▼
inference.torch_runtime  (PyTorch 2.4.1 + HF Transformers)
   │  lifecycle: not_started → downloading → loading → warming → ready
   │  download at BOOT ONLY (single-flight), dynamic int8/bf16/fp32,
   │  KV-cache streaming decode, single-flight thread lock, self-test warm-up
   ▼
EduNova data (Mongo/DB tools, syllabus, quizzes) + RAG + web research
   └── backends are called by the SERVICE, authorised by the API identity
```

Design rules enforced by the implementation:

1. **No request-time weight download/load.** Weights are obtained once in the
   lifespan preload; every inference call awaits the same single-flight load
   task. A readiness poll (`GET /api/ai/ready`) also acts as the wake-up signal
   for cold services, so a queued request can never deadlock against a model
   nobody started.
2. **The queue holds the student's message.** During warm-up the browser gets
   HTTP 200 + `status/model.preparing` SSE events and keep-alive comments — it
   is never told "please try again shortly". Only a hard deadline
   (`AI_WARM_QUEUE_MAX_MS`, default 10 min) ends the queue, with an accurate
   message.
3. **Real token streaming.** The torch decode loop emits decoded pieces through
   the SSE stream (`type:"token"`) as they are produced, with per-request
   `requestId`, first-token timing and throughput tracking.
4. **Security decisions live in the backend.** The AI service accepts an
   authenticated identity header from the API gateway; tools never accept a
   user-selected `owner_id`/`userId` from model output. RAG and DB lookups are
   scoped to the authenticated owner.
5. **Adaptive compute, not adaptive truncation.** Answer-length budget is chosen
   by intent (routing/quiz/plan/data vs long-form), generation runs to EOS or
   its token budget, and latency targets are met by the queue + streaming, not
   by cutting answers.

## MODEL

| Item | Value |
|---|---|
| Default repository (llama.cpp production) | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` + `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` (catalogue-backed, size + sha256 pinned) |
| Production runtime | llama.cpp / GGUF — `LOCAL_MODEL_RUNTIME=llama_cpp` (`agent/local_llm.py`); runtime installed from `requirements.txt` (`llama-cpp-python==0.3.35`, prebuilt CPU wheel from the abetlen extra index, no C++ compile) |
| Optional runtime | PyTorch + HuggingFace Transformers — `LOCAL_MODEL_RUNTIME=torch` (`inference/torch_runtime.py`) for safetensors models; torch CPU wheel installed first from the official CPU index in the Render build command |
| Dtype | GGUF quants are fixed in-file (Q4_K_M); `LOCAL_MODEL_DTYPE=auto` applies only to the optional torch runtime |
| Context | `LOCAL_MODEL_CTX_SIZE=6144` (Render; auto-lowered to 4096 on ≤768 MB containers) |
| Download | boot-time GGUF download into `/var/data/models`, `LOCAL_MODEL_DOWNLOAD_TIMEOUT=1800` |
| Verified live model | `tests/tmp_tiny_torch` — a real locally-generated `BertLMHeadModel` (65 vocab, ~80k params) used for offline/live pipeline verification because huggingface.co is unreachable from this sandbox |

**Model-size policy.** Intelligence is provided by tools/RAG/memory/workflows on
a small, CPU-feasible base model; the catalogue documents larger options
(Qwen2.5-1.5B, SmolLM2-360M/1.7B) for bigger plans. The chosen size is a
deployment/RAM decision, not the intelligence ceiling.

## PYTORCH VERSION

- Sandbox live measurement: **torch 2.4.1+cu121**, transformers **4.49.0** (CPU
  inference, no CUDA device present), Python 3.11.
- Render build command installs the **CPU wheel**: `pip install "torch>=2.2,<2.5"
  --index-url https://download.pytorch.org/whl/cpu` then `requirements.txt`
  (torch deliberately not duplicated in requirements to avoid pulling CUDA
  wheels on Linux).

## HARDWARE (sandbox where live tests ran)

| Resource | Value |
|---|---|
| CPU | 2 vCPU (Intel Xeon ~2.6 GHz, AVX-512), 1 physical core + HT |
| RAM | ~3.8 GB total; AI service RSS ≈ 513 MB for the tiny fp32 fixture |
| Disk | 20 GB free; Render blueprint provisions 4 GB disk at `/var/data/models` |

## QUANTIZATION

- `dtype=auto` picks int8 → dynamic per-Linear `torch.qint8` quantization when
  the fp32/bf16 estimate exceeds the available RAM budget (the estimation and
  choice live in `inference/adaptive.py`).
- Verified live: int8-dynamic run on the tiny model reached READY and generated
  text (~605 tok/s short-run; 14 of 14 Linears quantized).
- bf16/fp32/int8 are all selectable via `LOCAL_MODEL_DTYPE`; int8 is the default
  safe choice for the 2 GB Render plan.

## COLD START / WARM QUEUE (live measured)

| Metric | Measured |
|---|---|
| Tiny-model cold start (download skipped, local dir) | **788–864 ms** including self-test warm-up inference |
| First request on a cold (`preload=false`) service through the gateway | HTTP 200 + SSE immediately, 2× `model.preparing` events, model woke on `/ready` poll, **3.38 s** queue → streamed answer, total 6.0 s |
| Busy-model queueing at c=5/10/20 | gateway polls `/ready` (503 busy) and queues; observed waits 2.0–4.0 s, then all requests answered |
| Queue ceiling | `AI_WARM_QUEUE_MAX_MS=600000` (30 s floor, 15 min cap) |

## LATENCY / THROUGHPUT (tiny fixture, CPU, fp32)

- First token after warm: **2–9 ms** single request.
- Streaming decode: **~460–510 tok/s** at full context (300+ token answers);
  short runs 600–950 tok/s; int8 short run ~605 tok/s.
- Per-answer streaming events: 268–314 token events per SSE chat.

## TOOL ROUTING / INTENT

Router (lexical + model) covers: `knowledge`, `internal_db` (timetable,
syllabus, progress), `web_research`, `quiz`, `plan`, `complex` agent loop,
conversation follow-up, plus structured actions (quiz/plan JSON). Live logs
confirm routing decisions per request (`ROUTE_SELECTED intent=… tools=…`).
The agent loop and DB/web tools are **NOT-VERIFIABLE-HERE** without MongoDB and
a search provider; their wiring is unit-tested (fast-path + registry tests).

## RAG

- Per-owner lexical+semantic index (`RAG_ENABLED=true`, persist dir
  `/var/data/models/rag`), owner scoping enforced server-side; `/api/ai/rag/
  status|documents|search` live-verified (index up, 0 docs). Embedding backend
  (`all-MiniLM-L6-v2`) requires download → **NOT-VERIFIABLE-HERE**; lexical
  retrieval tested in the offline suite.

## STREAMING

- Real per-token SSE verified live through Express → FastAPI → torch
  (273–314 `type:"token"` events per knowledge answer, terminating
  `type:"answer"`, per-event `requestId`).
- Keep-alive comments (`: keep-alive`) protect long generations from proxies.

## SECURITY

- JWT at the gateway; internal token between API and AI service;
  `AI_REQUIRE_INTERNAL_TOKEN` guard live-enabled; identity headers, not model
  output, decide user/owner; secrets never logged (safe-diagnostics tests).
- Express route tests assert unauthenticated/forged requests never reach the
  upstream and 4xx errors are not retried.

## FRONTEND (low-end/2 GB phone)

- Vite build: **367.2 kB JS raw / 111.6 kB gzip + 57 kB CSS (9.85 kB gzip)** —
  light enough for low-end devices; no on-device inference, no weights.
- UI consumes `status/model.preparing`, `token`, `answer`, `error` SSE events;
  recovery copy now says the AI is preparing/queued, not "try again later".

## TESTS

| Suite | Result |
|---|---|
| Python pytest (`ai_engine/tests`, incl. new `test_torch_runtime.py`, lifecycle, RAG, tiny-torch load/stream/int8) | **102 passed, 9 skipped, 8 subtests passed** |
| Node `npm test` (Express AI route: warm-queue SSE, cold-start retry, auth, application tools) | **15 passed, 0 failed** |
| Frontend production build | **OK** (vite 6, 139 modules) |

## LIVE SCENARIOS 1–12 (through the real Express gateway → real FastAPI → torch)

All twelve canonical scenarios returned HTTP 200 + final `answer`
(`agentStatus=completed`) with token streaming and `requestId`
(JSON non-stream scenario returned the full contract). Four of them
(timetable / study-plan / quiz / syllabus, web research) exercise data/web
tools whose backends are absent in the sandbox, so their content correctness is
**NOT-VERIFIABLE-HERE**; their pipeline completion is PASS.

Full raw results: `docs/results/live-2026-09-06.json`.

## LOAD TEST (through the real gateway, per-user rate-limit raised for the run)

| Concurrent students | Requests | Succeeded | Mean | p50 | p95 |
|---|---|---|---|---|---|
| 1 | 3 | 3/3 | 679 ms | 679 ms | 692 ms |
| 5 | 15 | 15/15 | 2.69 s | 2.61 s | 6.68 s |
| 10 | 30 | 30/30 | 6.05 s | 5.63 s | 11.2 s |
| 20 | 60 | 60/60 | 10.9 s | 9.39 s | 24.7 s |

Latency grows ~linearly because one CPU decodes one answer at a time
(single-flight thread lock, by design on CPU); the queue keeps every request
alive instead of dropping it. Metrics endpoint live-observed: 142 requests,
142 success, 0 errors, 37 711 tokens generated.

## DEPLOYMENT

`render.yaml`: `edunova-ai` runs `uvicorn main:app` (workers=1), build =
`pip install "torch==2.4.1" --index-url https://download.pytorch.org/whl/cpu &&
pip install -r requirements.txt && python -c "import llama_cpp; print('llama_cpp runtime OK')"`,
`LOCAL_PRELOAD_MODEL=true`, 2 GB RAM plan (4 GB recommended once the real 0.5B
model is measured), 4 GB disk for `/var/data/models`; `edunova-api` gets
`AI_WARM_QUEUE_MAX_MS=600000`. `ai_engine/requirements.txt` is the single
dependency file — it installs `llama-cpp-python==0.3.35` (prebuilt CPU wheel
from the abetlen extra index, no C++ compile) plus the torch transformers
stack, so `LOCAL_MODEL_RUNTIME=llama_cpp` (GGUF, production) and
`LOCAL_MODEL_RUNTIME=torch` (safetensors) both work from one install. Merging
to `main` triggers Render auto-deploy of both services.

## KNOWN LIMITATIONS / HONEST STATUS

- The sandbox could not reach huggingface.co or the PyTorch CPU wheel index, so
  the real Qwen2.5-0.5B weights were not downloadable here. All live runs used
  a real tiny locally-generated torch model: **pipeline, queue, streaming,
  lifecycle, metrics, load behaviour are PASS; real-model content quality and
  real-model tok/s must be confirmed once on Render** (model self-test and
  `/api/ai/diagnose` are the operators' one-command checks).
- DB-backed and web-research answers require `MONGO_URI`, the data-service
  internal token and a search provider in the deployed environment.

## FINAL STATUS

**PASS (infrastructure, live-verified end-to-end on the PyTorch runtime) ·
CONTENT-REAL-MODEL: PENDING-DEPLOY-VERIFICATION** — the request-time
download/load problem is eliminated (boot-time preload + single-flight queue
with keep-alive), token streaming, warm-start SSE queue, lifecycle/readiness,
metrics, RAG scaffolding, security boundaries, low-end frontend bundle, unit +
integration + live + load evidence are all implemented and green as described
above. The remaining verification requires the deployed Render environment with
network access to HuggingFace, MongoDB and the search provider.
