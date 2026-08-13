from __future__ import annotations

import logging
from urllib.parse import urlparse

from xunlei_zhiqu_runtime.providers.adapters.base import ProviderApiAdapter
from xunlei_zhiqu_runtime.providers.adapters.dashscope import DashScopeProviderAdapter
from xunlei_zhiqu_runtime.providers.adapters.generic import GenericOpenAICompatibleAdapter
from xunlei_zhiqu_runtime.providers.adapters.openai import OpenAIProviderAdapter


logger = logging.getLogger("uvicorn.error")


def create_api_adapter(*, provider: str, base_url: str) -> ProviderApiAdapter:
    """Select a supplier dialect without leaking it into Runtime orchestration."""
    if provider == "openai":
        return OpenAIProviderAdapter()
    if provider == "dashscope":
        return DashScopeProviderAdapter()
    if provider == "openai_compatible":
        # Backward-compatible migration shim for existing local .env files. The
        # active transport still uses the supplier adapter; users should make the
        # boundary explicit with MODEL_PROVIDER=dashscope.
        host = (urlparse(base_url).hostname or "").lower()
        if host.endswith("aliyuncs.com"):
            logger.warning(
                "MODEL_PROVIDER=openai_compatible with an Alibaba Cloud endpoint is deprecated; "
                "using DashScopeProviderAdapter. Set MODEL_PROVIDER=dashscope explicitly."
            )
            return DashScopeProviderAdapter()
        return GenericOpenAICompatibleAdapter()
    raise ValueError(f"Unsupported model API provider: {provider}")
