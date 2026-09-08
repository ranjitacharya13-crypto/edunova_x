# Phase 4 results

Date: 2026-09-08.
Checkpoint kept: `post_training/checkpoints/edunova-hrm-20m-sft`
(800 steps, tok-v2, 22,800,768 params). Resume-to-1200 **rejected**
(JSON 1.00 → 0.9658).

Classification: **NOT READY — routing failure**

(Arguments are the next bottleneck; memory independently fails Render
Free. Routing is the gate that is still red.)

## Comparison

| Metric | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|---|---:|---:|---:|---:|
| JSON syntax | 0.00 | 0.70 / 0.79 | **1.00** | **1.00** |
| Schema valid | N/A | 0.70 / 0.20 | **1.00** | **1.00** |
| Tool-head Top-1 | N/A | N/A | N/A | **0.6239** |
| Tool-head Top-3 | N/A | N/A | N/A | **0.8034** |
| Generated tool | 0.40 plan | 0.037 | 0.4786 | **0.6496** |
| Argument accuracy | N/A | N/A | N/A | **0.00** (12 required-arg rows) / **0.359** oracle |
| Macro F1 (head) | N/A | N/A | N/A | **0.6188** |
| Workflow success | N/A | mocked 7/7 | mocked 7/7 | mocked **1.00** (3 scripted) + 7/7 e2e tests |
| Mode collapse | N/A | 78% | 9.4% | **7.69%** |
| Peak RSS (MiB) | ~648 | ~626 | 626.2 | **675.9** (torch 2.8+cu128) |
| Latency | 233 ms/case | N/A | ~223 ms/case | ~117 ms generate-16; bench 117 both-modes 20.4 s |

N/A = not measured in that phase. No fabricated values.

Golden (eval_structured, 10 cases): plan tool 0.60 (was 0.50), plan task
0.50, JSON 1.00 constrained and unconstrained, schema 1.00.

## Gates vs target

| Gate | Target | Measured | Pass? |
|---|---:|---:|---|
| Tool-head Top-1 | ≥ 0.85 | 0.6239 | no |
| Tool-head Top-3 | ≥ 0.95 | 0.8034 | no |
| Generated tool | ≥ 0.80 | 0.6496 | no |
| Arguments | ≥ 0.85 | 0.00 / 0.359 oracle | no |
| JSON syntax | ≥ 0.98 | 1.00 | yes |
| Schema validity | ≥ 0.98 | 1.00 | yes |
| End-to-end workflows | ≥ 0.80 | mocked 1.00; model-routed e2e not 0.80 | no (routing) |
| Mode collapse | < 0.15 | 0.0769 | yes |
| Security | 100% | allowlist / identity tests pass | yes |
| Render Free 512 MiB | fit | 675.9 peak | no |

## Tool head vs generated vs oracle

Same 117 prompts, temperature 0, seed 13, max 96 new tokens.

| | Accuracy |
|---|---:|
| A. Tool head top-1 | 0.6239 |
| A. Tool head top-3 | 0.8034 |
| B. Generated tool (model-only, head-conditioned embedding, no prefix force) | 0.6496 |
| C. Oracle tool id + forced JSON prefix, argument match | 0.359 |
| Head ∩ generated agreement | 93/117 |

No fallback-assisted number is reported because no keyword fallback exists.

## Failure analysis (required questions)

**Why were 52% of tool predictions still wrong?**
They are not 52% any more: generated-tool error is **35%**. Of that, JSON
is 0%. The rest is near-neighbour confusion (profile/subjects,
quiz-history/results, open_url/extract, datetime/today, study-plan/exams)
plus two tools at 0 recall (`get_progress`, `create_study_plan`). See
`docs/phase4-confusion-analysis.md`.

**Which tools are hardest?**
`get_progress` and `create_study_plan` (F1 0). Then `get_current_datetime`
(0.25), `get_syllabus` (0.33), `create_quiz` / `extract_webpage` (0.40).

**Is the tool head better than generated decoding?**
No. Generated 0.6496 > head 0.6239. They agree 80% of the time.

**Are arguments the next bottleneck?**
Yes, once routing is fixed. Oracle (gold tool) argument accuracy is only
0.359; on required-arg bench rows it is 0.00. The decoder still emits a
memorised expression/URL more often than the one in the prompt.

**Does oracle conditioning significantly improve performance?**
It preserves JSON (1.00) and lifts argument accuracy from ~0 to 0.36. It
does not, by construction, fix routing. Not a silver bullet.

**Did balanced data help?**
Yes. v2 had 6 rows/tool and 47.9% generated-tool; v3 has ≥9 train
rows/tool, 823 total, 65.0% generated-tool, collapse 9.4% → 7.7%.

**Did explicit tool loss help?**
Yes. Tiny ablation: language-only tool-head acc 0.013 vs language+tool
0.115. 20M val tool-head 0.74 with λ_tool=2.0 (Phase 3 val 0.60).

**Did hard negatives help?**
The held-out adversarial set (confusable wording, never trained) scores
**higher** than the main bench (0.73 head / 0.70 generated). The
distinctions we taught transfer. The remaining errors are pairs we still
under-taught (progress, study-plan-as-primary).

**Did curriculum help?**
Val tool-head climbed in lockstep with unlocked stages (0.28 → 0.74).
We did not run a matched no-curriculum 800-step 20M control (cost). The
tiny ablation is too small to isolate it. Reported as used, not as a
proven causal lever.

**What causes remaining failures?**
Shallow mean-pooled encoder + 4 test paraphrases/tool + first-tool-of-chain
prior on multi-tool rows. Not tokenizer holes (all 29 tools are atomic as
of tok-v2 + missing `open_url`/`extract_webpage`/`get_current_datetime`/
`open_feature` tokens added this phase).

**What causes memory usage?**
`import torch` ≈ 485 MiB. Weights 87 MiB. Activations negligible.

**Can the model actually fit Render Free?**
**No.** See `docs/phase4-memory.md`.

**What is the next bottleneck?**
1. Routing among confusable tools / zero-recall tools (progress, study-plan
   as primary). More contrastive SFT on those pairs, keep 20M.
2. Then argument generation (span loss helped JSON more than args).
3. Then real (not mocked) multi-tool interpretation.
4. Memory is a deployment constraint, not an ML one: keep llama.cpp on
   512 MiB; HRM on ≥1 GiB.

## Reproduce

```bash
python post_training/datasets/sft/build_sft.py
python evaluation/tools/build_benchmark.py
python evaluation/tools/build_adversarial.py
python post_training/train_sft.py --config configs/model/20m.yaml --max-steps 800
python evaluation/phase4_eval.py \
  --checkpoint post_training/checkpoints/edunova-hrm-20m-sft \
  --out docs/results/hrm-phase4-eval.json
python evaluation/structured_output/eval_structured.py \
  --checkpoint post_training/checkpoints/edunova-hrm-20m-sft \
  --golden --benchmark evaluation/tools/benchmark.jsonl \
  --out docs/results/hrm-sft-eval.json
python evaluation/performance/memory_profile.py \
  --checkpoint post_training/checkpoints/edunova-hrm-20m-sft \
  --out docs/results/hrm-memory.json
python post_training/ablate.py --max-steps 40 --out docs/results/hrm-phase4-ablate.json
```

Primary decode: temperature 0, no top-k/top-p, max 96 new tokens, seed 13.

## Registry

`registry.production = null`. llama.cpp remains the production default.
v0.3-tool-routing is registered, not promoted.
