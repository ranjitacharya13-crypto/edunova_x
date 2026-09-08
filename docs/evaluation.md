# Evaluation

Golden suite: `evaluation/golden.py` (attendance, tomorrow’s classes, Unit 3,
web, quiz, study plan, AR, multi-tool, knowledge, no-web-for-attendance).

```bash
python training/evaluate.py --checkpoint training/checkpoints/edunova-hrm-20m
```

Metrics that are actually computed:

- task accuracy (high-level head vs golden task type)
- tool-selection hit rate
- JSON parse validity of generated text
- latency per case
- RSS

Promotion rule: do not ship a checkpoint that improves quizzes but regresses
DB tool selection (`ModelRegistry.promote`).

Unit tests: `ai_engine/tests/test_hrm.py`  
Workflow tests: `tests/hrm/test_e2e_workflows.py`  
Phase 4 routing / security: `tests/hrm/test_phase4_routing.py`, `tests/hrm/test_security_regression.py`

Phase 4 full diagnosis (tool-head vs generated vs oracle, confusion, F1):

```bash
python evaluation/phase4_eval.py \
  --checkpoint post_training/checkpoints/edunova-hrm-20m-sft \
  --out docs/results/hrm-phase4-eval.json
```
