# EduNova X + custom HRM architecture

```
Student → existing EduNova UI → Express API (JWT)
        → FastAPI orchestrator (IntentRouter + ToolRegistry + RAG + web)
        → inference service
              ├─ default: llama.cpp GGUF (Render Free fallback)
              └─ LOCAL_MODEL_RUNTIME=hrm: EduNovaHRM (PyTorch)
                    High-level reasoner → tools? which?
                    Backend validator → allowlisted tools (identity from JWT)
                    DB / RAG / web results → untrusted context
                    Low-level reasoner → structured JSON / answer
        → existing UI (SSE stream)
```

## Non-negotiable boundaries

- The model never sees database credentials, SQL, filesystem, or other students.
- `X-User-Id` is set by the API gateway from the JWT, never from model output.
- Retrieved documents and web pages are wrapped as `<untrusted>` and cannot
  override system rules.
- Knowledge updates (new syllabus) go to RAG, not retraining.
- Behavior updates go to `post_training/`.
- Architecture changes are a new major model version.

## Existing systems preserved

- `server/routes/ai.js` chat/stream/auth/rate-limit
- `ai_engine/main.py` orchestrator
- `agent/router.py` fast paths (still used with llama.cpp fallback)
- Application tools in `server/services/applicationTools.js`
- AR renderer consumes `AR_SCENE` JSON; the model does not render 3D

## MAX_TOOL_STEPS

Configurable (`MAX_TOOL_STEPS`, default 8, cap 16) in `HRMWorkflow`.
