# Phase 2 diagnosis: why the 20M HRM produced 0% valid JSON

Date: 2026-09-08 (rebuilt in this session after the original lab notes were
lost with the previous sandbox; code + numbers here are re-measured).

Phase 1 golden eval scored `json_validity = 0.00` on all 10 cases. Three
independent defects combined to produce that result. Each is verifiable in
the pre-Phase-2 tree (git history of PR #65).

## Defect 1 — train/inference input mismatch

`training/preprocessing/prepare.py` (v1) encoded prompt **and** completion
into one stream and fed it to both the encoder and the decoder
(`decoder_input_ids = input_ids`). At inference, `HRMRuntime` fed only the
prompt to the encoder and started the decoder at `<bos>`. The decoder was
never trained for the distribution it saw at inference.

**Fix:** aligned teacher forcing. Encoder input = chat prefix ending at
`<assistant>` (`tokenizer.prompt_ids`). Decoder input =
`[<assistant>] + completion + [<eos>]`; labels mask the leading
`<assistant>` (`encode_example_aligned`). `generate()` accepts
`start_token_id` and the runtime passes `<assistant>` for tok-v2
checkpoints (`ai_engine/hrm/inference/runtime.py`).

## Defect 2 — the byte tokenizer never emitted STRUCTURE_TOKENS

`edunova-tok-v1` kept `TOOL_CALL`, `FINAL_ANSWER`, tool names, etc. in the
vocabulary, but `encode()` was byte-only + BPE merges: no code path ever
produced those atomic ids. The decoder therefore had to spell
`{"type":"TOOL_CALL","tool":"get_attendance","arguments":{}}` as ~55 single
bytes at inference — while training never taught it to (labels contained
the same byte stream, never the structure tokens the loss weights were
meant to emphasize).

**Fix:** `edunova-tok-v2` (`ai_engine/hrm/tokenizer/bpe.py`). `encode()` is
a longest-match scan over all multi-char vocab tokens — specials,
STRUCTURE_TOKENS, TOOL_TOKENS, new JSON wrappers (`{"type":"`, `","tool":"`,
`","arguments":`, …) and JSON field names, plus EDU_TERMS — with UTF-8 byte
fallback; BPE merges are trained and applied only inside non-atomic runs.
The same TOOL_CALL above is now 7 tokens. Round-trip and multilingual tests
in `ai_engine/tests/test_hrm.py` pass unchanged.

## Defect 3 — 40 optimizer steps on byte-length targets

Phase 1 stopped at 40 steps (`training/train.py --max-steps 40`) with
val_loss 7.671. Even with a correct tokenizer, 40 steps cannot teach JSON
syntax + tool routing on a randomly-initialized 22.8M model.

**Fix:** a real SFT run, `post_training/train_sft.py --config
configs/model/20m.yaml --max-steps 300`, class-balanced sampling across all
29 tools, CE weighted 2.5× on structure tokens and 4.0× on tool-name tokens
(`training/loss.py`), tracked by structure-token accuracy.

## Follow-up measured in this session (not in the original Phase 2 notes)

The first Phase 2 run mode-collapsed: the decoder answered 84/107 bench
prompts with `retrieve_learning_materials` + `{}` (bench tool-name accuracy
0.037). Root causes addressed here:

- **Class-imbalanced SFT data** — quiz/multi-tool prompts all started with
  `retrieve_learning_materials`, so it was the modal tool completion. Now
  every allowlisted tool has the same number of training completions and
  the sampler draws uniformly over tool classes each step.
- **Flat CE on the tool field** — one atomic token decides routing.
  `training/loss.py` gives tool-name tokens 4.0× weight; effect is measured
  in `docs/results/hrm-sft-eval.json` (`predicted_tool_top3` shows whether
  collapse recurs).
- **Identical arguments** — collapse included `"arguments":{}` everywhere;
  SFT rows now vary `subject`/`query`/`unit`/`expression`/`view` values.

Measured before/after lives in `docs/PERFORMANCE_REPORT.md`.
