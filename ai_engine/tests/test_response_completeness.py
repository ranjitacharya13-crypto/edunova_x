"""Regression tests for complete, quality-oriented local-model responses."""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.local_llm import LocalModelManager  # noqa: E402
from agent.router import _answer_token_budget  # noqa: E402
from config import load_settings  # noqa: E402


class _FiniteLlama:
    """Minimal llama.cpp stand-in that always reaches its natural end."""

    def __init__(self, pieces: list[str]):
        self.pieces = pieces
        self.requested_max_tokens = 0

    def n_ctx(self):
        return 8192

    def tokenize(self, text, add_bos=True, special=True):
        return [0] * max(1, len(text) // 4)

    def create_completion(self, **kwargs):
        self.requested_max_tokens = kwargs["max_tokens"]

        def generate():
            for piece in self.pieces:
                yield {"choices": [{"text": piece}]}

        return generate()


def _manager_with(llama):
    manager = LocalModelManager(load_settings())
    manager._llama = llama
    manager.state = "ready"
    manager.last_self_test = {"ok": True}
    return manager


def test_generation_runs_to_model_completion_without_wall_clock_cutoff():
    llama = _FiniteLlama(["Machine learning ", "learns patterns ", "from data."])
    manager = _manager_with(llama)
    answer = asyncio.run(
        manager.generate(
            system_prompt="You are a tutor.",
            user_prompt="What is ML?",
            max_tokens=640,
        )
    )
    assert answer == "Machine learning learns patterns from data."
    assert "shortened" not in answer.lower()
    assert "continue" not in answer.lower()
    assert llama.requested_max_tokens == 640


def test_real_tokens_stream_as_the_model_decodes():
    pieces = ["Complete ", "streamed ", "answer."]
    manager = _manager_with(_FiniteLlama(pieces))
    seen: list[str] = []
    answer = asyncio.run(
        manager.generate(
            system_prompt="sys",
            user_prompt="user",
            max_tokens=512,
            on_token=seen.append,
        )
    )
    assert seen == pieces
    assert answer == "".join(pieces)


def test_adaptive_budget_gives_simple_explanations_room_to_be_complete():
    settings = load_settings()
    assert _answer_token_budget(settings, "what is ML?", base=640) >= 512


def test_coding_and_simple_questions_can_run_to_eos_with_full_capacity():
    settings = load_settings()
    simple = _answer_token_budget(settings, "what is ML?", base=640)
    coding = _answer_token_budget(settings, "write a Python program for binary search", base=640)
    # Full capacity for every task. Stale per-task caps are impossible:
    # config.py floors local mode at 1024 output tokens, and the only thing
    # that can shrink a budget below the ceiling is the physical model window
    # (Render Free ctx 2048 keeps 1024 comfortably; coding answers on a
    # 0.1-CPU free instance are also grammar/step-bounded by that window).
    assert coding >= 1024
    assert coding == simple == settings.llm_max_output_tokens
    assert coding == min(settings.llm_max_output_tokens, settings.local_model_ctx_size * 3 // 4)


def test_output_capacity_does_not_force_a_greeting_to_hit_an_artificial_cap():
    settings = load_settings()
    greeting = _answer_token_budget(settings, "hello", base=0)
    explanation = _answer_token_budget(settings, "explain recursion in detail", base=0)
    assert greeting == settings.llm_max_output_tokens
    assert explanation >= 1024


def test_budget_never_exceeds_configured_model_ceiling():
    settings = load_settings()
    budget = _answer_token_budget(settings, "write complete code in detail", base=100_000)
    assert budget == settings.llm_max_output_tokens
