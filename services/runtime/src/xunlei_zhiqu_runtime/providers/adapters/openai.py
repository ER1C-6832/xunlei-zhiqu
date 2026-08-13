from __future__ import annotations

from xunlei_zhiqu_runtime.providers.adapters.base import ProviderApiAdapter


class OpenAIProviderAdapter(ProviderApiAdapter):
    """OpenAI first-party Chat Completions dialect."""

    name = "openai"
