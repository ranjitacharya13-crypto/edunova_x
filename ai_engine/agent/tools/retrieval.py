"""Glue between authorized EduNova GridFS export and server-side vector search."""
import asyncio
import time
from .base import ToolDefinition
from .internal import ApplicationToolClient


def build_retrieval_tool(settings, index):
    client = ApplicationToolClient(settings)

    async def retrieve(arguments, context=None):
        owner = str((context or {}).get("user_id") or "")
        if not owner:
            raise ValueError("Authenticated identity is required")
        started = time.monotonic()
        corpus = await client.execute_remote("get_learning_documents", {}, context)
        db_ms = round((time.monotonic() - started) * 1000)
        if index is None:
            from inference.rag import RagError
            raise RagError("Semantic retrieval is disabled")
        started = time.monotonic()
        # Reconcile current ACLs/deletions before querying cached embeddings.
        await asyncio.to_thread(index.sync_documents, owner, corpus.get("documents", []))
        hits = await asyncio.to_thread(index.search, owner, arguments["query"], arguments.get("k", 5))
        return {"results": hits, "backend": index.embedder.backend, "unavailable": corpus.get("unavailable", []),
                "databaseMs": db_ms, "ragMs": round((time.monotonic() - started) * 1000),
                "sourceType": "edunova-materials", "boundedToRecent": corpus.get("boundedToRecent")}

    return ToolDefinition(name="retrieve_learning_materials", description="Retrieve relevant passages from the authenticated student's real EduNova syllabus and study documents. Use for teaching course topics, quizzes, study plans and material questions; returns only top matching chunks, not whole documents.",
        input_schema={"type": "object", "properties": {"query": {"type": "string", "minLength": 1, "maxLength": 4000}, "k": {"type": "integer", "minimum": 1, "maximum": 8}}, "required": ["query"], "additionalProperties": False},
        executor=retrieve, category="INTERNAL", permission="READ_INTERNAL", timeout_seconds=60)
