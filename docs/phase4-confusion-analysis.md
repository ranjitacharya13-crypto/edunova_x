# Phase 4 confusion analysis

Checkpoint: `post_training/checkpoints/edunova-hrm-20m-sft` (800 steps, v0.3).
Bench: 117 held-out cases, temperature 0, tool **head** unless noted.
Raw: `docs/results/hrm-phase4-eval.json`.

## Headline

| Split | Tool-head Top-1 | Tool-head Top-3 | Generated tool | JSON |
|---|---:|---:|---:|---:|
| Bench 117 | 0.6239 | 0.8034 | 0.6496 | 1.00 |
| Adversarial 30 | 0.7333 | — | 0.7000 | 1.00 |
| Golden 10 (primary tool) | 0.50 | — | 0.50 | 1.00 |

Phase 3 generated-tool accuracy was **0.4786**. The remaining ~35% of bench
failures are **not** JSON failures and **not** mode-collapse. They are
semantic near-neighbour confusions plus a handful of tools the 20M head
never learned (support = 4 paraphrases each on the bench).

Head vs generated agreement: **93 / 117**. Generated is slightly *better*
than the head (76 vs 73 hits) because decoder tool-tokens still carry
independent signal. The two errors are correlated, not independent.

## Per-tool F1 (tool head, bench)

| Tool | P | R | F1 | Support |
|---|---:|---:|---:|---:|
| get_attendance | 1.00 | 1.00 | 1.00 | 5 |
| get_learning_materials | 1.00 | 1.00 | 1.00 | 4 |
| get_notes | 1.00 | 1.00 | 1.00 | 4 |
| get_goals | 1.00 | 0.75 | 0.86 | 4 |
| retrieve_learning_materials | 1.00 | 0.75 | 0.86 | 4 |
| save_quiz | 1.00 | 0.75 | 0.86 | 4 |
| open_url | 0.67 | 1.00 | 0.80 | 4 |
| get_study_history | 0.75 | 0.75 | 0.75 | 4 |
| get_timetable | 0.75 | 0.75 | 0.75 | 4 |
| get_upcoming_classes | 0.75 | 0.75 | 0.75 | 4 |
| get_upcoming_events | 0.75 | 0.75 | 0.75 | 4 |
| web_search | 0.75 | 0.75 | 0.75 | 4 |
| get_subjects | 0.50 | 1.00 | 0.67 | 4 |
| calculator | 1.00 | 0.50 | 0.67 | 4 |
| get_assignments | 1.00 | 0.50 | 0.67 | 4 |
| get_notifications | 1.00 | 0.50 | 0.67 | 4 |
| open_feature | 1.00 | 0.50 | 0.67 | 4 |
| get_ar_lessons | 0.50 | 0.75 | 0.60 | 4 |
| get_today_schedule | 0.40 | 1.00 | 0.57 | 4 |
| get_exams | 0.43 | 0.75 | 0.55 | 4 |
| get_quiz_results | 0.50 | 0.50 | 0.50 | 4 |
| get_quiz_history | 0.40 | 0.50 | 0.44 | 4 |
| get_student_profile | 0.40 | 0.50 | 0.44 | 4 |
| create_quiz | 1.00 | 0.25 | 0.40 | 4 |
| extract_webpage | 1.00 | 0.25 | 0.40 | 4 |
| get_syllabus | 0.50 | 0.25 | 0.33 | 4 |
| get_current_datetime | 0.25 | 0.25 | 0.25 | 4 |
| **get_progress** | 0.00 | 0.00 | **0.00** | 4 |
| **create_study_plan** | 0.00 | 0.00 | **0.00** | 4 |

Macro F1 = **0.6188**. Weighted F1 = 0.6188 (almost uniform support).

## Confusion clusters (head, gold → pred, count ≥ 2)

These are the distinctions the 20M encoder still cannot reliably make:

1. **Identity vs enrollment**
   - `get_student_profile` → `get_subjects` (2)
   - “Which batch / enrollment info” vs “what am I studying”

2. **Quiz attempts vs quiz scores**
   - `get_quiz_results` → `get_quiz_history` (2)
   - Hard negatives in SFT reduced this vs Phase 3 but it is not gone.

3. **Open URL vs extract page**
   - `extract_webpage` → `open_url` (2)
   - Both prompts contain `https://…`; the verb (extract/scrape vs open)
     is the only cue and is still weak.

4. **Clock vs today's classes**
   - `get_current_datetime` → `get_today_schedule` (2)
   - “today” / “day” collides with the schedule cluster.

5. **Study-plan vs exam list**
   - `create_study_plan` → `get_exams` (2)
   - Multi-tool SFT teaches “plan my exams → get_exams first”, so the
     single-tool bench item “draft a prep schedule” is absorbed by the
     first-tool-of-the-chain prior.

6. **Progress is dead on this bench**
   - 0/4 recall. Prompts like “Am I getting better at physics?” and
     “Which subjects need more work?” leak into subjects / notifications.
     Progress vs study-history vs quiz-results is the weakest academic
     cluster.

## Why ~35% of bench predictions are still wrong

Not because JSON is broken (syntax = 1.00). Not because one tool ate the
distribution (top share 7.69%, entropy 4.68 vs uniform 4.91, KL to
expected 0.13). The failures are:

1. **Support is tiny at test time.** 4 paraphrases per tool, all held-out
   wording. A 22.8M encoder with mean-pooling has a shallow decision
   surface; one odd phrasing (“How many lectures did I bunk” is now
   solved for attendance, but “Which batch do I belong to” is not).
2. **First-tool-of-chain prior.** Multi-tool rows label `tools[0]` as the
   class, so `create_study_plan` and `create_quiz` are under-taught as
   *primary* tools.
3. **Confusable lexical neighbourhoods** listed above. Hard negatives
   helped (adversarial set scores *higher* than the main bench: 0.73
   head / 0.70 generated) but the remaining pairs need more contrastive
   density, not a bigger model.
4. **Argument generation is a separate bottleneck.** Oracle tool
   conditioning (gold tool id + forced JSON prefix) keeps JSON at 1.00
   but argument accuracy is only **0.359**. On the 12 bench rows with
   required args (calculator expressions, URLs) generated argument
   accuracy is **0.00** — the decoder still emits a memorised template
   (`55*19` is never produced; a training expression is). Correct tool
   + wrong args is a failed response.

## Tool head vs generated decoding

| | Head | Generated |
|---|---:|---:|
| Bench accuracy | 0.6239 | **0.6496** |
| Agree with each other | 93/117 | 93/117 |

The head is **not** strictly better. Explicit classification got the
encoder to 62%; the decoder, conditioned on that head, adds a little.
Oracle conditioning does **not** fix routing (by construction) and only
partially fixes arguments (0.36). So the remaining problem is
**both** semantic routing **and** argument generation, in that order.

No keyword router was added. Model-only numbers above are the only
routing numbers that count.
