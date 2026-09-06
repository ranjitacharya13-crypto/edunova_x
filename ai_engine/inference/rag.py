"""User-isolated retrieval over real EduNova materials.

Explicit PyTorch sentence embeddings (mean pooling + cosine). `lexical` is an
operator-selected offline retrieval backend, NEVER a silent fallback. Index
fingerprints prevent comparing vectors from incompatible embedding spaces.
MongoDB/GridFS remains the source of truth; a per-user sync removes revoked or
deleted documents before each retrieval. The bounded cache contains no LLM.
"""
from __future__ import annotations
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import threading
import time
from typing import Any

log = logging.getLogger("edunova.rag")
MAX_CHUNKS_PER_OWNER = 128
MAX_OWNERS = 32

_DEFAULT_EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


class RagError(RuntimeError):
    code = "RAG_FAILED"


def chunk_text(text: str, *, window: int = 1200, overlap: int = 180) -> list[str]:
    if window < 40 or not 0 <= overlap < window // 2:
        raise ValueError("Invalid chunk window/overlap")
    text = re.sub(r"\r\n?", "\n", (text or "").strip())[:60000]
    chunks, start = [], 0
    while start < len(text) and len(chunks) < 80:
        end = min(len(text), start + window)
        if end < len(text):
            boundary = max(text.rfind("\n", start + window // 2, end), text.rfind(". ", start + window // 2, end))
            if boundary > start:
                end = boundary + 1
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        if end == len(text):
            break
        start = max(start + 1, end - overlap)
    return chunks


class Embedder:
    def __init__(self, model_name: str | None = None):
        self.model_name = model_name or _DEFAULT_EMBEDDING_MODEL
        self.backend = "lexical" if self.model_name == "lexical" else "transformer"
        self._model = None
        self._tokenizer = None
        self._load_error = None
        self._attempted = False
        self._lock = threading.RLock()
        self.fingerprint = f"v2:{self.backend}:{self.model_name}:mean-pooling-256"

    def is_ready(self):
        return self.backend == "lexical" or self._model is not None

    def load(self):
        with self._lock:
            if self.backend == "lexical" or self._model is not None:
                return
            if self._attempted:
                raise RagError(self._load_error or "Embedding model failed to load")
            self._attempted = True
            try:
                import torch
                from transformers import AutoModel, AutoTokenizer
                source = os.getenv("RAG_EMBEDDING_CACHE") or self.model_name
                kwargs = {"trust_remote_code": False}
                if Path(source).is_dir():
                    kwargs["local_files_only"] = True
                self._tokenizer = AutoTokenizer.from_pretrained(source, **kwargs)
                self._model = AutoModel.from_pretrained(source, use_safetensors=True, **kwargs).eval()
                log.info("RAG_READY backend=transformer torch=%s model=%s", torch.__version__, self.model_name)
            except Exception as exc:
                self._load_error = f"Embedding model could not load ({type(exc).__name__}); semantic retrieval is unavailable"
                log.error("RAG_EMBEDDING_FAILED type=%s", type(exc).__name__)
                raise RagError(self._load_error) from exc

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.load()
        if self.backend == "lexical":
            return [self._embed_lexical(text) for text in texts]
        import torch
        vectors = []
        with self._lock, torch.inference_mode():
            for start in range(0, len(texts), 8):
                batch = self._tokenizer(texts[start:start+8], padding=True, truncation=True, max_length=256, return_tensors="pt")
                hidden = self._model(**batch).last_hidden_state
                mask = batch["attention_mask"].unsqueeze(-1).to(hidden.dtype)
                mean = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
                vectors.extend(torch.nn.functional.normalize(mean, p=2, dim=-1).tolist())
        return vectors

    @staticmethod
    def _embed_lexical(text: str) -> list[float]:
        values = [0.0] * 384
        for word in re.findall(r"\w+", text.lower()):
            digest = hashlib.blake2b(word.encode(), digest_size=8).digest()
            values[int.from_bytes(digest[:4], "little") % 384] += 1 if digest[4] & 1 else -1
        norm = math.sqrt(sum(v*v for v in values)) or 1
        return [v/norm for v in values]


class RagIndex:
    def __init__(self, embedder: Embedder | None = None, persist_dir: str = ""):
        self.embedder = embedder or Embedder()
        self.persist_dir = Path(persist_dir) if persist_dir else None
        self._owners: dict[str, dict] = {}
        self._lock = threading.RLock()
        self.stats = {"documents": 0, "chunks": 0, "owners": 0}

    @staticmethod
    def _owner(owner):
        if not owner or owner in {"anonymous", "null", "undefined"}:
            raise RagError("Authenticated owner is required")
        return str(owner)[:200]

    def _stats(self):
        self.stats = {"owners": len(self._owners), "documents": sum(len(o["documents"]) for o in self._owners.values()),
                      "chunks": sum(len(d["chunks"]) for o in self._owners.values() for d in o["documents"].values())}

    def sync_documents(self, owner_id, documents):
        owner_id = self._owner(owner_id)
        with self._lock:
            owner = self._owners.setdefault(owner_id, {"touched": time.time(), "documents": {}})
            allowed = {str(d["id"]) for d in documents[:24]}
            owner["documents"] = {k: v for k, v in owner["documents"].items() if k in allowed}
            total = 0
            selected = {}
            for document in documents[:24]:
                text = str(document.get("text", ""))[:60000]
                doc_id = str(document["id"])
                fingerprint = hashlib.sha256((self.embedder.fingerprint + text).encode()).hexdigest()
                previous = owner["documents"].get(doc_id)
                if not previous or previous["fingerprint"] != fingerprint:
                    pieces = chunk_text(text)[:max(0, 128 - total)]
                    vectors = self.embedder.embed(pieces) if pieces else []
                    owner["documents"][doc_id] = {"fingerprint": fingerprint, "title": str(document.get("title", ""))[:300],
                        "url": str(document.get("url", ""))[:500], "chunks": [{"text": t, "vector": v} for t, v in zip(pieces, vectors)]}
                selected[doc_id] = {**owner["documents"][doc_id], "chunks": owner["documents"][doc_id]["chunks"][:max(0, MAX_CHUNKS_PER_OWNER-total)]}
                total += len(selected[doc_id]["chunks"])
                if total >= 128:
                    break
            owner["documents"] = selected
            owner["touched"] = time.time()
            while len(self._owners) > 32:
                oldest = min(self._owners, key=lambda k: self._owners[k]["touched"])
                del self._owners[oldest]
            self._stats()
            self._persist()
            return {"ingested": self.count(owner_id), "backend": self.embedder.backend}

    def ingest_document(self, owner_id, title, text):
        # Compatibility endpoint. Full application sync is preferred for revocation.
        return self.sync_documents(owner_id, [{"id": hashlib.sha256(title.encode()).hexdigest(), "title": title, "text": text}])

    def search(self, owner_id: str, query: str, k=5):
        owner_id = self._owner(owner_id)
        with self._lock:
            owner = self._owners.get(owner_id)
            if not owner or not owner["documents"] or not query.strip():
                return []
            [vector] = self.embedder.embed([query[:4000]])
            hits = []
            for doc_id, doc in owner["documents"].items():
                for i, chunk in enumerate(doc["chunks"]):
                    if len(vector) != len(chunk["vector"]):
                        raise RagError("Embedding index mismatch; reindex required")
                    score = sum(a*b for a, b in zip(vector, chunk["vector"]))
                    if score > 0.08:
                        hits.append({"chunkId": f"{doc_id}:{i}", "documentId": doc_id, "documentTitle": doc["title"],
                                     "text": chunk["text"], "url": doc["url"], "score": round(score, 4)})
            return sorted(hits, key=lambda r: r["score"], reverse=True)[:max(1, min(k, 8))]

    def count(self, owner_id):
        with self._lock:
            return sum(len(d["chunks"]) for d in self._owners.get(owner_id, {}).get("documents", {}).values())

    def _persist(self):
        if self.persist_dir is None:
            return
        self.persist_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = self.persist_dir / "rag-index.json.tmp"
        temp.write_text(json.dumps({"fingerprint": self.embedder.fingerprint, "owners": self._owners}))
        temp.chmod(0o600)
        temp.replace(self.persist_dir / "rag-index.json")

    def load(self):
        if self.persist_dir is None or not (self.persist_dir / "rag-index.json").exists():
            return
        index_file = self.persist_dir / "rag-index.json"
        if index_file.stat().st_size > 48 * 1024 * 1024:
            log.warning("RAG_INDEX_INVALIDATED oversized cache")
            return
        data = json.loads(index_file.read_text())
        if data.get("fingerprint") != self.embedder.fingerprint:
            log.warning("RAG_INDEX_INVALIDATED embedding space changed")
            return
        for owner_id, entry in list(data.get("owners", {}).items())[-MAX_OWNERS:]:
            selected, total = {}, 0
            if not isinstance(entry, dict):
                continue
            for doc_id, doc in list(entry.get("documents", {}).items())[:24]:
                chunks = doc.get("chunks", [])[:MAX_CHUNKS_PER_OWNER-total]
                if any(not isinstance(c.get("text"), str) or len(c["text"]) > 1200 or not isinstance(c.get("vector"), list) or len(c["vector"]) > 1024 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in c["vector"]) for c in chunks):
                    continue
                selected[doc_id] = {**doc, "chunks": chunks}
                total += len(chunks)
            self._owners[self._owner(owner_id)] = {"touched": time.time(), "documents": selected}
        self._stats()
