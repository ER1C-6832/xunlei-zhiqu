from abc import ABC, abstractmethod
from typing import Any

from xunlei_zhiqu_runtime.models import CaptureBatch, ResourcePlan


class ModelProviderAdapter(ABC):
    """Only Runtime owns model credentials and provider-specific behavior."""

    name: str

    @abstractmethod
    async def analyze(
        self,
        batch: CaptureBatch,
        evidence_pack: dict[str, Any],
    ) -> ResourcePlan:
        raise NotImplementedError

    async def aclose(self) -> None:
        return None
