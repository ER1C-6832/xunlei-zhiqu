from __future__ import annotations

from xunlei_zhiqu_runtime.providers.adapters.base import ProviderApiAdapter


class GenericOpenAICompatibleAdapter(ProviderApiAdapter):
    """Provider-neutral OpenAI-compatible dialect with no vendor-only fields."""

    name = "openai_compatible"
