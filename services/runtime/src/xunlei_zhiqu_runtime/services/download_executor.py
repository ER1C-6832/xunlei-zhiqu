from dataclasses import dataclass
from typing import Protocol

from xunlei_zhiqu_runtime.models import (
    ManualJobCreateRequest,
    ResourceJobCreateRequest,
    ResourceJobSnapshot,
)


@dataclass(frozen=True, slots=True)
class DownloadExecutionRequest:
    """Runtime-internal execution command; raw sources never enter public Job snapshots."""

    job: ResourceJobSnapshot
    sources: tuple[str, ...]


class DownloadExecutorPort(Protocol):
    """Execution boundary between ResourceJob orchestration and a concrete download engine."""

    async def create(self, request: DownloadExecutionRequest) -> None: ...

    async def pause(self, job_id: str) -> None: ...

    async def resume(self, job_id: str) -> None: ...

    async def cancel(self, job_id: str) -> None: ...

    async def status(self, job_id: str) -> dict[str, object] | None: ...

    async def add_source(self, job_id: str, source: str) -> None: ...


class NoopDownloadExecutor:
    """E0 fixture: preserves the current demo Job flow without downloading bytes."""

    async def create(self, request: DownloadExecutionRequest) -> None:
        return None

    async def pause(self, job_id: str) -> None:
        return None

    async def resume(self, job_id: str) -> None:
        return None

    async def cancel(self, job_id: str) -> None:
        return None

    async def status(self, job_id: str) -> dict[str, object] | None:
        return None

    async def add_source(self, job_id: str, source: str) -> None:
        return None


def execution_request_from_resource_job(
    job: ResourceJobSnapshot,
    payload: ResourceJobCreateRequest,
) -> DownloadExecutionRequest:
    if payload.capture is None:
        return DownloadExecutionRequest(job=job, sources=())

    candidate_map = {
        candidate.candidate_id: candidate.value
        for candidate in payload.capture.candidates
    }
    selected_ids = [
        candidate_id
        for item in payload.plan.selected
        for candidate_id in item.candidate_ids
    ]
    sources = tuple(
        dict.fromkeys(
            candidate_map[candidate_id]
            for candidate_id in selected_ids
            if candidate_id in candidate_map and candidate_map[candidate_id]
        )
    )
    return DownloadExecutionRequest(job=job, sources=sources)


def execution_request_from_manual_job(
    job: ResourceJobSnapshot,
    payload: ManualJobCreateRequest,
) -> DownloadExecutionRequest:
    sources = tuple(dict.fromkeys(value.strip() for value in payload.links if value.strip()))
    return DownloadExecutionRequest(job=job, sources=sources)
