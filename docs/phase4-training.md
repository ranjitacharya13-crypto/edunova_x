# Phase 4 training

Experiment ID: `v0.3-tool-routing`
Checkpoint: `post_training/checkpoints/edunova-hrm-20m-sft` (gitignored)
Parent: none (fresh 20M, not mixed with tok-v1)
Architecture: hrm-v1 + tool-conditioning embedding (`n_tools × d_model` = 11,520 extra params)
Parameter count: **22,800,768** (was 22,789,248)

## Dataset (edunova-hrm-sft-v3)

```bash
python post_training/datasets/sft/build_sft.py
python evaluation/tools/build_benchmark.py
python evaluation/tools/build_adversarial.py
```

| | v2 (Phase 3) | v3 (Phase 4) |
|---|---:|---:|
| Total rows | 257 | **823** |
| Train / val | 197 / 60 | 667 / 156 |
| Train rows per tool (min) | 6 | 9 |
| Hard negatives | no | yes (stage 2) |
| Curriculum stages | no | 1–9 |
| Golden overlap | 0 | 0 |
| Benchmark overlap | 0 | 0 |
| Adversarial overlap | n/a | 0 |
| Train ∩ val | 0 | 0 |

823 < 1000. Extra rows beyond this were subject/topic fills; we stopped
rather than dump synthetic garbage. The 500-row floor is met.

Duplicates dropped: 0. Malformed: 0. Forbidden (eval-set) skipped: 3.

## Objective

```
L_total = L_language
        + λ_tool    * L_tool
        + λ_output  * L_output
        + λ_task    * L_task
        + λ_need    * L_need
```

`L_language` is token CE with:

- structure tokens × 2.5
- tool-name tokens × 4.0
- argument-span tokens × 3.0 (positions after `","arguments":`)

| Component | Weight | Why |
|---|---:|---|
| L_language | 1.0 | JSON must not regress |
| λ_tool | **2.0** (was 1.0) | Phase 3 val tool 0.60 / bench 0.48 — routing under-trained vs JSON |
| λ_output | 0.75 (was 0.5) | SEARCH_REQUEST vs TOOL_CALL vs FINAL_ANSWER |
| λ_task | 0.5 | unchanged; task head already 0.85 in Phase 3 |
| λ_need | 0.25 | binary, low capacity needed |
| structure token w | 2.5 | keep JSON = 1.00 |
| tool token w | 4.0 | anti mode-collapse |
| arg span w | 3.0 | new; decoder was memorising one argument template |

A 400-step resume to 1200 **rejected**: JSON fell to 0.9658 and generated
tool to 0.5897. Routing gains that break JSON are discarded
(`edunova-hrm-20m-sft-r1200` kept only as a negative result).

## Curriculum

Unlocked by fraction of `max_steps`:

| Fraction | Stages |
|---|---|
| 0–15% | 1 simple single-tool |
| 15–30% | + 2 hard negatives |
| 30–45% | + 3 arguments |
| 45–55% | + 4 structured output |
| 55–65% | + 5 tool-result interpretation |
| 65–75% | + 6 two-tool |
| 75–85% | + 7 multi-tool |
| 85–92% | + 8 failure recovery |
| 92–100% | + 9 ambiguous |

Sampling inside the unlocked set is still **class-balanced by tool id**.

## Decoder conditioning

Training teacher-forces the **gold** tool id into `HighLevelReasoner.tool_cond`
and adds it to the decoder start token (with the pooled summary).
Inference uses the **predicted** tool id. Oracle eval passes the gold id.

This is the model's own routing, not a keyword overlay. Prefix-forcing the
JSON wrapper is used **only** in the oracle diagnostic, never as the
primary bench number.

## Command (800-step run that was kept)

```bash
python post_training/train_sft.py \
  --config configs/model/20m.yaml \
  --max-steps 800 --batch-size 4 --eval-every 100 \
  --output post_training/checkpoints/edunova-hrm-20m-sft
```

Wall time: 225.3 s CPU. Seed 13. lr 3e-4, warmup 20, grad clip 1.0.

| Step | Val tool | Val task | Val structure | Curriculum |
|---:|---:|---:|---:|---:|
| 100 | 0.282 | 0.583 | 0.689 | 1 |
| 300 | 0.526 | 0.647 | 0.883 | 3 |
| 500 | 0.673 | 0.795 | 0.897 | 5 |
| 800 | **0.737** | 0.788 | 0.927 | 9 |

Train structure-token acc 0.920. Train loss avg 3.60 (different scale from
Phase 3 because λ_tool doubled and arg weights were added — not comparable
as a raw number).

## Tiny ablations (diagnostic only)

`python post_training/ablate.py --max-steps 40`

A ~0.6M model, 40 steps. **Not** a 20M score. It answers “does the
objective move the head at all?”

| Mode | Val tool | Val task |
|---|---:|---:|
| D language only | 0.013 | 0.058 |
| E language + tool | **0.115** | 0.058 |
| F + output head | 0.064 | 0.064 |
| G full | 0.051 | **0.519** |

Language loss alone does not train the tool head. Explicit `L_tool` does.
`L_task` in the full mix is what moves the task head. 40 steps on a tiny
net cannot rank λ values for the 20M run; the 20M λ_tool=2.0 choice is
justified by the Phase 3 gap (JSON solved, routing not), not by this table.

## What we did **not** do

- Did not scale to 30M/50M/70M/100M.
- Did not hard-code `if "attendance" in prompt`.
- Did not drop failing bench items.
- Did not mix tok-v1 weights into tok-v2.
- Did not promote `registry.production`.
