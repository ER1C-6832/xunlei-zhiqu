from xunlei_zhiqu_runtime.models import CaptureBatch, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter
from xunlei_zhiqu_runtime.services.evidence import build_evidence_pack


class CaptureAnalyzer:
    def __init__(self, provider: ModelProviderAdapter) -> None:
        self._provider = provider

    async def analyze(self, batch: CaptureBatch) -> ResourcePlan:
        evidence_pack = build_evidence_pack(batch)
        return await self._provider.analyze(batch, evidence_pack)
