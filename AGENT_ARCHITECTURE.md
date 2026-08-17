# EduNova AI Agent

EduNova's existing AI path is now a bounded, goal-oriented agent rather than a
fixed intent handler. The existing deployment topology remains intact:

```text
React UI
  -> authenticated Express API: POST /api/ai/chat
  -> existing FastAPI AI service
  -> AgentEngine decision loop
       -> answer directly, OR
       -> dynamically select one registered tool
       -> observe -> evaluate/replan -> repeat -> verify -> answer
```

Express remains the public application backend and authentication boundary.
FastAPI is the existing AI service behind it—not a second application backend.

## What is implemented

- Explicit private `AgentState`: goal, bounded conversation, understanding,
  facts, unknowns, assumptions, observations, genuine sources, tool history,
  adaptive plan, objectives, confidence, and counters.
- One-action-at-a-time model-controlled loop. The backend never forces
  `search -> open -> answer` and does not run web search for every question.
- Generic permission-aware `ToolRegistry` with name, description, JSON input
  schema, executor, permission, timeout, and result contract.
- Initial tools: `web_search`, `open_url`, and `extract_webpage`.
- Brave, Tavily, or Serper search selected through environment configuration.
- Source IDs are assigned by backend code only. Unknown model-produced source
  IDs are stripped, and only URLs actually returned by tools reach the UI.
- Safe SSE statuses and final answer events; no chain-of-thought is streamed.
- In-process, owner-scoped, TTL-bounded conversation memory containing only
  user-visible turns. The private state and webpage observations are not stored.
- Tool failure observations, model/provider retry handling, exact-call
  de-duplication, replanning, independent-source guidance, and a bounded final
  answer at the safety limit.
- Configurable iteration, tool-call, result-count, context, response-size, and
  timeout limits.

## Configuration

Copy `ai_engine/.env.example` to `ai_engine/.env` for local development. At
minimum, configure:

```env
LLM_API_KEY=...
LLM_MODEL=gpt-4.1-mini
LLM_BASE_URL=https://api.openai.com/v1

WEB_SEARCH_API_KEY=...
WEB_SEARCH_PROVIDER=brave

MAX_AGENT_ITERATIONS=12
MAX_TOOL_CALLS=15
MAX_AGENT_RUNTIME_SECONDS=180
WEB_SEARCH_MAX_RESULTS=5
WEB_REQUEST_TIMEOUT=10
WEB_MAX_CONTENT_LENGTH=200000
```

`LLM_BASE_URL` accepts an OpenAI-compatible `/v1` endpoint. Web providers are
`brave`, `tavily`, and `serper`. Stable questions still work if the search key
is missing; if the agent decides current research is essential, the failed
search becomes an observation and it can explain the verification limitation.
An LLM key is required because a canned fallback would not be a real agent.

For production, set the same random `AI_INTERNAL_TOKEN` on Express and FastAPI,
and set `AI_REQUIRE_INTERNAL_TOKEN=true` on FastAPI. The Render blueprint already
enables this requirement, so agent requests fail closed until the shared token
is configured. All model/search keys belong only on the FastAPI service. Never
prefix them with `VITE_`.

## Local run

```bash
# Terminal 1: AI service
python3 -m venv .venv
.venv/bin/pip install -r ai_engine/requirements.txt
cd ai_engine
../.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8001

# Terminal 2: Express API (requires server/.env for Mongo/JWT)
npm install --prefix server
npm start --prefix server

# Terminal 3: frontend
npm install --prefix frontend
npm run dev --prefix frontend -- --host 0.0.0.0
```

The Vite proxy sends browser `/api` requests to Express. Browser code never
calls localhost to reach the AI service.

## API

### JSON

```http
POST /api/ai/chat
Authorization: Bearer <existing EduNova JWT>
Content-Type: application/json

{"message":"What is a binary tree?","conversationId":"optional"}
```

```json
{
  "success": true,
  "message": "...",
  "reply": "...",
  "sources": [],
  "usedWeb": false,
  "agentStatus": "completed",
  "conversationId": "...",
  "limitReached": false
}
```

`reply` is a backward-compatible alias of `message`.

### SSE

Send the same request with `Accept: text/event-stream`. Safe events look like:

```text
data: {"type":"status","event":"agent.tool_started","message":"Researching current information...","tool":"web_search"}

data: {"type":"answer","success":true,"message":"...","sources":[...],"usedWeb":true,"agentStatus":"completed"}
```

No prompts, private state, model reasoning, page content, or credentials are
included in events.

## Web and tool security

- Only HTTP(S) URL schemes are accepted.
- URL credentials, localhost, private, loopback, link-local, reserved, metadata,
  `.local`, `.internal`, `.lan`, and mixed public/private DNS answers are blocked.
- DNS and destination validation runs before every request and every redirect.
- Redirect count, response bytes, extracted characters, and request duration are
  bounded.
- Scripts, styles, forms, navigation, footers, iframes, and common boilerplate
  are removed before extraction.
- Web content is marked and delimited as untrusted external data. System policy
  explicitly forbids following instructions found in that data.
- The registry auto-allows only `READ_EXTERNAL`. Future write/private/destructive
  tools remain denied until an explicit approval mechanism is added.
- Express uses existing JWT authentication and a per-user AI rate limit.

Application-level SSRF checks should still be paired with production network
egress controls as defense in depth.

## Tests

```bash
cd ai_engine
../.venv/bin/python -m unittest discover -s tests -v
npm run build --prefix ../frontend
```

Tests cover direct stable answers without tools, agent-selected multi-step
research, failure recovery with a refined action, source tracking, permission
denial, JSON decision parsing, and blocked SSRF targets.
