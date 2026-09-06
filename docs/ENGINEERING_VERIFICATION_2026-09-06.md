# EduNova engineering and verification record — 2026-09-06

**Status: implemented changes under verification; production acceptance is NOT complete.**

This record distinguishes code/contracts, actual model inference, and live deployment. Historical `live-*` scripts and canned test responses in the repository are not proof of deployed intelligence.

## First broken state and root cause

The production AI health endpoint was reachable, but reported `warming`, `modelReady=false` and `readyForTraffic=false` while model/tokenizer handles and `warmupComplete=true` existed. It also reported a negative cold-start duration. The request/readiness path could re-enter a completed load pipeline; asking whether the model was ready could make it start over. The gateway compounded this with warm queues/retries. Native inference in a thread could also outlive the coroutine deadline.

The live container had only **536,870,912 bytes RAM (512 MiB), 0.15 CPU cores**, with a reported **614,367,232-byte peak RSS**. Its blueprint said Standard, but the observed service was not running those declared resources. This is a separate deployment/capacity blocker, not a UI problem.

An invalid configured `IQ3_XXS` filename had already been rejected in favor of the same repository's checksum-pinned Q4 file. The new supervisor preserves that narrowly scoped, observable 404 recovery; it never changes to a hosted model provider.

### Changes addressing these causes

- One spawn-isolated resident model worker; only lifespan startup launches it. `/health`, `/ready`, `/model/status`, probes and requests are observational.
- Explicit BOOT → CONFIG_LOADED → DEPENDENCIES_READY → RUNTIME_READY → MODEL_LOCATED → MODEL_VALID → MODEL_LOADING → MODEL_LOADED → WARMUP_RUNNING → WARMUP_SUCCESS → INFERENCE_TEST_SUCCESS → READY → SERVING states, timestamps, conditions and watchdogs. Terminal failures do not retry automatically.
- A 300-second total startup deadline, stage watchdogs, real decoded warmup and a separate inference test before readiness. Resource admission includes model and server overhead. The observed 512-MiB container should fail truthfully rather than thrash indefinitely.
- Single admitted generation; busy requests fail explicitly. Cancellation asks the resident worker to stop at a token boundary; stalled native work is terminated. No wall-clock answer truncation; reaching an output capacity is an explicit failure, not a complete answer.
- Authenticated gateway performs one readiness observation, never replays a tool-bearing chat POST, and relays bounded SSE with backpressure, disconnect and idle cleanup.

## Runtime and hardware evidence

| Item | Observed production before these changes | Local development verification |
|---|---|---|
| Model | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | Same configured model; pretrained download unavailable from sandbox |
| Format / quantization | GGUF / Q4_K_M | GGUF with llama.cpp; optional safetensors with PyTorch |
| Model file size | 397,808,192 bytes | No pretrained weights committed |
| Model SHA256 | `6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653` | Integrity pinned in configuration |
| llama-cpp-python | 0.3.35 | 0.3.35, source-built and imported |
| PyTorch | Not established from live endpoint | 2.8.0+cu128 installed from accessible PyPI; CUDA unavailable |
| Transformers | Not established live | 4.57.6 |
| Python | Not established live | 3.11.2 |
| OS / architecture | Not established live | Debian 12 / Linux x86_64 |
| CPU / RAM | 0.15 cores / 512 MiB | 2 visible CPUs / 4,131,278,848 bytes RAM |
| GPU | Not established live | None available |

Docker, Render and CI explicitly install **PyTorch 2.8.0 CPU wheels**, then import/execute the runtime preflight. GGUF goes to llama.cpp, not Transformers. PyTorch uses `torch.inference_mode()` for generation and semantic mean-pooled embeddings; pickle model checkpoints are disallowed. Native runtime imports were verified locally, not yet in a newly deployed Render container.

Qwen 0.5B is a resource-conscious baseline, not a promise of frontier reasoning. A larger compatible model is configurable, but must pass resource admission and measured startup/inference checks. No paid capacity upgrade was performed.

### Actual baseline production measurements

Source: public `https://edunova-ai-o2vy.onrender.com/health` observation during this session.

- Warmup: **791,539 ms**.
- Generation: **213 tokens / 791,525 ms / 0.27 tokens per second**.
- First token: **9,126 ms**.
- Reported cold start: **−1,103,947 ms** (invalid lifecycle metric, not a usable duration).
- DB / RAG / web / per-request end-to-end latency: **not established live**.

**This hardware cannot meet the requested normal-response target of approximately 10–20 seconds. Increasing a timeout, truncating an answer or reporting an HTTP 200 would not fix that.**

### Later production observation (still the old v4 build)

A subsequent public health read returned **READY**, with the same 512-MiB/0.15-core resource limits. Its latest recorded warmup was **1,054,508 ms**, generation **213 tokens / 1,054,497 ms / 0.20 tokens/sec**, and TTFT **9,344 ms**. This supersedes “currently warming”; it does **not** meet the latency target or establish that the new implementation is deployed. Its last recorded inference timestamp was `2026-09-06T10:34:34Z`.

The new implementation identifies itself as **v5.0.0** in AI/API health and the frontend `edunova-version` meta tag. Local disk at verification: 21,834,924,032-byte filesystem, 12,178,903,040 bytes available; production storage was not exposed by the old health endpoint.

## Integrated application changes

- Mongo identity/role/enrollment filters, blocked-user rejection, strict nested tool schemas and owner-bound one-use confirmation tokens. Model arguments cannot choose a student identity or arbitrary database mutation.
- Timetable preference: own record → enrolled class → explicitly legacy shared school record. Existing school data is retained.
- Private practice quizzes use the existing `Assignment` model with no fabricated PDF ID. Client DTOs hide answer indices; server grading saves `QuizAttempt` and derives subject performance. Assignment completion persists. AI cannot assign its own progress score.
- Study plans, quizzes and progress have application views and whitelisted navigation actions. Pending changes are reviewed/confirmed, not labelled as already saved.
- Existing GridFS study/syllabus uploads receive bounded text/PDF extraction. Legacy text backfill is bounded and reports unavailable/scanned/pending material honestly. MongoDB remains the source of truth.
- RAG uses chunking, explicit MiniLM/PyTorch embeddings, cosine ranking, embedding-space fingerprints, owner isolation, ACL/deletion reconciliation and bounded caches. `lexical` must be selected explicitly by an operator; embedding failures never silently switch vector spaces.
- Bounded conversation history, request/tool/model timing records and source-aware context. Untrusted tokenizer control markers are escaped, external access is request-scoped, and unresolved tool failures/iteration limits produce partial rather than successful completion status. Current-data answers use the existing web data tools; the reasoning engine remains local.

## AR and low-memory client implementation

- Generic published `ARLesson` Mongo schema/catalog/routes and same-origin reviewed asset URLs; no camera frame endpoint.
- Study Material → topic → View in AR; Syllabus → Explore in AR; published lesson context → AI explanation / proposed practice quiz → saved quiz → progress.
- Original CC0 Human Eye teaching schematic: **15,652-byte GLB**, no external textures, SVG and complete text/hotspot fallback. It is explicitly a schematic, not an anatomical/medical model. The schema supports other reviewed lessons without new hardcoded viewer logic.
- `model-viewer` and its 3D dependencies are lazy-loaded, not part of app startup. The lazy model-viewer chunk is about 273 KB gzip. Low-memory/save-data clients start in reading mode.
- Explicit camera/AR activation, WebXR support detection, loading/error/fallback states and scene removal/cache disposal. AI receives only lesson/hotspot identifiers from the browser; the gateway supplies canonical educational context from Mongo.
- No LLM weights, PyTorch or server-side embedding index in the client bundle.

## Verification ledger

| Area | Current result | Scope / limitation |
|---|---|---|
| Python regression | PASS: 131 tests + 8 subtests; 9 skipped | Includes actual supervised tiny-PyTorch generation, cancellation retaining the resident worker, a killed startup-deadline worker, observational HTTP health and configuration rejection. The random fixture is NOT intelligence evidence |
| Node regression | PASS: 15 tests | Six new real-Mongo integration tests skipped locally without Mongo |
| Frontend production build / Worker bundle | PASS | Vite and Wrangler 4.129.0 deploy dry run pass; not live acceptance |
| Dependency audit | PASS: zero reported vulnerabilities in frontend/server installed trees | npm audit at verification time |
| Browser AR/fallback/context/quiz contracts | PASS: 5 Chromium tests | Explicit API fixtures; actual original GLB loads and disposes; mobile 390×844 reading/context path; not a deployed AI test |
| Real pretrained model reasoning / streaming | UNVERIFIED | Executable records real weights, answers, throughput and cancellation evidence; CI activation blocked by GitHub workflow permission |
| Real semantic embedding inference | UNVERIFIED | Verifier targets actual MiniLM weights; local owner-isolation tests use explicit lexical backend |
| Real Mongo integration | UNVERIFIED | Inactive CI template defines disposable MongoDB; no production credentials used |
| Live web research and mixed student/current answers | UNVERIFIED | Code/regression contracts are not verified live results |
| Physical WebXR camera / 2-GB phone | UNVERIFIED | Browser capability/fallback paths are tested; actual phone/camera is unavailable |
| Deployed AI/DB/RAG/AR combined acceptance | BLOCKED | No authenticated production test session/deployment credentials; inadequate observed AI capacity |
| GitHub push / merge | PUSHED; merge pending | [PR #57](https://github.com/ranjitacharya13-crypto/edunova_x/pull/57); updated below after merge |

## Deployment boundaries

The actual public hosts observed are:
- Frontend: `https://edunova-x.ranjitacharya13.workers.dev`
- Express API: `https://edunova-api-y3rx.onrender.com`
- Persistent model service: `https://edunova-ai-o2vy.onrender.com`

The frontend uses relative `/api` requests, with Cloudflare/Vercel server-side proxying to the known API. Camera frames are not proxied to AI. The Cloudflare Worker is a streaming network proxy, never a model host.

GitHub access is available for application branch/PR operations; the first push was rejected because the connection lacks workflow-edit permission. `.github/ci/quality.workflow.yml` is an **inactive** template, not an executed workflow. Access to Actions secrets returned HTTP 403, and Render/Cloudflare production credentials and Mongo credentials are not available. Deployment checks on the first pushed revision: **Cloudflare Workers build FAILED; both Vercel builds FAILED**. The GitHub check exposes provider dashboard links, not diagnostic logs. The local equivalent Worker build/bundle succeeds; the actual remote failure cause remains unverified, and is not claimed fixed.

No new production account or demo data has been inserted. Tests never operate on a live database. A merge may trigger existing connected deployment integrations, but deployment must be verified separately; it is not assumed successful.

## Remaining acceptance gaps / explicit limitations

- No actual pretrained GGUF or MiniLM weights could be downloaded in this sandbox (TLS connections to model/binary hosts failed). PyPI runtime imports and real offline tensor/native-worker mechanics passed, but this is not pretrained reasoning quality evidence.
- No real Mongo server was available locally. The six isolated Mongo integration tests are committed but not counted as passing; the inactive CI template cannot run until GitHub workflow permission is granted.
- Ordinary answer fast paths stream actual decoded pieces. The general multi-step planner's JSON planning and quiz/plan JSON generation expose status events; their structured results are delivered when validation completes. Universal token-by-token streaming of every structured/complex output is not certified.
- Legacy PDF extraction backfills at most one bounded file per retrieval request; unavailable, scanned/OCR-required and pending material is explicitly reported. OCR is not implemented. Semantic retrieval needs its server-side pretrained embedding model.
- Strict schema checks validate quiz structure, not the educational correctness of every generated answer. Actual learning quality, saved-quiz round trips on production Mongo, mixed current-data research and authenticated live conversations remain unverified.
- Physical camera/WebXR behavior and performance on an actual 2-GB phone remain unverified; desktop Chromium emulates low-memory hints and mobile viewport for fallback checks.
- A merge is a repository operation, not a passed deployment. The observed AI hardware and failed deployment checks still require operator attention; no paid resource changes or credential-dependent provider actions were performed.
