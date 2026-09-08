# RAG

Knowledge updates (new syllabus, notes, PDFs) are **indexed**, not trained.

```
upload → validate → extract → clean → section detect → chunk
      → metadata (sha256, owner) → embed/index → retrieve → HRM
```

Owner identity comes from the authenticated gateway, never from the prompt.

Retrieved text is marked `<untrusted>` so a document that says “ignore previous
instructions” cannot override system rules.

If retrieval is empty: `NO_RELEVANT_CONTEXT` — no fabricated citations.

On Render Free, `RAG_ENABLED=false` because MiniLM embeddings do not fit
512 MiB. The pipeline remains in the repo.
