from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ProviderUsage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_tokens: int | None = None


class ProviderApiAdapter:
    """Supplier/model dialect boundary for an OpenAI-compatible HTTP transport.

    Runtime orchestration must not know supplier-specific request fields or usage
    shapes. Implementations may add provider-specific request options and parse
    provider-specific metadata, while the transport keeps one stable interface.
    """

    name = "openai_compatible"

    def request_overrides(self, *, model: str) -> dict[str, object]:
        return {}

    def usage(self, body: object) -> ProviderUsage:
        if not isinstance(body, dict):
            return ProviderUsage()
        raw = body.get("usage")
        if not isinstance(raw, dict):
            return ProviderUsage()
        input_tokens = _as_int(raw.get("prompt_tokens")) or _as_int(raw.get("input_tokens"))
        output_tokens = _as_int(raw.get("completion_tokens")) or _as_int(raw.get("output_tokens"))
        cached_tokens = None
        details = raw.get("prompt_tokens_details")
        if isinstance(details, dict):
            cached_tokens = _as_int(details.get("cached_tokens"))
        return ProviderUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
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


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None
