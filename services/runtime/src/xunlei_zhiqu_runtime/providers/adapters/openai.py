from __future__ import annotations

from xunlei_zhiqu_runtime.providers.adapters.base import ProviderApiAdapter


class OpenAIProviderAdapter(ProviderApiAdapter):
    """OpenAI first-party Chat Completions dialect."""

    name = "openai"

    def stream_request_overrides(self, *, model: str) -> dict[str, object]:
        del model
        return {"stream_options": {"include_usage": True}}
