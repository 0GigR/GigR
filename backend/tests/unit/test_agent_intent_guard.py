"""The intent turn must act on a service request even when memory is present.

The regression these tests cover: once recalled Walrus sentences reached the
prompt, the parse model answered "my body feels sore" with the one task type
that only talks ("generic") and a list of the services it found in memory. The
agent then listed services instead of searching, so the map never moved.

There are three guarantees here, and each has a test that fails without it:

* a service request is an action, whatever the memory block contains;
* a question about the user's own history stays a reply, answered from the
  memory block (the recall this work must not weaken);
* memory is context placed before the closing instruction, and its size is
  bounded, so it cannot push the instruction out of the prompt.

The LLM boundary is replaced with a canned answer shaped like the observed
regression; the prompt is built and sent by the real code under test.
"""

from __future__ import annotations

import json

import pytest

from app.api.v1.endpoints import ai as ai_endpoints
from app.core.config import settings
from app.services.agent_guardrails import (
    MEMORY_CONTEXT_ANCHOR,
    MEMORY_CONTEXT_RULES,
    MEMORY_HINT_MAX_CHARS,
    build_enriched_system_prompt,
    build_memory_hint,
)

ACTION_DIRECTIVE = "- Return ONLY the JSON, no markdown, no explanation"

# The memory a recalled namespace would hold after a user has used massage
# services: whole sentences, each one naming a service. This is the list the
# model repeated instead of acting.
MASSAGE_MEMORY = {
    "last_search": "massage (2026-01-05)",
    "usual_price_service": "15000 (2025-12-11)",
    "known_1": "Kosi lists massage at 15000 naira within 10 km. (2026-01-05)",
    "known_2": "Kosi hired a provider for massage at 12000 naira (completed, 2026). (2026-01-05)",
    "known_3": "Kosi lists physiotherapy at 20000 naira within 10 km. (2025-11-02)",
    "known_4": "Kosi hired a provider for deep tissue massage at 18000 naira (completed, 2025). (2025-11-02)",
    "known_5": "Kosi searched for spa and wellness services. (2025-10-20)",
}

# What the model answered for "my body feels sore" once memory was injected:
# a chat reply that repeats the remembered services.
MEMORY_SHAPED_REPLY = {
    "task_type": "generic",
    "params": {"query": "my body feels sore"},
    "response": (
        "I can see these services: massage at 15000, physiotherapy at 20000, "
        "deep tissue massage at 18000."
    ),
}


class _FakeGroqResponse:
    """The one method _parse_command_groq uses on the HTTP response."""

    def __init__(self, content: str) -> None:
        self._content = content

    def json(self) -> dict:
        return {"choices": [{"message": {"content": self._content}}]}


class FakeLlm:
    """A canned model answer and the messages the parser actually sent it."""

    def __init__(self) -> None:
        self.payload = MEMORY_SHAPED_REPLY
        self.messages: list[dict] = []

    def answer(self, payload: dict) -> None:
        self.payload = payload

    @property
    def system(self) -> str:
        return next(
            message["content"]
            for message in self.messages
            if message["role"] == "system"
        )


@pytest.fixture
def llm(monkeypatch):
    """Replace the outbound Groq call, keeping prompt building and parsing."""
    fake = FakeLlm()
    monkeypatch.setattr(settings, "GROQ_API_KEY", "unit-test-groq-key")
    monkeypatch.setattr(settings, "GROQ_API_KEYS", "")

    async def fake_call(client, url, **kwargs):
        fake.messages = kwargs["json"]["messages"]
        return _FakeGroqResponse(json.dumps(fake.payload))

    monkeypatch.setattr(ai_endpoints, "_call_groq_with_fallback", fake_call)
    return fake


async def test_a_service_request_acts_even_when_memory_lists_many_services(llm):
    """The exact reported failure: memory in the prompt made the model reply
    with a list of remembered services instead of choosing an action. The turn
    must still be a find_service action so the agent searches and the map moves."""
    llm.answer(MEMORY_SHAPED_REPLY)

    result = await ai_endpoints.parse_command("my body feels sore", memory=MASSAGE_MEMORY)

    assert result["task_type"] == "find_service"
    assert result["params"]["query"] == "massage"
    # The memory did reach the model: this is not passing because recall was
    # skipped on the way to the parser.
    prompt = llm.system
    assert "Kosi lists massage at 15000 naira within 10 km." in prompt
    assert "usual_price_service: 15000" in prompt


async def test_a_service_request_acts_when_the_symptoms_are_said_another_way(llm):
    """The fallback must cover the reported wording, not only the prompt's
    "sore body" example: "body feels sore" is the same request."""
    llm.answer(MEMORY_SHAPED_REPLY)

    result = await ai_endpoints.parse_command("my body feels sore", memory={})

    assert result["task_type"] == "find_service"
    assert result["params"]["query"] == "massage"


async def test_a_self_inquiry_stays_a_reply_answered_from_memory(llm):
    """Memory is the answer when the user asks about themselves. Forcing an
    action here would break the recall that already works."""
    answer = {
        "task_type": "generic",
        "params": {},
        "response": "Your usual rate for a massage is 15000 naira.",
    }
    llm.answer(answer)

    result = await ai_endpoints.parse_command(
        "what are my typical rates", memory={"usual_price_service": "15000 (2025-12-11)"}
    )

    assert result["task_type"] == "generic"
    assert result["response"] == answer["response"]
    assert "usual_price_service: 15000" in llm.system


def test_memory_is_labelled_as_context_and_the_action_instruction_stays_last():
    """Memory must sit before the closing instruction and say it is not the
    task. The anchor is an implementation detail and must never be sent."""
    prompt = build_enriched_system_prompt(ai_endpoints._GROQ_SYSTEM_PROMPT, memory=MASSAGE_MEMORY)

    assert MEMORY_CONTEXT_ANCHOR not in prompt
    assert MEMORY_CONTEXT_RULES in prompt
    assert prompt.rstrip().endswith(ACTION_DIRECTIVE)
    assert prompt.count(ACTION_DIRECTIVE) == 1
    assert prompt.index(MEMORY_CONTEXT_RULES) < prompt.index(ACTION_DIRECTIVE)
    # The instruction that turns a message into an action is still present.
    assert "Extract the user's intent" in prompt


def test_a_large_memory_set_cannot_push_the_action_instruction_out_of_the_prompt():
    """Five hundred long recalled facts must not grow the prompt without bound
    or move the closing instruction away from the end."""
    small = {"last_search": "massage"}
    huge = {
        f"known_{index}": ("Kosi lists massage at 15000 naira within 10 km. " * 20)
        for index in range(500)
    }
    huge.update(small)

    huge_hint = build_memory_hint(huge)
    small_prompt = build_enriched_system_prompt(ai_endpoints._GROQ_SYSTEM_PROMPT, memory=small)
    huge_prompt = build_enriched_system_prompt(ai_endpoints._GROQ_SYSTEM_PROMPT, memory=huge)

    assert len(huge_hint) <= MEMORY_HINT_MAX_CHARS
    assert huge_prompt.rstrip().endswith(ACTION_DIRECTIVE)
    assert huge_prompt.count(ACTION_DIRECTIVE) == 1
    assert huge_prompt.index(MEMORY_CONTEXT_RULES) < huge_prompt.index(ACTION_DIRECTIVE)
    # The difference between one memory and five hundred is the memory budget,
    # not the number of memories.
    assert len(huge_prompt) - len(small_prompt) <= MEMORY_HINT_MAX_CHARS


def test_a_single_over_long_memory_does_not_hide_the_memories_behind_it():
    """A mirrored value can be much longer than the whole budget. It must be
    cut, not allowed to end the hint and hide every entry after it."""
    memory = {
        "known_1": "Kosi lists massage at 15000 naira within 10 km. " * 60,
        "known_2": "Kosi hired a provider for a leaking pipe at 9000 naira.",
    }

    hint = build_memory_hint(memory)

    assert "leaking pipe" in hint
    assert len(hint) <= MEMORY_HINT_MAX_CHARS
