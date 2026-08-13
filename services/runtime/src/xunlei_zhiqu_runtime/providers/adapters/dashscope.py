from __future__ import annotations

from xunlei_zhiqu_runtime.providers.adapters.base import ProviderApiAdapter


class DashScopeProviderAdapter(ProviderApiAdapter):
    """Alibaba Cloud Model Studio OpenAI-compatible dialect.

    Supplier quirks stay here instead of leaking into Runtime orchestration or the
    generic HTTP transport. New Qwen/DeepSeek capability differences belong here.
    """

    name = "dashscope"

    def request_overrides(self, *, model: str) -> dict[str, object]:
        lowered = model.strip().lower()
        # DeepSeek V4 on DashScope may emit reasoning_content instead of the final
        # JSON when thinking is enabled. Node A requires direct structured output.
        if lowered.startswith("deepseek-v4"):
            return {"enable_thinking": False}
        return {}

    def empty_content_hint(self, *, model: str, reasoning_chars: int) -> str | None:
        if reasoning_chars:
            return (
                "模型产生了 reasoning_content，但没有可用的最终 content；"
                "请检查 DashScope 模型的 thinking/JSON Mode 配置。"
            )
        return None
