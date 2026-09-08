---
language:
  - en
  - hi
  - ta
license: apache-2.0
library_name: pytorch
tags:
  - edunova
  - hierarchical-reasoning
  - education
  - tool-use
  - custom-architecture
---

# EduNova HRM

**Custom EduNova hierarchical reasoning model.** This is not a fine-tune or
rename of Llama, Qwen, GPT-2, SmolLM, Phi, Gemma, or any other third-party LLM.

## Architecture

Two-level Transformer implemented in `ai_engine/hrm/`:

- High-level encoder: task type, tool routing, output type
- Low-level decoder: token generation with cross-attention to the high-level memory

Tokenizer: `edunova-tok-v1` (byte-level BPE, project-controlled).

## Intended use

Reasoning/orchestration brain for EduNova X. Student facts come from the
EduNova database; documents from RAG; current events from web search.

## Out of scope

- Memorizing a student’s marks, attendance, or timetable
- Unrestricted SQL, shell, or filesystem access
- Rendering AR/3D (emits `AR_SCENE` JSON only)

## Limitations

A 20M-parameter model trained on synthetic tool-use data will not match a
general 7B LLM on open-ended prose. Quality comes from tools + retrieval +
post-training. Measured numbers belong in `train_metrics.json` after you run
`training/train.py` — this card does not invent scores.

## Weights

Checkpoints are produced by training and are **not** committed to git (size).
Export with `python training/export.py --checkpoint training/checkpoints/edunova-hrm-20m`.

## Safety

Allowlisted tools only. Prompt injection in retrieved text is treated as data.
No student PII in weights.
