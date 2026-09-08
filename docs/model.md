# EduNova HRM — custom model

EduNova HRM is a **project-owned PyTorch hierarchical reasoner**. It is not
Llama, Qwen, GPT-2, SmolLM, Phi, or any other third-party causal LM with
renamed weights.

## What it is

Two reasoning levels in **one** module (`ai_engine/hrm/hrm.py`):

1. **High-level reasoner** — bidirectional encoder over the prompt. Heads
   predict task type, whether tools are needed, which allowlisted tools, and
   output type (`FINAL_ANSWER`, `TOOL_CALL`, `QUIZ`, …).
2. **Low-level reasoner** — causal decoder with cross-attention to the
   high-level memory. It generates tokens (JSON or natural language)
   conditioned on that plan.

The model does **not** memorize student records, syllabi, or the web.
Those come from tools, RAG, and web search executed by the backend.

## Sizes

Configurable presets in `configs/model/{20,30,50,70,100}m.yaml`.

Parameter counts are **measured** from `sum(p.numel())` after construction
(see `training/checkpoints/*/train_metrics.json` after you train). Closed-form
estimates live in `HRMConfig.estimate_parameters()`.

Default for CPU/low RAM: **20m**.

## Tokenizer

`EduNovaTokenizer` (`edunova-tok-v1`) is byte-level BPE with frozen special
tokens for tools and structured output. A vocab change is a **major** model
version.

## Runtime vs fallback

| Environment | Runtime | Why |
|---|---|---|
| Render Free 512 MiB | `llama_cpp` (existing SmolLM2-135M GGUF) | PyTorch import + HRM weights do not honestly fit 512 MiB |
| Local / ≥1 GiB | `LOCAL_MODEL_RUNTIME=hrm` | Custom EduNova model is the brain |

This is migration, not a secret wrapper: when `hrm` is selected, llama.cpp is
not loaded.

## Structured outputs

Validated in `ai_engine/hrm/outputs.py` and `orchestration/validators.py`.
The model never executes tools, SQL, or shell.

## Training

```bash
python -m venv .venv
.venv/bin/pip install -r training/requirements.txt
.venv/bin/python training/train.py --config configs/model/20m.yaml
.venv/bin/python training/evaluate.py --checkpoint training/checkpoints/edunova-hrm-20m
```

Training data is project-generated synthetic educational + tool-use JSONL
(`training/datasets/`, license documented in `manifest.json`). No private
student conversations.
