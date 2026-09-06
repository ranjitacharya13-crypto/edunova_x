"""Supervisor contracts, not model-intelligence scores. No model download required."""
import asyncio
from dataclasses import replace
from pathlib import Path
import sys
from unittest.mock import patch
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import Settings
from agent.llm import LLMResponseError
from inference.manager import ModelManager, safe_error
from inference.rag import Embedder, RagIndex, MAX_CHUNKS_PER_OWNER, MAX_OWNERS

@pytest.mark.asyncio
async def test_reads_and_requests_never_start_the_worker():
    manager = ModelManager(Settings())
    with patch.object(manager, 'ensure_loading') as start:
        for _ in range(8):
            assert not manager.snapshot()['ready']
            with pytest.raises(LLMResponseError):
                await manager.wait_ready(timeout=0.01)
        start.assert_not_called()
    assert manager._process is None

@pytest.mark.asyncio
async def test_terminal_state_cannot_restart_via_readiness():
    manager = ModelManager(Settings())
    await manager._fail('OUT_OF_MEMORY', 'Capacity is below the tested profile')
    for _ in range(4):
        assert not manager.snapshot()['ready']
        assert manager.snapshot()['permanentFailure']
        with pytest.raises(LLMResponseError) as exc:
            await manager.wait_ready()
        assert exc.value.error_type == 'OUT_OF_MEMORY'
    assert manager.snapshot().get('coldStartMs') is None
    assert manager._process is None

@pytest.mark.asyncio
async def test_supervisor_rejects_an_incompatible_model_format_without_downloading():
    manager = ModelManager(Settings(local_model_runtime='torch', local_model_repo='bartowski/Qwen2.5-0.5B-Instruct-GGUF', local_model_file='file.gguf'))
    manager.ensure_loading()
    await asyncio.wait_for(manager._ready_event.wait(), 20)
    try:
        assert manager.phase == 'CONFIG_FAILED'
        assert manager.snapshot()["permanentFailure"]
        assert not manager.is_ready()
        first = manager._process
        manager.ensure_loading()
        assert manager._process is first
    finally:
        await manager.close()

@pytest.mark.asyncio
async def test_model_capacity_includes_app_overhead():
    manager = ModelManager(Settings())
    class Worker:
        def is_alive(self): return True
        def terminate(self): pass
        def join(self, timeout=None): pass
        def kill(self): pass
    # Terminal resource failure is the admission behavior, not an auto-reload.
    await manager._fail('OUT_OF_MEMORY', 'Needs >1100MiB; limit 512MiB')
    assert manager.snapshot()['errorDetail'] == 'OUT_OF_MEMORY'


def test_safe_errors_never_contain_credentials():
    text = safe_error(RuntimeError('https://admin:password@model.example/model?token=secret mongodb+srv://user:pass@host/db'))
    assert 'password' not in text and 'secret' not in text and 'user:pass' not in text


def test_rag_sync_removes_revoked_and_changed_documents_and_obeys_cap():
    index = RagIndex(Embedder('lexical'))
    docs = [{'id': str(i), 'title': f'Lesson {i}', 'text': 'retina photoreceptor neural signal '*1900} for i in range(24)]
    index.sync_documents('owner-a', docs)
    assert index.count('owner-a') <= MAX_CHUNKS_PER_OWNER
    index.sync_documents('owner-a', [{'id': 'new', 'title': 'Lens', 'text': 'lens refraction focuses light'}])
    results = index.search('owner-a', 'lens refraction')
    assert results and all(r['documentId'] == 'new' for r in results)
    assert index.search('owner-b', 'lens refraction') == []
    index.sync_documents('owner-a', [])
    assert not index.search('owner-a', 'retina lens')


def test_rag_embedding_failure_is_not_silently_relabelled_lexical():
    embedder = Embedder('an-explicit-unavailable-transformer')
    embedder._attempted = True
    embedder._load_error = 'Unavailable'
    with pytest.raises(RuntimeError):
        embedder.embed(['hello'])
    assert embedder.backend == 'transformer'


def test_rag_owner_cache_is_bounded():
    index = RagIndex(Embedder('lexical'))
    for i in range(MAX_OWNERS + 5):
        index.sync_documents(str(i), [{'id': 'one', 'title': 'lesson', 'text': 'physics optics learning'}])
    assert len(index._owners) <= MAX_OWNERS
