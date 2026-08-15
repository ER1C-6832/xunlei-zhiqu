from xunlei_zhiqu_runtime.models import EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import (
    ModelProviderAdapter,
    ModelProviderResponseError,
    StructuredModelResult,
)


DEFAULT_UNAVAILABLE_REASON = (
    "Competition AI Gateway 尚未配置；本地 Runtime 与下载功能可用，"
    "但智能分析和重新智取暂不可用。"
)


class UnavailableModelProvider(ModelProviderAdapter):
    """Fail-closed semantic adapter used only when a packaged release has no AI gateway."""

    name = "unavailable"

    def __init__(self, reason: str = DEFAULT_UNAVAILABLE_REASON) -> None:
        self._reason = reason

    async def analyze(self, evidence_pack: EvidencePack) -> ResourcePlan:
        del evidence_pack
        raise ModelProviderResponseError(self._reason)

    async def generate_structured(
        self,
        *,
        system_prompt: str,
        document: object,
        max_completion_tokens: int = 512,
        temperature: float = 0.1,
    ) -> StructuredModelResult:
        del system_prompt, document, max_completion_tokens, temperature
        raise ModelProviderResponseError(self._reason)
