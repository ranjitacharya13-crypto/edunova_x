# EduNova Unified Data-Aware AI Agent

EduNova AI operates as a **UNIFIED DATA-AWARE AGENT** capable of intelligently combining:
1. **EDUNOVA INTERNAL DATA** (Authenticated student database & application services)
2. **EXTERNAL DATA** (Verified web search, primary pages, approved utility tools)
3. **CONVERSATION CONTEXT** (Multi-turn topic resolution & memory)
4. **LLM KNOWLEDGE** (General educational & scientific concepts)

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
# Python tests (ai_engine)
.venv/bin/python -m unittest discover -s ai_engine/tests -v

# Node tests (Express server)
npm test --prefix server

# Frontend build
npm run build --prefix frontend
```
