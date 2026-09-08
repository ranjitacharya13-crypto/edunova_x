"""Project-controlled byte-level BPE tokenizer (EduNovaTokenizer v1).

Byte fallback means any Unicode (including Devanagari, Tamil, math, JSON)
tokenizes without UNK holes. Vocabulary is frozen at release; a vocab change
is a major model version.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path
import json
import re
from typing import Iterable

from .specials import EDU_TERMS, SPECIAL_TOKENS, STRUCTURE_TOKENS, TOOL_TOKENS

TOKENIZER_VERSION = "edunova-tok-v1"


class EduNovaTokenizer:
    def __init__(self, vocab: dict[str, int] | None = None, merges: list[tuple[str, str]] | None = None):
        self.version = TOKENIZER_VERSION
        if vocab is None:
            tokens = list(SPECIAL_TOKENS)
            tokens.extend(STRUCTURE_TOKENS)
            tokens.extend(TOOL_TOKENS)
            tokens.extend(EDU_TERMS)
            # bytes 0-255 as single-char tokens
            for i in range(256):
                ch = chr(i)
                if ch not in tokens:
                    tokens.append(ch)
            self.token_to_id = {t: i for i, t in enumerate(tokens)}
            self.merges: list[tuple[str, str]] = []
        else:
            self.token_to_id = dict(vocab)
            self.merges = list(merges or [])
        self.id_to_token = {i: t for t, i in self.token_to_id.items()}
        self.pad_id = self.token_to_id["<pad>"]
        self.bos_id = self.token_to_id["<bos>"]
        self.eos_id = self.token_to_id["<eos>"]
        self.unk_id = self.token_to_id["<unk>"]
        self._merge_ranks = {pair: i for i, pair in enumerate(self.merges)}

    @property
    def vocab_size(self) -> int:
        return len(self.token_to_id)

    def _to_bytes(self, text: str) -> list[str]:
        return [chr(b) for b in text.encode("utf-8")]

    def _apply_merges(self, symbols: list[str]) -> list[str]:
        if not self._merge_ranks:
            return symbols
        while True:
            pairs = [(symbols[i], symbols[i + 1]) for i in range(len(symbols) - 1)]
            if not pairs:
                break
            ranked = [self._merge_ranks[p] for p in pairs if p in self._merge_ranks]
            if not ranked:
                break
            best = min(ranked)
            a, b = self.merges[best]
            i = 0
            new: list[str] = []
            while i < len(symbols):
                if i < len(symbols) - 1 and symbols[i] == a and symbols[i + 1] == b:
                    new.append(a + b)
                    i += 2
                else:
                    new.append(symbols[i])
                    i += 1
            symbols = new
        return symbols

    def encode(self, text: str, add_special: bool = False) -> list[int]:
        symbols = self._apply_merges(self._to_bytes(text or ""))
        ids = [self.token_to_id.get(s, self.unk_id) for s in symbols]
        if add_special:
            return [self.bos_id] + ids + [self.eos_id]
        return ids

    def decode(self, ids: Iterable[int], skip_special: bool = True) -> str:
        special = set(SPECIAL_TOKENS)
        parts: list[str] = []
        for i in ids:
            tok = self.id_to_token.get(int(i), "")
            if skip_special and tok in special:
                continue
            parts.append(tok)
        raw = "".join(parts)
        try:
            return raw.encode("latin-1").decode("utf-8")
        except UnicodeError:
            return raw

    def encode_chat(self, system: str, user: str, assistant: str | None = None, untrusted: str = "") -> list[int]:
        chunks = ["<bos>", "<system>", system, "</system>", "<user>", user, "</user>"]
        if untrusted:
            chunks.extend(["<untrusted>", untrusted, "</untrusted>"])
        chunks.append("<assistant>")
        ids: list[int] = []
        for chunk in chunks:
            if chunk.startswith("<") and chunk in self.token_to_id:
                ids.append(self.token_to_id[chunk])
            else:
                ids.extend(self.encode(chunk))
        if assistant is not None:
            ids.extend(self.encode(assistant))
            ids.append(self.eos_id)
        return ids

    def pad(self, sequences: list[list[int]], max_len: int | None = None) -> tuple[list[list[int]], list[list[int]]]:
        max_len = max_len or max((len(s) for s in sequences), default=0)
        ids, mask = [], []
        for seq in sequences:
            seq = seq[:max_len]
            pad = max_len - len(seq)
            ids.append(seq + [self.pad_id] * pad)
            mask.append([1] * len(seq) + [0] * pad)
        return ids, mask

    def save(self, directory: str | Path) -> None:
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": self.version,
            "vocab": self.token_to_id,
            "merges": [list(p) for p in self.merges],
        }
        (directory / "tokenizer.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    @classmethod
    def load(cls, directory: str | Path) -> "EduNovaTokenizer":
        payload = json.loads(Path(directory, "tokenizer.json").read_text(encoding="utf-8"))
        merges = [tuple(p) for p in payload.get("merges") or []]
        tok = cls(vocab=payload["vocab"], merges=merges)
        tok.version = payload.get("version", TOKENIZER_VERSION)
        return tok

    @classmethod
    def train(cls, texts: Iterable[str], vocab_size: int = 4096, min_merge_count: int = 2) -> "EduNovaTokenizer":
        tok = cls()
        if vocab_size <= tok.vocab_size:
            return tok
        stats: Counter[tuple[str, str]] = Counter()
        corpus: list[list[str]] = []
        for text in texts:
            symbols = tok._to_bytes(text)
            corpus.append(symbols)
            stats.update((symbols[i], symbols[i + 1]) for i in range(len(symbols) - 1))
        merges: list[tuple[str, str]] = []
        token_to_id = dict(tok.token_to_id)
        while len(token_to_id) < vocab_size and stats:
            pair, count = stats.most_common(1)[0]
            if count < min_merge_count:
                break
            merged = pair[0] + pair[1]
            if merged in token_to_id:
                stats.pop(pair, None)
                continue
            token_to_id[merged] = len(token_to_id)
            merges.append(pair)
            # Refresh pair stats cheaply on a sample of the corpus.
            new_corpus = []
            stats = Counter()
            for symbols in corpus:
                i, out = 0, []
                while i < len(symbols):
                    if i < len(symbols) - 1 and symbols[i] == pair[0] and symbols[i + 1] == pair[1]:
                        out.append(merged)
                        i += 2
                    else:
                        out.append(symbols[i])
                        i += 1
                new_corpus.append(out)
                stats.update((out[j], out[j + 1]) for j in range(len(out) - 1))
            corpus = new_corpus
        while len(token_to_id) < vocab_size:
            token_to_id[f"<extra_{len(token_to_id)}>"] = len(token_to_id)
        trained = cls(vocab=token_to_id, merges=merges)
        return trained
