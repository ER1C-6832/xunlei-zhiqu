from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ProviderUsage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_tokens: int | None = None


@dataclass(frozen=True, slots=True)
class ProviderStreamEvent:
    """Provider-neutral view of one Chat Completions stream event."""

    content_delta: str | None = None
    reasoning_delta: str | None = None
    finish_reason: str | None = None
    usage: ProviderUsage | None = None


class ProviderApiAdapter:
    """Supplier/model dialect boundary for an OpenAI-compatible HTTP transport.

    Runtime orchestration must not know supplier-specific request fields or usage
    shapes. Implementations may add provider-specific request options and parse
    provider-specific metadata, while the transport keeps one stable interface.
    """

    name = "openai_compatible"

    def request_overrides(self, *, model: str) -> dict[str, object]:
        return {}

    def stream_request_overrides(self, *, model: str) -> dict[str, object]:
        """Supplier additions for a stream request.

        `stream=true` itself is transport semantics and is set by the common
        transport. Adapters only add dialect-specific options such as usage in
        the terminal stream event.
        """
        return {}

    def usage(self, body: object) -> ProviderUsage:
        if not isinstance(body, dict):
            return ProviderUsage()
        raw = body.get("usage")
        if not isinstance(raw, dict):
            return ProviderUsage()
        input_tokens = _first_int(raw, "prompt_tokens", "input_tokens")
        output_tokens = _first_int(raw, "completion_tokens", "output_tokens")
        cached_tokens = None
        details = raw.get("prompt_tokens_details")
        if isinstance(details, dict):
            cached_tokens = _as_int(details.get("cached_tokens"))
        return ProviderUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
        )

    def parse_stream_event(self, body: object) -> ProviderStreamEvent:
        """Normalize an OpenAI-compatible SSE JSON object.

        Supplier-specific variants may override this method without leaking into
        StructuredChatProvider or CaptureAnalyzer.
        """
        usage = self.usage(body)
        usage_value = usage if any(
            value is not None
            for value in (usage.input_tokens, usage.output_tokens, usage.cached_tokens)
        ) else None
        if not isinstance(body, dict):
            return ProviderStreamEvent(usage=usage_value)

        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            return ProviderStreamEvent(usage=usage_value)
        choice = choices[0]
        if not isinstance(choice, dict):
            return ProviderStreamEvent(usage=usage_value)

        delta = choice.get("delta")
        content, reasoning = self.response_content(delta)
        finish_reason = choice.get("finish_reason")
        return ProviderStreamEvent(
            content_delta=content,
            reasoning_delta=reasoning,
            finish_reason=finish_reason if isinstance(finish_reason, str) else None,
            usage=usage_value,
        )

    def response_content(self, message: object) -> tuple[str | None, str | None]:
        if not isinstance(message, dict):
            return None, None
        content = message.get("content")
        reasoning = message.get("reasoning_content")
        return (
            content if isinstance(content, str) else None,
            reasoning if isinstance(reasoning, str) else None,
        )

    def empty_content_hint(self, *, model: str, reasoning_chars: int) -> str | None:
        return None

    def provider_error_detail(self, body: object) -> str | None:
        if not isinstance(body, dict):
            return None
        error = body.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str) and message.strip():
                return message.strip()[:500]
        message = body.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()[:500]
        return None


def _first_int(value: dict[str, object], *keys: str) -> int | None:
    for key in keys:
        parsed = _as_int(value.get(key))
        if parsed is not None:
            return parsed
    return None


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None
