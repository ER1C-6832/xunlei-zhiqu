from abc import ABC, abstractmethod

from xunlei_zhiqu_runtime.models import EvidencePack, ResourcePlan


class ModelProviderAdapter(ABC):
    """Model providers only receive a Runtime-built, sanitized EvidencePack."""

    name: str

    @abstractmethod
    async def analyze(self, evidence_pack: EvidencePack) -> ResourcePlan:
        raise NotImplementedError

    async def aclose(self) -> None:
        return None
