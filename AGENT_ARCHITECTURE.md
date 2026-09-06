# EduNova Unified Data-Aware AI Agent

EduNova AI operates as a **UNIFIED DATA-AWARE AGENT** capable of intelligently combining:
1. **EDUNOVA INTERNAL DATA** (Authenticated student database & application services)
2. **EXTERNAL DATA** (Verified web search, primary pages, approved utility tools)
3. **CONVERSATION CONTEXT** (Multi-turn topic resolution & memory)
4. **MODEL KNOWLEDGE** (General educational & scientific concepts)

> **Self-hosted, two-process since v6.0.** The AI brain is an open-source
> model — **Qwen2.5-0.5B-Instruct GGUF Q4_K_M** (`bartowski/…`, integrity-pinned
> in `config.py`) — running through **llama.cpp** inside the dedicated
> **persistent inference service** (`ai_engine/inference_server.py`, ≥ 2 GB
> RAM). The **orchestrator** (`ai_engine/main.py`) never loads weights and never
> imports `llama_cpp`/`torch`; it reaches the model over an authenticated
> HTTP/SSE client (`agent/remote_llm.py`). PyTorch is used only for RAG
> embeddings (served by the inference service on `/embeddings`). No
> OpenAI/Groq/Gemini/Anthropic/OpenRouter calls are made anywhere. See
> `docs/FINAL_ROOT_CAUSE_REPORT.md` for the memory root cause and measurements.

```text
                                USER
                                 |
                                 v
                            EDU NOVA AI
                                 |
                          Intent / Context
                                 |
            +--------------------+--------------------+
            |                    |                    |
            v                    v                    v
         INTERNAL             EXTERNAL              MODEL
           DATA                 DATA              KNOWLEDGE
            |                    |                    |
            v                    v                    |
        EduNova DB            Web/APIs                |
            |                    |                    |
            +--------------------+--------------------+
                                 |
                                 v
                          AGENT DECISION
                                 |
                      +----------+----------+
                      |                     |
                      v                     v
                   ANSWER                ACTION
                      |                     |
                      |              Existing EduNova
                      |              service/API
                      |                     |
                      |                     v
                      |                  DATABASE
                      |                     |
                      +----------+----------+
                                 |
                                 v
                            EDU NOVA UI
```

---

## 0. Model runtime — one authoritative lifecycle

```text
edunova-api (Node)      edunova-ai (FastAPI orchestrator)        edunova-inference (FastAPI)
POST /api/ai/chat  -->  IntentRouter / ToolRegistry / RAG   -->  inference/manager.ModelManager
POST /api/ai/stream     agent/remote_llm.RemoteInferenceLLM        └─ supervised llama.cpp worker
GET  /api/ai/ready      GET /health /ready /model/status           agent/local_llm.LocalModelManager
GET  /api/ai/model/status   /system/resources /metrics              (weights engine only)
```

Lifecycle inside the inference service (once per process, never per request):

```text
BOOT -> CONFIG_LOADED -> RESOURCES_CHECKED (inference/resources.py: required vs container MiB)
     -> DEPENDENCIES_READY (import llama_cpp) -> MODEL_LOCATED -> MODEL_VALID (size+sha256+GGUF magic)
     -> MODEL_LOADING -> MODEL_LOADED -> WARMUP_RUNNING ("What is 2 + 2?") -> WARMUP_SUCCESS
     -> INFERENCE_TEST_SUCCESS -> READY  (public: MODEL_NOT_READY | MODEL_LOADING | MODEL_READY | MODEL_FAILED)
```

Failure honesty: a container that cannot hold the model fails **before** the
worker is spawned with `MODEL_RESOURCE_INSUFFICIENT {required_mb, available_mb,
recommended_mb}`; every other failure is a terminal `MODEL_FAILED` sub-state.
Requests observe readiness once and return the precise code — no warm queue,
no retry of model loading, no "preparing…" loop, no canned answers.
Streaming is real token-by-token SSE through all three hops; generation runs
to EOS or the token ceiling and is never cut by elapsed time.

## 0.1 Deterministic Fast Paths (IntentRouter)

The autonomous AgentEngine loop (repeated JSON planning) is preserved for
complex/compound requests, but most student questions go through
`agent/router.py`: a zero-cost rule-based router that classifies the request,
runs the exact EduNova tools needed through the **same ToolRegistry** (same
permissions, same authenticated `X-User-Id` forwarding, same audit logging),
and uses the local model for a **single** synthesis/generation turn. This is
what makes a 0.5B model on shared CPU feel responsive.

| Intent | Data used | Generation |
| --- | --- | --- |
| `knowledge` / follow-ups | conversation context | 1 text call |
| `schedule_today`, `*_database*` | the matching `get_*` tools only | 1 text call |
| `study_recommendation` | timetable + progress + quiz history + assignments + history + exams | 1 text call |
| `performance_analysis` | quiz history + progress + subjects (+results) | 1 text call |
| `web_research` | `web_search` results | 1 text call with `[S#]` citations |
| `action_create_quiz` | today schedule + syllabus + materials | 1 grammar-JSON call -> validate -> `save_quiz` (needs user confirmation) |
| `action_study_plan` | exams + progress + syllabus | 1 grammar-JSON call -> validate -> `create_study_plan` (needs user confirmation) |
| `complex` | — | full AgentEngine autonomous loop |

## 1. Source Types & Selection

### Source 1 — EduNova Internal Database
Safely retrieves authenticated student data via backend tools in `ApplicationToolRegistry`:
- Profile, enrolled subjects, and classes (`get_student_profile`, `get_subjects`)
- Timetable and today's schedule (`get_timetable`, `get_today_schedule`, `get_upcoming_classes`)
- Syllabus & curriculum topics (`get_syllabus`)
- Study materials & recordings (`get_learning_materials`)
- Progress, streak, and weak/strong topics (`get_progress`)
- Study history & sessions (`get_study_history`)
- Quiz attempts, score percentages, and question breakdowns (`get_quiz_history`, `get_quiz_results`)
- Assignments & deadlines (`get_assignments`)
- Upcoming exams (`get_exams`)
- Attendance records & stats (`get_attendance`)
- Personal notes and goals (`get_notes`, `get_goals`, `get_upcoming_events`, `get_notifications`)

### Source 2 — External Data
Isolated external tools:
- `web_search`: search for current news, latest research, external curriculum verification
- `open_url` / `extract_webpage`: inspect verified public pages (untrusted external data)
- `calculator`: safe AST-based math evaluation without arbitrary code execution
- `get_current_datetime`: time and day-of-week context

### Source 3 — Conversation Context
Preserves context across user turns so follow-ups ("Explain machine learning" -> "Give me a quiz on that") resolve naturally.

### Source 4 — Model Knowledge
Stable educational concepts (e.g., "What is recursion?", "Explain Newton's first law") are answered directly without unnecessary database or web calls.

---

## 2. Source Priority & Rules

```text
AUTHENTICATED EDUNOVA DATA
           >
 EXTERNAL VERIFIED DATA
           >
  CONVERSATION CONTEXT
           >
 GENERAL MODEL KNOWLEDGE
```

### Strict No-Hallucination Rule
- If required data is unavailable in EduNova database or tools, the AI **NEVER** fabricates it.
- Clearly states: *"I don't have your upcoming exam date in EduNova yet."* or *"I couldn't find quiz records for that subject."*
- Never fabricates timetable entries, scores, grades, exam dates, attendance rates, assignments, or citations.

### Conflict Handling
- If internal database data and external sources conflict, the AI explicitly flags the discrepancy. EduNova application data is authoritative for student-specific facts.

---

## 3. Application Writes (Action Execution)

AI-generated actions pass through existing application validation services before database storage:
```text
AI Agent -> Application Tool -> Existing Service / Validation -> Database -> UI
```

Write tools supported:
- `create_timetable` / `update_timetable`
- `create_study_session` / `mark_study_complete`
- `create_quiz` / `save_quiz`
- `mark_assignment_complete`
- `update_progress`
- `create_note`
- `set_goal`
- `create_study_plan`

---

## 4. Security & Zero-Trust Authorization

- **The model NEVER determines authorization.**
- The model may call `get_quiz_results()`. The backend determines: `authenticatedUserId = actual logged-in user (req.user.id / X-User-Id)`.
- Prevents:
  - IDOR & cross-user data leakage
  - Tool argument injection
  - Prompt injection overrides
  - Unauthorized writes or mutations

---

## 5. Auditability

All tool executions record safe audit records:
- `userId`, `conversationId`, `toolName`, `sourceType`, `success`, `durationMs`, `timestamp`
- **STRICTLY EXCLUDES**: API keys, passwords, JWT tokens, authorization headers, private prompts, hidden chain-of-thought.

---

## 6. Testing

Run all unit & integration test suites:

```bash
# Python tests (ai_engine) — includes the local-model + fast-path suites
.venv/bin/python -m unittest discover -s ai_engine/tests -v

# Node tests (Express server)
npm test --prefix server

# Frontend build
npm run build --prefix frontend
```

`ai_engine/tests/test_local_model.py` covers: local-provider configuration
(and that no API key is required), intent routing for all canonical questions,
fast-path execution with tool fixtures (DB scoping, web citations, pending
write confirmations), quiz/plan payload validation, `RemoteInferenceLLM`/`ModelManager` behavior
against a fake `llama_cpp` (ChatML prompt shape, grammar usage, JSON parsing),
and failure honesty (loading/unavailable states never fake an answer).

## 7. Local model operations

- **Model choice & size** — `LOCAL_MODEL_REPO` + `LOCAL_MODEL_FILE` (or a
  direct `LOCAL_MODEL_URL`). The default 0.5B Q4_K_M needs a **2GB Standard**
  instance (~700MB RSS); see the DEPLOYMENT.md sizing table for the 512MB
  (SmolLM2-360M) and 4GB (1.5B) alternatives. Filenames must be verified with
  `GET /api/ai/model/source-check` before being deployed — an unpublished
  quant name is what produced the original startup HTTP 404.
- **Download integrity** — size (`LOCAL_MODEL_BYTES`), floor
  (`LOCAL_MODEL_MIN_BYTES`), `GGUF` magic, and optional `LOCAL_MODEL_SHA256`
  are all checked; transient failures retry `LOCAL_MODEL_DOWNLOAD_RETRIES`
  times with backoff, permanent HTTP statuses (400/401/403/404/405/410/451)
  fail fast with a `MODEL_STARTUP_ERROR` block naming the URL and the fix.
- **Context budget** — `AGENT_MAX_CONTEXT_CHARS` (12000) must fit inside
  `LOCAL_MODEL_CTX` (6144). Overflowing turns are trimmed in the middle and
  logged as `LOCAL_MODEL_PROMPT_TRUNCATED` rather than erroring.
- **Health** — `GET /health` (liveness, includes `model.state`),
  `GET /api/ai/health` (readiness: `ready` only when weights are loaded),
  `GET /api/ai/health?deep=true` (active probe).
- **Cold starts** — the blueprint mounts a 2GB persistent disk at
  `/var/data/models`, so weights download once and warm boots log
  `LOCAL_MODEL_CACHE_HIT ... (no download)`. Without a disk (Free plan) every
  cold start re-downloads ~380MB (~30-90s); `edunova-api` absorbs that with its
  upstream retry window (`AI_UPSTREAM_RETRY_WINDOW_MS=240000`).
- **Legacy rollback** — setting `LLM_PROVIDER=openai_compatible` with
  `LLM_API_KEY/LLM_MODEL/LLM_BASE_URL` temporarily restores an external
  OpenAI-compatible endpoint until the local model is verified; remove those
  variables afterwards (requirement: the external dependency is only retired
  once the local model works).
