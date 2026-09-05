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


def test_adaptive_budget_gives_coding_more_room_than_simple_questions():
    settings = load_settings()
    simple = _answer_token_budget(settings, "what is ML?", base=640)
    coding = _answer_token_budget(settings, "write a Python program for binary search", base=640)
    assert coding >= 1500
    assert coding > simple


def test_greetings_remain_concise_without_forcing_all_answers_to_be_tiny():
    settings = load_settings()
    greeting = _answer_token_budget(settings, "hello", base=0)
    explanation = _answer_token_budget(settings, "explain recursion in detail", base=0)
    assert greeting == 128
    assert explanation >= 1500


def test_budget_never_exceeds_configured_model_ceiling():
    settings = load_settings()
    budget = _answer_token_budget(settings, "write complete code in detail", base=100_000)
    assert budget == settings.llm_max_output_tokens
