"""Unit tests for the resilient async LLM client.

Run with:  pytest tests/python -q

These tests inject fake providers and use an in-memory cache, so they never
touch a real LLM API and never need a database. Each test wraps the async
call in ``asyncio.run`` to avoid needing pytest-asyncio.
"""

from __future__ import annotations

import asyncio

import pytest

from hermes.core.config import LLMSettings, Settings
from hermes.llm.client import AsyncLLMClient, LLMUnavailable
from hermes.llm.provider import LLMProvider


class FailNTimesProvider(LLMProvider):
    """Returns ``value`` after the first ``fail_times`` calls raise."""

    def __init__(self, fail_times: int = 0, value: str = "ok") -> None:
        self.fail_times = fail_times
        self.value = value
        self.calls = 0

    @property
    def name(self) -> str:
        return "fake"

    async def complete(self, messages, temperature):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("boom")
        return self.value

    async def aclose(self):
        return None


def make_client(fail_times: int = 0, mock_mode: bool = False, **llm_overrides):
    llm = LLMSettings(mock_mode=mock_mode, max_retries=3, **llm_overrides)
    settings = Settings(llm=llm)
    provider = FailNTimesProvider(fail_times=fail_times)
    return AsyncLLMClient(settings, provider=provider), provider


def test_cache_hit_avoids_second_provider_call():
    client, provider = make_client(fail_times=0)
    messages = [{"role": "user", "content": "hi"}]
    out1 = asyncio.run(client.chat(messages))
    out2 = asyncio.run(client.chat(messages))
    assert out1 == out2 == "ok"
    assert provider.calls == 1  # second call served from cache
    asyncio.run(client.aclose())


def test_retry_succeeds_after_transient_failures():
    client, provider = make_client(fail_times=2)
    out = asyncio.run(client.chat([{"role": "user", "content": "x"}]))
    assert out == "ok"
    assert provider.calls == 3  # failed twice, succeeded on the 3rd attempt
    asyncio.run(client.aclose())


def test_retries_exhausted_raises_llm_unavailable():
    client, provider = make_client(fail_times=5)
    with pytest.raises(LLMUnavailable):
        asyncio.run(client.chat([{"role": "user", "content": "x"}]))
    assert provider.calls == 3  # capped at max_retries attempts
    asyncio.run(client.aclose())


def test_circuit_opens_and_fails_fast():
    # circuit_fail_max=2: two fully-failed chats open the breaker; the 3rd
    # must fail fast without ever calling the provider. fail_times is high so
    # the provider keeps failing across all chats (the same instance is reused
    # and its call count accumulates between chats).
    client, provider = make_client(fail_times=100, circuit_fail_max=2)
    for _ in range(2):
        with pytest.raises(LLMUnavailable):
            asyncio.run(client.chat([{"role": "user", "content": "x"}]))
    calls_before = provider.calls
    with pytest.raises(LLMUnavailable):
        asyncio.run(client.chat([{"role": "user", "content": "x"}]))
    assert provider.calls == calls_before  # breaker short-circuited the call
    asyncio.run(client.aclose())


def test_mock_mode_bypasses_resilience_logic():
    # Under explicit mock mode the client calls the provider directly with
    # no retry/breaker, so a failing injected provider propagates immediately.
    settings = Settings(llm=LLMSettings(mock_mode=True, max_retries=3))
    provider = FailNTimesProvider(fail_times=5)
    client = AsyncLLMClient(settings, provider=provider)
    with pytest.raises(RuntimeError):
        asyncio.run(client.chat([{"role": "user", "content": "x"}]))
    assert provider.calls == 1  # no retry happened
    asyncio.run(client.aclose())


def test_explicit_mock_provider_returns_deterministic_value():
    # When mock_mode is on and no provider is injected, the client builds a
    # MockProvider and returns deterministic output without network access.
    settings = Settings(llm=LLMSettings(mock_mode=True))
    client = AsyncLLMClient(settings)
    out = asyncio.run(client.chat([{"role": "user", "content": "x"}]))
    assert out == "[mock] response"
    asyncio.run(client.aclose())
