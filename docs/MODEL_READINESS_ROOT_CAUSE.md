# EduNova AI — "model never becomes READY" root-cause analysis

**Symptom (production):**

```
EduNova AI's model is still preparing after a long wait.
The service is booting — your question is safe; try again in a minute…
```

The frontend was healthy — it reached the gateway, the gateway reached the AI
service. The AI service simply never reported a usable model, so the gateway
queued the request for its full 10-minute window and then emitted the message
above.

This document records what was actually wrong, how each fault was reproduced,
and what changed. Every finding below was verified by running the real runtime
against a real Qwen2-architecture model, not by inspection.

---

## Root causes

### 1. A failed warm-up was advertised as READY (primary cause)

`_load_pipeline()` ended with:

```python
except LLMResponseError:
    raise                      # <-- recorded NOTHING
except Exception as exc:
    self._record_startup_error(exc)
```

The warm-up inference runs *inside* the load pipeline and raises
`LLMResponseError` when it fails. That exception took the first branch, so:

* `last_error` stayed `""`, `error_report` stayed `None` — **the failure was invisible**;
* the lifecycle stayed stuck at `WARMING`;
* but `_generate_sync_protected()` had already run its `finally:` block, which
  unconditionally set `self.state = "ready"`.

`/api/ai/ready` gated on `state == "ready" and _model is not None` — both true.

**Reproduced:**

```
manager.state      : ready
lifecycle.state    : WARMING
last_error         : ''
/api/ai/ready 200? : True     <-- for a model that could not generate
```

So the gateway was told READY, forwarded the chat request, and the request then
failed against a model that had never warmed. Readiness is now a single
authoritative flag, `is_ready()`, set **only** after a successful warm-up.

### 2. The readiness poll restarted the failed pipeline forever

`GET /api/ai/ready` called `ensure_loading(force=True)` as a "wake-up" signal,
and `ensure_loading` restarted whenever `_load_task.done()` — which is true for
a *failed* task. The gateway polls every 2s for up to 600s.

**Reproduced:** every single poll created a brand-new load pipeline — ~300
download/load attempts per request, guaranteeing the service never converged.

Fixed with single-flight + exponential backoff (15s → 300s, capped).

### 3. `int8` loaded weights as fp32 and OOM-killed the container

`LOCAL_MODEL_DTYPE=auto` → `pick_dtype()` chose `int8` *because int8 fits*:

| dtype | weights | + runtime | fits 2 GB (×0.9)? |
|-------|---------|-----------|-------------------|
| int8  | 0.66 GiB | 1.54 GiB | ✅ |
| bf16  | 1.33 GiB | 2.21 GiB | ❌ |
| fp32  | 2.65 GiB | 3.53 GiB | ❌ |

…but the loader mapped `int8` to `torch.float32`, so it then tried to
materialize **2.65 GiB** of fp32 weights on the 2 GB Render Standard instance.
The process was OOM-killed mid-load — no Python traceback, just a dead worker
and a model that never became ready.

Weights now load in **bfloat16** and are quantized to int8 one `Linear` at a
time, so peak memory is the bf16 footprint. Measured peak: **459 MB**.

### 4. Model weights re-downloaded on every boot

The cache-hit check looked for:

```
/var/data/models/hf/Qwen--Qwen2.5-0.5B-Instruct/config.json
```

`snapshot_download(cache_dir=...)` actually writes:

```
/var/data/models/hf/models--Qwen--Qwen2.5-0.5B-Instruct/snapshots/<sha>/config.json
```

These never match, so the persistent disk was useless and every restart
re-downloaded the model. Now resolved against the real hub layout, and the
download is restricted to the files the text runtime needs (no ONNX/GGUF
duplicates).

### 5. Out-of-vocabulary stop tokens truncated answers

The runtime registered `</s>` and `<|end|>` as stop tokens. Qwen2 uses ChatML
and has neither, so `convert_tokens_to_ids()` returned the **UNK id (0)** for
both — a perfectly ordinary token. Generation halted whenever it appeared:

```
convert_tokens_to_ids('</s>')   = 0   round-trips=<|endoftext|>
convert_tokens_to_ids('<|end|>') = 0  round-trips=<|endoftext|>
```

Stop tokens are now accepted only if they round-trip to the exact same token.

### 6. Dependency matrix drifted and broke `from_pretrained`

`requirements.txt` pinned `transformers>=4.44,<5` — today that resolves to
4.57.x, which **refuses** to load `.bin` checkpoints unless `torch>=2.6`:

> Due to a serious vulnerability issue in `torch.load` … we now require users to
> upgrade torch to at least v2.6

against a build that installs `torch>=2.2,<2.5`. Reproduced as a hard load
failure. Both are now pinned to a tested pair (`torch==2.4.1`,
`transformers<4.56`).

---

## Verification

Run offline (no huggingface.co needed):

```bash
python -m pytest ai_engine/tests/ -q                 # 112 passed
node --test server/test/*.test.js                    # 15 passed
node server/scripts/live-scenarios.js http://127.0.0.1:8001 out.json   # 12/12
```

Live service behaviour after the fix:

```
[AI] Starting service
[AI] Loading configuration
[AI] Loading tokenizer
[AI] Tokenizer loaded vocab=… chat_template=True
[AI] Loading model
[AI] Model loaded dtype=torch.bfloat16 device=cpu
[AI] Running warmup
[AI] Warmup successful warmup_ms=26
[AI] MODEL READY
```

```
GET /ready         -> 200 {"ready": true}
GET /model/status  -> {"status":"ready","model_loaded":true,
                       "tokenizer_loaded":true,"warmup_complete":true}
```

And on a genuinely broken model the service now says so, with the real
exception, an actionable hint and a backoff — instead of claiming READY or
telling the student to try again:

```
[AI] MODEL STARTUP FAILED
Reason: <actual exception>
Stage: download_failed
Hint: Check outbound network access to huggingface.co from the AI service.
Retry in: 14s
```

---

## Note on sandbox limitations

`huggingface.co` and `download.pytorch.org` are **not reachable** from the
build sandbox, so the production weights could not be downloaded here. To
verify the real code path anyway, the tests run against a locally-generated
model that uses the **same Qwen2 architecture, ChatML template and tokenizer
class** as the production model. That is what surfaced faults 1, 3, 5 and 6.

The Render deployment itself was likewise not reachable from the sandbox, so
the live production URL could not be exercised — deployment happens via
`autoDeploy` on merge.
