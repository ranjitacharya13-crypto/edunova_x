"""RAG retrieval for EduNova AI learning material.

Pipeline implemented here (server side — never on the user's phone):

    Documents (course material / notes / syllabus text)
        -> chunking (titles + paragraph windows with overlap)
        -> embeddings (transformer sentence embedder when available,
                       deterministic lexical vector fallback otherwise)
        -> vector index (per-owner, cosine similarity)
        -> semantic retrieval (top-k chunks)

Only the retrieved chunks (not the whole syllabus / whole database) are ever
added to a prompt, and all indexes are **user-scoped**: an owner can only ever
retrieve chunks that were ingested under their own authenticated identity.

The RAG index lives in the AI inference service (process-local, optionally
persisted under LOCAL_MODEL_DIR/rag).  Corpus ingestion is a separate job — the
Express API authenticates the user, exports the user's EduNova materials and
calls POST /api/ai/rag/documents with the authenticated owner id.  A user
request can never push arbitrary text into another user's index because the
server (not the model, not the browser) decides the owner.

The transformer embedder is optional: ``RAG_EMBEDDING_MODEL`` (default
``sentence-transformers/all-MiniLM-L6-v2``) is used when it can be loaded;
when the model is unavailable (offline boot, tiny instance) a deterministic
lexical embedder keeps retrieval functional and cheap.  No external LLM is
ever used — embeddings + the EduNova local model only.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger("edunova.inference.rag")

_DEFAULT_EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
_EMBEDDING_DIM = 384
_CHUNK_WINDOW_CHARS = 1400
_CHUNK_OVERLAP_CHARS = 220
_MAX_CHUNKS_PER_DOCUMENT = 120
_MAX_DOCUMENTS_PER_OWNER = 500
_MAX_CHARS_PER_DOCUMENT = 60_000
_LOCK = threading.RLock()


def _split_paragraphs(text: str) -> list[str]:
    cleaned = re.sub(r"\r\n?", "\n", text or "")
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    parts = [p.strip() for p in re.split(r"\n\s*\n", cleaned) if p.strip()]
    return parts or ([text.strip()] if text.strip() else [])


def chunk_text(text: str, *, window: int = _CHUNK_WINDOW_CHARS, overlap: int = _CHUNK_OVERLAP_CHARS) -> list[str]:
    """Split a document into overlapping chunks without splitting sentences too hard."""
    text = (text or "").strip()
    if not text:
        return []
    paragraphs = _split_paragraphs(text)
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        # Very long paragraph: hard-split with overlap.
        while len(paragraph) > window:
            cut = _find_cut(paragraph, window)
            piece = paragraph[:cut]
            chunks.append(piece)
            paragraph = paragraph[cut - overlap :]
        candidate = (current + "\n\n" + paragraph).strip() if current else paragraph
        if len(candidate) > window and current:
            chunks.append(current)
            current = paragraph
        else:
            current = candidate
        if len(current) > window:
            chunks.append(current[:window])
            current = current[window:]
    if current:
        chunks.append(current)
    return [chunk for chunk in chunks if len(chunk) >= 40][:_MAX_CHUNKS_PER_DOCUMENT]


def _find_cut(text: str, window: int) -> int:
    if len(text) <= window:
        return len(text)
    cut = text.rfind(". ", 0, window)
    if cut > window // 2:
        return cut + 1
    cut = text.rfind("? ", 0, window)
    if cut > window // 2:
        return cut + 1
    cut = text.rfind(", ", 0, window)
    if cut > window // 2:
        return cut + 2
    return window


# ---------------------------------------------------------------------------
# Embedders
# ---------------------------------------------------------------------------
class Embedder:
    """Uniform embedder interface (``embed(texts) -> list[list[float]]``)."""

    def __init__(self, model_name: str | None = None):
        self.model_name = (model_name or os.getenv("RAG_EMBEDDING_MODEL", "") or _DEFAULT_EMBEDDING_MODEL).strip()
        self.backend = "lexical"
        self._model: Any = None
        self._tokenizer: Any = None
        self._lock = threading.Lock()
        self._load_error: str | None = None

    def is_ready(self) -> bool:
        if self.backend == "lexical":
            return True
        return self._model is not None

    def load(self) -> None:
        """Try the transformer embedder; fall back to the lexical embedder."""
        with self._lock:
            if self._model is not None or self.backend == "transformer":
                return
            try:
                import torch  # noqa: PLC0415
                from transformers import AutoModel, AutoTokenizer  # noqa: PLC0415

                local = Path(os.getenv("RAG_EMBEDDING_CACHE", "")) if os.getenv("RAG_EMBEDDING_CACHE") else None
                kwargs = {"local_files_only": True} if (local and local.exists()) else {}
                tokenizer = AutoTokenizer.from_pretrained(self.model_name, **kwargs)
                model = AutoModel.from_pretrained(self.model_name, **kwargs)
                model.eval()
                self._tokenizer, self._model = tokenizer, model
                self.backend = "transformer"
                logger.info("RAG_EMBEDDER transformer model=%s", self.model_name)
            except Exception as exc:  # noqa: BLE001 — offline/small instances degrade gracefully
                self._load_error = str(exc)[:200]
                logger.warning("RAG_EMBEDDER_FALLBACK lexical model=%s reason=%s", self.model_name, self._load_error)
                self.backend = "lexical"

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.load()
        if self.backend == "transformer":
            try:
                return self._embed_transformer(texts)
            except Exception as exc:  # noqa: BLE001
                logger.warning("RAG_EMBEDDER_TRANSFORMER_FAILED fallback=lexical reason=%s", str(exc)[:150])
                self.backend = "lexical"
        return [self._embed_lexical(text) for text in texts]

    def _embed_transformer(self, texts: list[str]) -> list[list[float]]:
        import torch  # noqa: PLC0415

        vectors: list[list[float]] = []
        batch = 16
        for start in range(0, len(texts), batch):
            part = texts[start : start + batch]
            inputs = self._tokenizer(
                part, padding=True, truncation=True, max_length=256, return_tensors="pt"
            )
            with torch.inference_mode():
                outputs = self._model(**inputs)
                last_hidden = outputs.last_hidden_state
                mask = inputs["attention_mask"].unsqueeze(-1).float()
                mean = (last_hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-9)
                mean = torch.nn.functional.normalize(mean, p=2, dim=-1)
            vectors.extend(mean.tolist())
        return vectors

    @staticmethod
    def _embed_lexical(text: str) -> list[float]:
        """Deterministic hashed bag-of-char-n-grams embedding.

        This is not a transformer but it is still a real vector embedding: it
        maps the text to a fixed 384-dim vector with cosine semantics that are
        good enough for topical retrieval on short documents.  Producing the
        same vector for the same text across processes keeps the index stable.
        """
        vector = [0.0] * _EMBEDDING_DIM
        lowered = re.sub(r"[^a-z0-9]+", " ", (text or "").lower())
        tokens = lowered.split()
        if not tokens:
            return vector
        for token in tokens:
            grams = {token}
            if len(token) > 3:
                grams.update(token[i : i + 3] for i in range(len(token) - 2))
            for gram in grams:
                digest = hashlib.blake2b(gram.encode("utf-8"), digest_size=8).digest()
                index = int.from_bytes(digest[:4], "little") % _EMBEDDING_DIM
                sign = 1.0 if digest[4] & 1 else -1.0
                vector[index] += sign * (1.0 + math.log1p(len(gram)))
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------
def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    return max(0.0, min(1.0, dot))


@dataclass(slots=True)
class Chunk:
    chunk_id: str
    owner_id: str
    document_title: str
    text: str
    vector: list[float] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)


class RagIndex:
    """Per-owner semantic retrieval index (process-local + optional JSON dump)."""

    def __init__(self, embedder: Embedder | None = None, persist_dir: str = ""):
        self.embedder = embedder or Embedder()
        self._chunks: dict[str, Chunk] = {}
        self._by_owner: dict[str, list[str]] = {}
        self._lock = threading.RLock()
        self.persist_dir = Path(persist_dir) if persist_dir else None
        self.stats: dict[str, int] = {"documents": 0, "chunks": 0, "owners": 0}

    # ------------------------------------------------------------ ingest --
    def ingest_document(self, owner_id: str, title: str, text: str) -> dict[str, Any]:
        owner_id = str(owner_id or "anonymous")[:200]
        text = (text or "")[: _MAX_CHARS_PER_DOCUMENT]
        chunks_text = chunk_text(text)
        if not chunks_text:
            return {"ingested": 0, "error": "no chunkable text"}
        with self._lock:
            owner_chunks = self._by_owner.setdefault(owner_id, [])
            # Keep the index bounded per owner (oldest chunks evicted first).
            while len(owner_chunks) + len(chunks_text) > _MAX_DOCUMENTS_PER_OWNER * 4:
                oldest = owner_chunks.pop(0)
                self._chunks.pop(oldest, None)
        vectors = self.embedder.embed(chunks_text)
        created = time.time()
        new_chunks: list[Chunk] = []
        for index, (chunk_text_value, vector) in enumerate(zip(chunks_text, vectors)):
            digest = hashlib.blake2b(
                f"{owner_id}|{title}|{index}|{chunk_text_value[:80]}".encode("utf-8"),
                digest_size=12,
            ).hexdigest()
            chunk = Chunk(
                chunk_id=digest,
                owner_id=owner_id,
                document_title=title[:200],
                text=chunk_text_value,
                vector=vector,
                created_at=created,
            )
            new_chunks.append(chunk)
        with self._lock:
            for chunk in new_chunks:
                self._chunks[chunk.chunk_id] = chunk
                self._by_owner.setdefault(owner_id, []).append(chunk.chunk_id)
            self.stats["documents"] += 1
            self.stats["chunks"] = len(self._chunks)
            self.stats["owners"] = len(self._by_owner)
        self._persist()
        logger.info("RAG_INGEST owner=%s title=%s chunks=%s", owner_id, title[:80], len(chunks_text))
        return {"ingested": len(chunks_text), "document": title[:200], "owner": owner_id}

    # ----------------------------------------------------------- retrieval --
    def search(self, owner_id: str, query: str, k: int = 5) -> list[dict[str, Any]]:
        """Top-k semantic retrieval restricted to the owner's own documents."""
        owner_id = str(owner_id or "anonymous")[:200]
        k = max(1, min(k, 10))
        with self._lock:
            chunk_ids = list(self._by_owner.get(owner_id, []))
            candidates = [self._chunks[cid] for cid in chunk_ids if cid in self._chunks]
        if not candidates or not (query or "").strip():
            return []
        [query_vector] = self.embedder.embed([query])
        scored = [
            (chunk, _cosine(query_vector, chunk.vector))
            for chunk in candidates
            if chunk.vector
        ]
        scored.sort(key=lambda item: item[1], reverse=True)
        results = [
            {
                "chunkId": chunk.chunk_id,
                "documentTitle": chunk.document_title,
                "text": chunk.text,
                "score": round(score, 4),
            }
            for chunk, score in scored[:k]
            if score >= 0.05
        ]
        return results

    def count(self, owner_id: str) -> int:
        with self._lock:
            return len(self._by_owner.get(str(owner_id), [])) if owner_id else 0

    # ------------------------------------------------------------ storage --
    def _persist(self) -> None:
        if self.persist_dir is None:
            return
        try:
            self.persist_dir.mkdir(parents=True, exist_ok=True)
            snapshot = {
                "chunks": [
                    {
                        "chunkId": chunk.chunk_id,
                        "ownerId": chunk.owner_id,
                        "title": chunk.document_title,
                        "text": chunk.text,
                        "vector": chunk.vector,
                        "createdAt": chunk.created_at,
                    }
                    for chunk in self._chunks.values()
                ],
            }
            tmp = self.persist_dir / "rag-index.json.tmp"
            tmp.write_text(json.dumps(snapshot), encoding="utf-8")
            tmp.replace(self.persist_dir / "rag-index.json")
        except Exception as exc:  # noqa: BLE001 — persistence is best-effort
            logger.warning("RAG_PERSIST_FAILED reason=%s", str(exc)[:150])

    def load(self) -> None:
        if self.persist_dir is None:
            return
        try:
            path = self.persist_dir / "rag-index.json"
            if not path.exists():
                return
            data = json.loads(path.read_text(encoding="utf-8"))
            with self._lock:
                for item in data.get("chunks", []):
                    chunk = Chunk(
                        chunk_id=item["chunkId"],
                        owner_id=item["ownerId"],
                        document_title=item.get("title", ""),
                        text=item.get("text", ""),
                        vector=item.get("vector", []),
                        created_at=item.get("createdAt", time.time()),
                    )
                    self._chunks[chunk.chunk_id] = chunk
                    self._by_owner.setdefault(chunk.owner_id, []).append(chunk.chunk_id)
                self.stats["chunks"] = len(self._chunks)
                self.stats["owners"] = len(self._by_owner)
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG_LOAD_FAILED reason=%s", str(exc)[:150])
