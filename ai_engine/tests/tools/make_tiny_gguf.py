"""Build a tiny but STRUCTURALLY REAL GGUF model for runtime integration tests.

This is NOT an AI model — the weights are random, so the text it generates is
gibberish. Its only job is to be a genuine GGUF file that real llama.cpp can
memory-map, load and run tokens through, so the EduNova local-model pipeline
(download -> verify -> load -> generate -> grammar-constrained JSON) can be
exercised end to end in CI and in sandboxes without downloading 380MB of real
weights from HuggingFace.

Usage:
    python ai_engine/tests/tools/make_tiny_gguf.py /tmp/tiny-model.gguf

Requires: `pip install gguf numpy` (dev-only, not a runtime dependency).
"""

from __future__ import annotations

import sys

import numpy as np

try:
    import gguf
except ImportError:  # pragma: no cover - dev tool
    raise SystemExit("pip install gguf numpy to use this dev tool")

# Deliberately tiny, but large enough that llama.cpp accepts the shapes.
N_VOCAB = 512
N_EMBD = 64
N_LAYER = 2
N_HEAD = 4
N_HEAD_KV = 2
N_FF = 128
N_CTX = 4096
HEAD_DIM = N_EMBD // N_HEAD


def _rand(*shape: int) -> np.ndarray:
    rng = np.random.default_rng(1234)
    return (rng.standard_normal(shape) * 0.02).astype(np.float32)


def build(path: str) -> None:
    writer = gguf.GGUFWriter(path, "llama")

    writer.add_name("edunova-tiny-test")
    writer.add_context_length(N_CTX)
    writer.add_embedding_length(N_EMBD)
    writer.add_block_count(N_LAYER)
    writer.add_feed_forward_length(N_FF)
    writer.add_rope_dimension_count(HEAD_DIM)
    writer.add_head_count(N_HEAD)
    writer.add_head_count_kv(N_HEAD_KV)
    writer.add_layer_norm_rms_eps(1e-5)
    writer.add_file_type(gguf.LlamaFileType.ALL_F32)

    # Minimal SPM vocabulary: control tokens + full byte fallback + a few
    # ChatML-ish pieces so prompt rendering has something to tokenize.
    tokens: list[str] = ["<unk>", "<s>", "</s>"]
    scores: list[float] = [0.0, 0.0, 0.0]
    types: list[int] = [
        gguf.TokenType.UNKNOWN,
        gguf.TokenType.CONTROL,
        gguf.TokenType.CONTROL,
    ]
    for byte in range(256):
        tokens.append(f"<0x{byte:02X}>")
        scores.append(0.0)
        types.append(gguf.TokenType.BYTE)
    filler = 0
    while len(tokens) < N_VOCAB:
        tokens.append(f"\u2581tok{filler}")
        scores.append(-float(filler))
        types.append(gguf.TokenType.NORMAL)
        filler += 1

    writer.add_tokenizer_model("llama")
    writer.add_tokenizer_pre("default")
    writer.add_token_list(tokens)
    writer.add_token_scores(scores)
    writer.add_token_types(types)
    writer.add_bos_token_id(1)
    writer.add_eos_token_id(2)
    writer.add_unk_token_id(0)
    writer.add_add_bos_token(True)
    writer.add_add_eos_token(False)

    n_embd_kv = HEAD_DIM * N_HEAD_KV
    writer.add_tensor("token_embd.weight", _rand(N_VOCAB, N_EMBD))
    for layer in range(N_LAYER):
        writer.add_tensor(f"blk.{layer}.attn_norm.weight", np.ones(N_EMBD, dtype=np.float32))
        writer.add_tensor(f"blk.{layer}.attn_q.weight", _rand(N_EMBD, N_EMBD))
        writer.add_tensor(f"blk.{layer}.attn_k.weight", _rand(n_embd_kv, N_EMBD))
        writer.add_tensor(f"blk.{layer}.attn_v.weight", _rand(n_embd_kv, N_EMBD))
        writer.add_tensor(f"blk.{layer}.attn_output.weight", _rand(N_EMBD, N_EMBD))
        writer.add_tensor(f"blk.{layer}.ffn_norm.weight", np.ones(N_EMBD, dtype=np.float32))
        writer.add_tensor(f"blk.{layer}.ffn_gate.weight", _rand(N_FF, N_EMBD))
        writer.add_tensor(f"blk.{layer}.ffn_up.weight", _rand(N_FF, N_EMBD))
        writer.add_tensor(f"blk.{layer}.ffn_down.weight", _rand(N_EMBD, N_FF))
    writer.add_tensor("output_norm.weight", np.ones(N_EMBD, dtype=np.float32))
    writer.add_tensor("output.weight", _rand(N_VOCAB, N_EMBD))

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/tmp/edunova-tiny-test.gguf"
    build(target)
    print(f"wrote {target}")
