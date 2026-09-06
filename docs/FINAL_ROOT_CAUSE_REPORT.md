# EduNova_X — Final Root-Cause Fix Report (AI model memory / architecture)

Date: 2026-09-06 · Branch: `arena/01a07699-edunova-x` → `main`

---

## 1. Root cause found

**Error in production:** `Model + server ML need at least 1100 MiB; container has 512 MiB`

**Where it came from:** `ai_engine/inference/manager.py` (the model lifecycle
memory gate) running **inside the FastAPI AI service process** (`main.py`).
That gate compared the model's estimated requirement
(`estimated_ram_mb` 700 + 400 MiB server overhead = **1100 MiB**) against the
container's cgroup `memory.max`, which was **512 MiB** on the live `edunova-ai`
deployment.

**Why it happened (architecture, not a bug in the gate):**

1. The self-hosted LLM (Qwen2.5-0.5B-Instruct Q4_K_M GGUF, 397 MB file) was
   loaded **in-process** inside the same FastAPI service that does routing,
   tools, RAG, web search and SSE. That process therefore needed
   weights + KV cache + llama.cpp buffers + FastAPI + PyTorch embeddings.
2. The live service ran on a **512 MiB instance** (`render.yaml` said
   `plan: standard`, but the cgroup measured at runtime was 512 MiB — the
   deployed instance type did not match the blueprint, or the API's
   `AI_ENGINE_URL` pointed at a free-tier deployment).
3. The gate correctly refused to load. Nothing in the code path could succeed
   without more memory, so every "fix" that touched timeouts, retries or
   context sizes (the code even silently downgraded context on ≤768 MiB
   containers) only hid the problem.
4. Three overlapping lifecycle managers existed (`agent/local_llm.LocalModelManager`
   with its own state machine, `inference/manager.ModelManager`,
   `inference/lifecycle.ModelLifecycle` for torch) plus a full PyTorch LLM
   runtime (`inference/torch_runtime.py`, `inference/adaptive.py`), which made
   the readiness truth ambiguous and pulled torch into the request process.

The Node/Express API (`server/`) never loaded the model — it only proxied to
`AI_ENGINE_URL`. The 512 MiB container was the **Python AI service**.

## 2. Architecture change

```
BEFORE                                         AFTER
browser -> edunova-api (Node, 512 MiB)         browser -> edunova-api (Node, no LLM, ~100 MiB)
             -> edunova-ai (FastAPI + MODEL,                -> edunova-ai (FastAPI ORCHESTRATOR, no LLM,
                512 MiB actual)  X  OOM gate                   never imports llama_cpp/torch, ~55 MiB)
                                                                -> edunova-inference (FastAPI, llama.cpp GGUF
                                                                   + PyTorch embeddings, 2 GB plan)
```

| Service | Role | Loads model | Measured RSS (local run) | Plan |
|---|---|---|---|---|
| `edunova-api` | Express REST + AI gateway (`/api/ai/chat`, `/stream`, `/health`, `/ready`, `/model/status`, `/system/resources`) | no | ~100 MiB | 512 MiB |
| `edunova-ai` (`main:app`) | IntentRouter, ToolRegistry, RAG orchestration, web search, memory, SSE relay | no | ~55 MiB | 512 MiB |
| `edunova-inference` (`inference_server:app`) | One `ModelManager` → supervised llama.cpp worker; `/embeddings` (PyTorch) | **yes** | parent 51 MiB + worker 211 MiB (135M test model); **1166 MiB required** for Qwen2.5-0.5B @ 6144 ctx with embeddings | **2 GB** |

## 3. Files changed / created / removed

**New**
- `ai_engine/inference/resources.py` — `ResourceManager` (RAM/cgroup/CPU/GPU/disk), GGUF header inspection, `estimate_requirement`, `check_model_fits` → `ResourceInsufficient` with `required_mb / available_mb / recommended_mb`.
- `ai_engine/inference_server.py` — persistent inference service: `/health`, `/ready`, `/model/status`, `/system/resources`, `/metrics`, `POST /generate`, `POST /generate/stream` (SSE), `POST /embeddings`; token auth; single `ModelManager` started once at startup.
- `ai_engine/agent/remote_llm.py` — `RemoteInferenceLLM` (HTTP/SSE client used by the orchestrator; same interface the planner/router already used) + `create_llm`.
- `ai_engine/requirements-orchestrator.txt` — lightweight deps (no torch/llama).
- `ai_engine/tests/acceptance/run_acceptance.py`, `jwt_mini.py`, `server/scripts/acceptance-gateway.js` — real 3-hop acceptance run.
- `docs/results/acceptance-latest.json`, `docs/results/acceptance-512mib.json` — measured results.

**Rewritten / modified**
- `ai_engine/inference/manager.py` — the **single authoritative lifecycle**: parent-side `preflight_resources()` **before** the worker is spawned (→ `MODEL_RESOURCE_INSUFFICIENT`, no process started), in-worker: config → resources → `import llama_cpp` → download/validate → load → warmup `"What is 2 + 2?"` → independent inference test → `READY`; public states `MODEL_NOT_READY / MODEL_LOADING / MODEL_READY / MODEL_FAILED`; `429 MODEL_BUSY` admission; no retry of loading; terminal failures stay terminal.
- `ai_engine/agent/local_llm.py` — reduced to the **weights engine** (download, sha256/size/magic validation, `_load_model`, `generate(on_token)`, prompt/context fit). Its duplicate state machine, `LocalLlamaLLM`, torch helpers and old `create_llm` were removed.
- `ai_engine/main.py` — orchestrator only: no model, no torch; `/health`, `/ready`, `/model/status`, `/system/resources`, `/metrics`, `/api/ai/*` observe the inference service; `_ready_gate` is a single status read (no keep-alive "preparing" loop); `RemoteEmbedder` for RAG.
- `ai_engine/inference/rag.py` — added `RemoteEmbedder` (vectors from the inference service; torch stays out of the orchestrator).
- `ai_engine/config.py` — `inference_url` (`AI_INFERENCE_URL`), `inference_request_timeout`; **removed the silent context downgrade** on small containers.
- `ai_engine/verify_runtime.py`, `ai_engine/Dockerfile`, `ai_engine/requirements.txt` — build/start dependency verification (`import llama_cpp`, `import torch`) for the inference image; `--orchestrator` mode for the light image.
- `server/routes/ai.js` — added `POST /api/ai/stream`, `GET /api/ai/ready`, `GET /api/ai/model/status`, `GET /api/ai/system/resources` (admin); precise codes relayed (`MODEL_LOADING`, `MODEL_RESOURCE_INSUFFICIENT`, `AI_SERVICE_UNREACHABLE`, …).
- `frontend/src/api/api.js`, `hooks/useAIStatus.js`, `Components/FloatingAIChat.jsx` — error-code → specific message map (AI starting / unavailable / resource insufficient / inference error / DB / auth / network); new `RESOURCE_INSUFFICIENT` status; "Try again" hidden for non-retryable deployment failures; error code shown.
- `render.yaml` — three services with documented RAM/CPU (`edunova-ai` starter, `edunova-inference` standard 2 GB + disk); `DEPLOYMENT.md` §2, `.env.example`, `AGENT_ARCHITECTURE.md`, root `package.json` (`start:inference`).
- Tests migrated: `tests/test_local_model.py` (weights engine, resources, remote client contract, no-runtime-imports guard), `tests/test_local_model_runtime.py` (real llama.cpp via `ModelManager`), `tests/test_model_config_fallback.py`, `tests/test_supervised_runtime.py` (resource fail-fast, HTTP observation, resource propagation), `server/test/ai-route.test.js` (+3: `/stream`, resource error relay, unreachable).

**Removed (duplicate lifecycles / torch LLM runtime)**
- `ai_engine/inference/torch_runtime.py`, `inference/adaptive.py`, `inference/lifecycle.py`, `tests/test_torch_runtime.py`, `tests/test_model_readiness_regression.py`, `tests/tools/make_tiny_torch.py`, `tests/tmp_tiny_torch/`.

## 4. Model, runtime, memory

| Item | Value |
|---|---|
| Model | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` / `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` (Apache-2.0), sha256+size pinned in `config.py` |
| File size | 397 MB |
| LLM runtime | llama.cpp via `llama-cpp-python==0.3.35` (CPU, mmap) |
| ML runtime | PyTorch 2.8.0 CPU — embeddings (`all-MiniLM-L6-v2`) only, inside the inference service |
| Requirement @ ctx 6144 (`inference/resources.py`) | weights 398 + KV 80 + runtime 160 + server 140 + embeddings 260 + margin 128 = **1166 MiB** (906 MiB without RAG) |
| Recommended | **2048 MiB**, 1 dedicated CPU core, 2 threads |
| API RAM | ~100 MiB (Node) · Orchestrator RAM ~55 MiB (FastAPI) |

## 5. Acceptance tests (real stack, local)

Run: `EDUNOVA_TEST_GGUF=… python ai_engine/tests/acceptance/run_acceptance.py`
(inference service → orchestrator → real Express gateway with JWT; the only
fixtures are the JWT user lookup and the tool database, both documented in
`server/scripts/acceptance-gateway.js`). Model used locally:
**SmolLM2-135M-Instruct Q4_1** — the only GGUF obtainable in this sandbox
(HuggingFace is unreachable). It exercises the identical llama.cpp pipeline;
Qwen2.5-0.5B numbers must be taken from the Render deployment.

| # | Test | Result | Evidence |
|---|---|---|---|
| 1 | Model reaches `MODEL_READY` after load + warmup + real inference test | PASS | load 104 ms, warmup 132 ms, cold start 820 ms, self-test `"What is 2 + 2?"` → `"The answer is 4."` |
| 2 | `/system/resources` reports RAM/CPU + model requirement | PASS | ram_total 3939 MiB, required 575 MiB (135M model) |
| 3 | Inference service rejects requests without internal token | PASS | 401 |
| 4 | Orchestrator `/ready` mirrors inference readiness, loads no model | PASS | `loadsModel: false`, no `torch`/`llama_cpp` in `sys.modules` |
| 5 | Gateway `/ai/ready`, `/ai/model/status`, `/ai/health` (JWT) | PASS | `modelReady: true`, `state: MODEL_READY` |
| 6 | Gateway rejects unauthenticated chat | PASS | 401 |
| 7 | `POST /ai/chat` real answer end-to-end | PASS | 884 ms total, finish `stop` |
| 8 | `POST /ai/stream` real token SSE + complete answer | PASS | first token 111 ms at the browser side, 41 token events, 56.9 tok/s |
| 9 | No truncation / "Answer shortened" | PASS | `finishReason: stop`, no shortening text anywhere in code |
| 10 | Authenticated user-scoped tool via ToolRegistry → gateway | PASS | intent `schedule_today`, `get_today_schedule` executed, `usedInternalDb: true` |
| 11 | Conversation memory (follow-up "it") | PASS | same `conversationId`, follow-up answer about photosynthesis |
| 12 | Insufficient RAM fails fast with numbers | PASS | `AI_MEMORY_LIMIT_MB=512` → `MODEL_RESOURCE_INSUFFICIENT required 575 / available 512 / recommended 1024`, no worker spawned |
| 13 | Resource failure propagates to gateway with specific message (no queue, no "try again") | PASS | orchestrator 503 + gateway `/ready` 503 + gateway `/chat` 503, message "…needs 575 MiB but has 512 MiB (recommended 1024 MiB)" |

Unit/integration suites: `ai_engine` pytest **123 passed, 10 skipped**
(skips: real-GGUF-download tests needing `gguf` writer / network);
`server` `node --test test/ai-route.test.js` **12 passed**; frontend `vite build` OK.

## 6. Performance measurements (local sandbox: 2 vCPU Xeon 2.6 GHz, no GPU, SmolLM2-135M Q4_1)

| Metric | Value |
|---|---|
| Model load | 104 ms |
| Warmup (`What is 2 + 2?`) | 132 ms |
| Cold start to READY (process start → READY) | 0.82 s (1.69 s incl. uvicorn boot) |
| First token (gateway → browser, streaming) | 111 ms |
| Tokens/second (streaming) | 56.9 |
| JSON chat total | 0.88 s |
| Tool-backed chat total (DB tool 48 ms + generation) | 2.6 s |
| RSS: API / orchestrator / inference parent / inference worker | 100 / 55 / 51 / 211 MiB |

These are pipeline numbers for a 135M model. Qwen2.5-0.5B on a 2 GB / 1 CPU
Render instance will be slower (expect ~8–15 tok/s on one shared core, cold
start dominated by the one-time 397 MB download); **not measured here** —
`/metrics` and `/api/ai/diagnose` report the real values after deploy.

## 7. Remaining risks / what must be done on Render

1. Create the `edunova-inference` service from `render.yaml` (Standard 2 GB),
   let it reach `/ready`, then set `AI_INFERENCE_URL` on `edunova-ai` and the
   shared `AI_INTERNAL_TOKEN` on all three services.
2. Confirm `edunova-api`'s `AI_ENGINE_URL` points at the orchestrator (not at
   a legacy 512 MiB deployment).
3. If the inference plan is smaller than the requirement, the service will now
   say so precisely (`MODEL_RESOURCE_INSUFFICIENT` with numbers) and the UI
   will show "AI model resource insufficient" — it will not loop.
4. Hugging Face must be reachable from the inference service for the one-time
   download (or pre-seed `/var/data/models`).

## 8. Checklist (§38)

- [x] Root cause identified and documented (memory + in-process model + 512 MiB service + duplicate lifecycles)
- [x] API separated from model; model in persistent inference service; phone/browser is a client only
- [x] ResourceManager + `GET /system/resources`; pre-load check; `MODEL_RESOURCE_INSUFFICIENT {required_mb, available_mb, recommended_mb}`
- [x] One authoritative lifecycle; load once at startup; warmup + real inference test before READY; states MODEL_NOT_READY/LOADING/READY/FAILED
- [x] `/health`, `/ready`, `/model/status`, `/system/resources`, `/metrics` on both Python services; gateway `POST /ai/chat`, `POST /ai/stream`, `GET /ai/health`, `/ai/ready`, `/ai/model/status` with internal token
- [x] Real SSE token streaming through all hops; no truncation; no infinite warming/preparing; no timeouts changed to hide problems
- [x] Self-hosted only (llama.cpp GGUF LLM, PyTorch for embeddings); no commercial LLM
- [x] Tools, RAG, web search, memory, ToolRegistry, actions, AR/AI/AR-quiz code paths untouched and covered by the existing suites
- [x] Frontend specific messages; no generic "Try again" for deployment failures
- [x] Dependency verification at build and start
- [x] Deployment config documents API RAM, AI RAM, model size, runtime RAM, CPU
- [x] Acceptance tests 1–13 PASS on the real local stack; measurements recorded (with the model-size caveat above)
