# Phase 4 memory

Measured on this sandbox: Python 3.11.2, torch 2.8.0+cu128, CPU only
(`CUDA_VISIBLE_DEVICES=`). Command:

```bash
python evaluation/performance/memory_profile.py \
  --checkpoint post_training/checkpoints/edunova-hrm-20m-sft \
  --out docs/results/hrm-memory.json
```

## Table (resident set, this process)

| Stage | RSS (MiB) |
|---|---:|
| Python baseline | 11.5 |
| `import torch` | 485.2 |
| tokenizer load | 487.0 |
| model construction (no weights) | 583.5 |
| checkpoint load (fp32 weights) | 671.1 |
| `plan()` (encoder + heads) | 675.9 |
| `generate()` 16 tokens, inference_mode | 675.9 |
| Peak | **675.9** |
| Weights only (22,800,768 × 4) | 86.98 |
| Checkpoint on disk | 87.02 |

Phase 3 (torch 2.14.0 CPU) reported 626.2 MiB after generate. This session
is higher because the wheel is `2.8.0+cu128` (CUDA runtime mapped even
when we run on CPU). The **weights** did not grow in any meaningful way
(+11,520 params = +45 KiB). The framework, not the HRM, dominates.

## Where the memory is

1. **PyTorch runtime** ≈ 470 MiB just to `import torch`. This alone almost
   fills Render Free (512 MiB).
2. **fp32 weights** ≈ 87 MiB.
3. **Activations / KV / Python objects** ≈ 5 MiB on a 16-token generate
   with `torch.inference_mode()` and KV cache. Not the problem.
4. Training is never imported on the inference path.

`generate()` now runs under `torch.inference_mode()` (not just
`no_grad()`), which drops autograd state. It did not bring RSS under 512.

## Render Free 512 MiB

**Does not fit. Not close.**

`import torch` = 485 MiB. Adding the 87 MiB of weights cannot land under
512 on this runtime. FP16 would save ~43 MiB of weights and still lose
to the PyTorch import. Tying embeddings would save another 87 MiB of the
LM head and still lose. A smaller architecture would be a **different
model** and is not silently substituted.

Honest serving matrix (unchanged in intent, restated):

| Environment | Runtime |
|---|---|
| Production (Render Free 512 MiB) | existing llama.cpp / GGUF fallback |
| Development / ≥1 GiB instance | custom HRM (`LOCAL_MODEL_RUNTIME=hrm`) |
| Shadow / offline eval | custom HRM, never dual-loaded in production |

The fallback was not deleted. `registry.production` stays `null`.

## What we will not claim

- That the 20M HRM “runs on Render Free” after a flag flip.
- That disabling safety checks or lazy-import tricks made it fit. They
  did not; we did not try to hide RSS.
