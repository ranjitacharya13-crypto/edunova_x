# EduNova HRM — measured performance

Date: 2026-09-08. Numbers below were produced by `training/measure_sizes.py`,
`training/train.py --max-steps 40`, and `training/evaluate.py` in this
repository. They are not estimates and not marketing scores.

## Model

| Item | Measured |
|---|---|
| Name | edunova-hrm-20m |
| Architecture | hrm-v1 (high-level encoder + low-level decoder, custom PyTorch) |
| Parameters | **22,789,248** |
| Closed-form estimate | 22,788,480 |
| Disk (fp32 checkpoint) | **91,201,119 bytes (86.93 MiB)** |
| Tokenizer | edunova-tok-v1 |

Larger presets (30/50/70/100m) are configurable; they were **not** fully
trained in this session.

## Memory / speed (CPU)

| Item | Measured |
|---|---|
| RSS after 20m init + 8-token generate | 648.4 MiB |
| Peak RSS during 40-step training | 1290.0 MiB |
| One training step | 115.8 ms |
| Generate 8 tokens | 106.7 ms |
| Training throughput | 2.32 steps/s |

## Training (synthetic v1, 40 steps)

| Item | Measured |
|---|---|
| Train loss (avg) | 12.573 |
| Val loss | 7.671 |
| Val task accuracy | 0.667 |
| Val tool accuracy | 0.667 |
| Wall time | 17.2 s |

## Golden suite (10 cases, same 40-step checkpoint)

| Item | Measured |
|---|---|
| Tool-selection hit rate | 0.40 |
| Task-type accuracy | 0.10 |
| Generated JSON validity | 0.00 |
| Latency / case | 233 ms |

**Honest status:** 40 steps is a working training loop, not a production
tutor. JSON structured-output SFT is still required. Production Render Free
continues to use llama.cpp until these golden metrics are acceptable.

## Workflow tests (mocked tools)

`tests/hrm/test_e2e_workflows.py`: 7/7 pass (attendance, syllabus RAG, web
sources, quiz validation, study plan, AR scene, multi-tool). These test the
orchestrator contract, not language quality.

## Deployment

HRM does **not** fit Render Free 512 MiB (measured RSS 648 MiB already).
Recommended: ≥ 1024 MiB and `LOCAL_MODEL_RUNTIME=hrm` after a real SFT run.
