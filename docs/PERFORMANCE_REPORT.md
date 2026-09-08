# EduNova HRM — measured performance

Date: 2026-09-08. Numbers below were produced by `training/measure_sizes.py`,
`post_training/train_sft.py`, `evaluation/structured_output/eval_structured.py`,
`evaluation/performance/memory_profile.py`, and `evaluation/shadow.py` in this
repository. They are not estimates and not marketing scores. Raw artifacts:
`docs/results/hrm-sft-eval.json`, `docs/results/hrm-memory.json`,
`docs/results/hrm-shadow.json`, `post_training/datasets/sft/metadata.json`.

## Model

| Item | Measured |
|---|---|
| Name | edunova-hrm-20m |
| Architecture | hrm-v1 (high-level encoder + low-level decoder, custom PyTorch) |
| Parameters | **22,789,248** (unchanged from Phase 1 — no enlargement) |
| Disk (fp32 checkpoint) | **86.98 MiB** |
| Tokenizer | **edunova-tok-v2** (longest-match atomic structure/JSON/tool tokens; 4,096 vocab) |

## Phase history (all measured, same 20M architecture)

| Metric | Phase 1 (tok-v1, 40 steps) | Phase 2 previous run† (tok-v2, 300 steps) | **This run (tok-v2, 600 steps)** |
|---|---|---|---|
| Golden JSON syntax (constrained) | 0.00 | 0.70 | **1.00** |
| Golden JSON syntax (unconstrained) | 0.00 | 0.40 | **1.00** |
| Golden schema valid (constrained / unconstrained) | — | 0.70 / 0.20 | **1.00 / 1.00** |
| Golden plan tool accuracy | 0.40 | 0.40 | **0.50** |
| Golden plan task accuracy | 0.10 | 0.20 | **0.50** |
| Bench JSON syntax (107→117 cases) | — | 0.79 | **1.00** |
| Bench tool-name accuracy | — | 0.037 | **0.4786** |
| Bench decoder mode-collapse share | — | 78% retrieve_learning_materials | **9.4% top tool (calculator, 11/117)** |
| Structure-token accuracy (train) | — | 0.573 | **0.980** |

† The previous Phase 2 run was committed locally as a022ac9 in a sandbox
that closed before push; its numbers are from the lab brief. Code and data
were rebuilt in this session and re-measured; this run's columns are the
current truth.

## Training (this run)

| Item | Measured |
|---|---|
| Command | `post_training/train_sft.py --config configs/model/20m.yaml --max-steps 300` ×2 (second leg `--resume`) |
| Steps | 600 total (300 fresh + 300 resume) |
| SFT data | 257 rows (197 train / 60 val), 6 completions per tool, class-balanced sampling |
| Golden/benchmark prompt overlap in SFT data | **0 (asserted at build)** |
| Loss | CE weighted 2.5× structure tokens, 4.0× tool-name tokens + head losses |
| Train loss avg (resume leg) | 0.548 |
| Val (60 SFT rows): tool / task / structure acc | 0.60 / 0.85 / 0.871 |
| Wall time | ~4 min per 300-step leg, CPU |

## Memory / serving size (torch 2.14.0+cu130, CPU, this sandbox)

| Item | Measured |
|---|---|
| RSS after `import torch` | 486.9 MiB |
| RSS after checkpoint load | 619.9 MiB |
| RSS after 8-token generate | 626.2 MiB |
| Checkpoint on disk | 86.98 MiB |
| Weights only (fp32 params) | 86.93 MiB |
| Fits Render Free 512 MiB | **NO** |

## Promotion decision

Gates: `json_syntax ≥ 0.70` AND `tool_name_accuracy ≥ 0.70` AND
`plan_tool_accuracy ≥ 0.70`.

| Gate | Measured | Pass? |
|---|---|---|
| json_syntax (bench, constrained) | 1.00 | ✅ |
| tool_name_accuracy (bench 117) | 0.4786 | ❌ |
| plan_tool_accuracy (golden 10) | 0.50 | ❌ |

**Result: NOT PROMOTED. `post_training/registry/registry.json` keeps
`production: null`. llama.cpp remains the default production runtime; the
HRM path stays behind `LOCAL_MODEL_RUNTIME=hrm` for development.**
The model must not be described as "supporting tool calling" in production.

## Shadow eval (offline)

`evaluation/shadow.py` ran 24 bench prompts offline: HRM schema_ok 1.0,
tool hit 0.458; llama.cpp side **NOT IMPLEMENTED** in this sandbox (no GGUF
available — not a failure of the harness). Production is never dual-loaded.

## Phase 4 (this session, 20M kept)

See `docs/phase4-results.md`. Kept checkpoint: 800-step `edunova-hrm-20m-sft`
(22,800,768 params, tok-v2, sft-v3 823 rows). Generated tool **0.6496**
(was 0.4786), JSON **1.00** (no regression), tool-head top-1 **0.6239**,
mode-collapse **7.69%**. Still below routing gates. Render Free: **no**
(peak RSS 675.9 MiB). `registry.production` remains null.

## What limits tool accuracy now

- The high-level router heads train on ≤197 prompts for 12 task types / 30
  tools; golden plan misses (e.g. `ar_cpu → SUMMARY`, `knowledge_recursion →
  DB_QUERY`) are under-training, not architecture errors.
- Decoder no longer collapses (top predicted tool 9.4%), but routing among
  the 29 tools tops out at ~0.48 zero-shot on unseen bench phrasings.
- Levers, in order of expected value: more SFT rows per tool (≥20),
  curriculum on paraphrase robustness, then — only with measured evidence —
  a larger preset.

## Workflow tests (mocked tools)

`ai_engine/tests/test_hrm.py`: 21/21 pass. `tests/hrm/test_e2e_workflows.py`:
7/7 pass. These test the orchestrator contract, not language quality.

## Reproduce

```bash
python post_training/datasets/sft/build_sft.py            # SFT data (asserts no golden/bench overlap)
python evaluation/tools/build_benchmark.py                # 117-case bench (asserts disjointness)
python post_training/train_sft.py --config configs/model/20m.yaml --max-steps 300
python post_training/train_sft.py --config configs/model/20m.yaml --max-steps 300 \
    --resume post_training/checkpoints/edunova-hrm-20m-sft --output ...-r600
python evaluation/structured_output/eval_structured.py --checkpoint <ckpt> --golden \
    --benchmark evaluation/tools/benchmark.jsonl --out docs/results/hrm-sft-eval.json
python evaluation/performance/memory_profile.py --checkpoint <ckpt> --out docs/results/hrm-memory.json
python evaluation/shadow.py --hrm-checkpoint <ckpt> --limit 24 --out docs/results/hrm-shadow.json
```
