from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import time
from typing import Literal

from xunlei_zhiqu_runtime.models import EvidencePack, ResourcePlan


class ModelProviderError(RuntimeError):
    """Base error for upstream model-provider failures."""


class ModelProviderTimeoutError(ModelProviderError):
    """The provider accepted the request path but did not answer before the read timeout."""


class ModelProviderRequestError(ModelProviderError):
    """The Runtime could not complete the HTTP request to the provider."""


class ModelProviderResponseError(ModelProviderError):
    """The provider answered, but the response could not be used as a valid ResourcePlan."""


ModelProgressPhase = Literal[
    "model_request_started",
    "model_first_token",
    "model_completed",
]
ModelProgressSink = Callable[[ModelProgressPhase], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class ModelCallMetrics:
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_tokens: int | None = None
    latency_ms: int = 0
    time_to_first_byte_ms: int | None = None
    time_to_first_content_ms: int | None = None
    generation_ms: int | None = None
    stream_total_ms: int | None = None
    output_tokens_per_second: float | None = None
    chunk_count: int | None = None
    connection_reused: bool | None = None
    http_version: str | None = None


@dataclass(frozen=True, slots=True)
class ModelAnalysisResult:
    plan: ResourcePlan
    metrics: ModelCallMetrics


class ModelProviderAdapter(ABC):
    """Runtime's current ModelGatewayPort: EvidencePack -> validated ResourcePlan."""

    name: str

    @property
    def model_name(self) -> str:
        return self.name

    @property
    def cache_namespace(self) -> str:
        return self.name

    @abstractmethod
    async def analyze(self, evidence_pack: EvidencePack) -> ResourcePlan:
        raise NotImplementedError

    async def analyze_with_metrics(
        self,
        evidence_pack: EvidencePack,
        *,
        progress: ModelProgressSink | None = None,
    ) -> ModelAnalysisResult:
        started = time.perf_counter()
        await emit_model_progress(progress, "model_request_started")
        plan = await self.analyze(evidence_pack)
        await emit_model_progress(progress, "model_completed")
        return ModelAnalysisResult(
            plan=plan,
            metrics=ModelCallMetrics(
                model=self.model_name,
                latency_ms=int((time.perf_counter() - started) * 1000),
            ),
        )

    async def aclose(self) -> None:
        return None


async def emit_model_progress(
    sink: ModelProgressSink | None,
    phase: ModelProgressPhase,
) -> None:
    if sink is not None:
        await sink(phase)
