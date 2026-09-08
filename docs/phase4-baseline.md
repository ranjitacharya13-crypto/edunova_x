# Phase 4 baseline (before any Phase 4 training)

Date: 2026-09-08.

This file is the frozen pre-fix snapshot. It is not overwritten by later
Phase 4 runs. Later numbers live in `docs/phase4-results.md`.

The Phase 3 / v0.2-sft checkpoint (`post_training/checkpoints/edunova-hrm-20m-sft-r600`)
is gitignored and was **not present** in this checkout, so the numbers below
are the last measured artifacts already committed in-tree:

- `docs/PERFORMANCE_REPORT.md`
- `docs/results/hrm-sft-eval.json`
- `docs/results/hrm-memory.json`
- `docs/results/hrm-shadow.json`
- `post_training/datasets/sft/metadata.json` (v2, 257 rows)
- `post_training/registry/registry.json`

They are not re-estimated.

## Identity

| Item | Value |
|---|---|
| Git commit (this branch start) | `5ea5a6eeee417d097f11a082deefae9bb5d13b4a` (main) |
| Model | edunova-hrm-20m |
| Architecture | hrm-v1 (encoder 3 × decoder 6, d_model=384, 6 heads) |
| Parameter count | 22,789,248 |
| Tokenizer | edunova-tok-v2 (vocab 4096) |
| Training checkpoint | `post_training/checkpoints/edunova-hrm-20m-sft-r600` (not in git) |
| Dataset | edunova-hrm-sft-v2 |
| Dataset size | 257 rows (197 train / 60 val) |
| Training steps | 600 |
| Validation loss (SFT, combined) | 0.548 train loss avg (resume leg) |
| Val tool / task / structure acc | 0.60 / 0.85 / 0.871 |

## Golden (10 cases)

| Metric | Constrained | Unconstrained |
|---|---:|---:|
| JSON syntax | 1.00 | 1.00 |
| Schema validity | 1.00 | 1.00 |
| Plan tool accuracy (tool head) | 0.50 | 0.50 |
| Plan task accuracy | 0.50 | 0.50 |

## Benchmark (117 cases)

| Metric | Constrained | Unconstrained |
|---|---:|---:|
| JSON syntax | 1.00 | 1.00 |
| Tool-name accuracy (generated) | 0.4786 | 0.4786 |
| Tool-head Top-1 | N/A (not separately reported in Phase 3) | N/A |
| Tool-head Top-3 | N/A | N/A |
| Argument accuracy | N/A | N/A |
| Macro F1 | N/A | N/A |
| Workflow success | N/A as a single number; mocked e2e tests 7/7 | |

Top predicted tools (generated): calculator 11/117 (9.4%), get_ar_lessons 8, get_progress 7.

## Other

| Metric | Value |
|---|---|
| Mode-collapse top-tool share | 9.4% (calculator) |
| Latency (bench 117, both modes) | 26.1 s wall (~0.22 s/case) |
| RSS after `import torch` | 486.9 MiB |
| RSS after checkpoint load | 619.9 MiB |
| RSS after 8-token generate | 626.2 MiB |
| Peak RSS (serving path) | 626.2 MiB (training peak historically 1290 MiB) |
| CPU | sandbox CPU, torch 2.14.0 (original lab) / 2.8.0 this session |
| Registry production | `null` |
| llama.cpp fallback | present, default production runtime |

## What this baseline does **not** contain

Phase 3 did not publish a confusion matrix, per-tool F1, tool-head vs
generated split, oracle-conditioning argument accuracy, or argument
accuracy on the 117-case bench. Those holes are why Phase 4 exists.

## Reproduce the Phase 3 numbers (requires the r600 checkpoint)

```bash
python post_training/datasets/sft/build_sft.py            # v2 builder as of Phase 3
python evaluation/tools/build_benchmark.py
python evaluation/structured_output/eval_structured.py \
    --checkpoint post_training/checkpoints/edunova-hrm-20m-sft-r600 \
    --golden --benchmark evaluation/tools/benchmark.jsonl \
    --out docs/results/hrm-sft-eval.json
python evaluation/performance/memory_profile.py \
    --checkpoint post_training/checkpoints/edunova-hrm-20m-sft-r600 \
    --out docs/results/hrm-memory.json
```
