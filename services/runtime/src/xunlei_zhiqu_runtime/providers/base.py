from abc import ABC, abstractmethod

from xunlei_zhiqu_runtime.models import EvidencePack, ResourcePlan


class ModelProviderError(RuntimeError):
    """Base error for upstream model-provider failures."""


class ModelProviderTimeoutError(ModelProviderError):
    """The provider accepted the request path but did not answer before the read timeout."""


class ModelProviderRequestError(ModelProviderError):
    """The Runtime could not complete the HTTP request to the provider."""


class ModelProviderResponseError(ModelProviderError):
    """The provider answered, but the response could not be used as a valid ResourcePlan."""


class ModelProviderAdapter(ABC):
    """Model providers only receive a Runtime-built, sanitized EvidencePack."""

    name: str

    @abstractmethod
    async def analyze(self, evidence_pack: EvidencePack) -> ResourcePlan:
        raise NotImplementedError

    async def aclose(self) -> None:
        return None
