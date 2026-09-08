# Post-training

Directory: `post_training/`.

## Methods that actually run

- **Full SFT**: `post_training/pipelines/sft.py` — real AdamW updates.
- **LoRA**: `post_training/adapters/lora.py` — freezes base `Linear` modules
  and adds trainable A/B. Zero-init B so injection does not change outputs
  until training. `lora_state_dict` saves only adapter tensors.

## Registry and rollback

`post_training/registry/registry.py`

- Every version stores architecture, tokenizer, dataset, stage, checkpoint,
  parent, adapters, evaluation, date.
- `promote()` refuses a candidate whose tool-selection accuracy is worse than
  production (quiz gains cannot hide DB-tool regressions).
- `rollback()` restores the previous production pointer. Switching is never
  irreversible.

## Preference data

Schema: `post_training/datasets/preference_schema.json`.

Raw student chats are **never** trained on automatically. Pipeline:

collection → consent → PII detection → anonymization → filtering →
dedup → human review → versioning → training
