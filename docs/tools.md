# Tools

The HRM only **requests** tools. The backend **executes** allowlisted tools
with the authenticated user id.

## Database (existing ApplicationToolRegistry)

`get_student_profile`, `get_subjects`, `get_timetable`, `get_today_schedule`,
`get_upcoming_classes`, `get_syllabus`, `get_learning_materials`, `get_progress`,
`get_study_history`, `get_quiz_history`, `get_quiz_results`, `get_assignments`,
`get_exams`, `get_attendance`, `get_notes`, `get_goals`, `get_upcoming_events`,
`get_notifications`, plus confirmed writes (`save_quiz`, `create_study_plan`, …).

Unknown tools and arguments such as `userId`, `sql`, `path`, `command` are
rejected (`StructuredOutputError`).

## RAG / documents

`ai_engine/hrm/tools/documents/pipeline.py` extracts TXT/MD always; PDF/DOCX/PPTX
if optional libraries are installed (`pypdf`, `python-docx`, `python-pptx`).
Otherwise the extractor returns `NOT_IMPLEMENTED` instead of faking text.

Chunks feed the existing `inference/rag.py` index (owner-scoped).

## Web

Existing `web_search` tool. Used only when the high-level head selects
`WEB_QUERY` / `web_search`. Failures surface as `WEB_SEARCH_UNAVAILABLE`.

## Quiz / study plan / AR

JSON validated before it reaches the UI or database. AR is a **scene spec**,
not a 3D engine.
