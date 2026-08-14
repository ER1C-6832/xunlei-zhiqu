from dataclasses import dataclass, replace
from typing import Literal, Protocol
from urllib.parse import unquote, urlsplit, urlunsplit

from xunlei_zhiqu_runtime.models import (
    CapturedResourceCandidate,
    ManualJobCreateRequest,
    ResourceJobCreateRequest,
    ResourceJobSnapshot,
)


DownloadExecutionState = Literal[
    "queued",
    "downloading",
    "paused",
    "completed",
    "failed",
    "cancelled",
]


@dataclass(frozen=True, slots=True)
class DownloadExecutionAsset:
    """One logical file that must be materialized for a ResourceJob."""

    asset_id: str
    label: str
    filename_hint: str | None
    primary_source: str
    alternate_sources: tuple[str, ...] = ()
    expected_bytes: int | None = None


@dataclass(frozen=True, slots=True)
class DownloadExecutionRequest:
    """Runtime-internal execution plan; raw sources never enter public Job snapshots."""

    job: ResourceJobSnapshot
    assets: tuple[DownloadExecutionAsset, ...]


@dataclass(frozen=True, slots=True)
class DownloadExecutionStatus:
    state: DownloadExecutionState
    downloaded_bytes: int = 0
    total_bytes: int = 0
    speed_bytes_per_second: int = 0
    eta_seconds: int | None = None
    current_asset_id: str | None = None
    current_asset_label: str | None = None
    current_filename: str | None = None
    destination: str | None = None
    error: str | None = None


class DownloadExecutorPort(Protocol):
    """Execution boundary between ResourceJob orchestration and a concrete download engine."""

    async def create(self, request: DownloadExecutionRequest) -> None: ...

    async def pause(self, job_id: str) -> None: ...

    async def resume(self, job_id: str) -> None: ...

    async def cancel(self, job_id: str) -> None: ...

    async def status(self, job_id: str) -> DownloadExecutionStatus | None: ...

    async def add_source(self, job_id: str, asset_id: str, source: str) -> None: ...

    async def aclose(self) -> None: ...


class NoopDownloadExecutor:
    """Fixture/fallback executor. Stage E local product flow defaults to the HTTP executor."""

    async def create(self, request: DownloadExecutionRequest) -> None:
        return None

    async def pause(self, job_id: str) -> None:
        return None

    async def resume(self, job_id: str) -> None:
        return None

    async def cancel(self, job_id: str) -> None:
        return None

    async def status(self, job_id: str) -> DownloadExecutionStatus | None:
        return None

    async def add_source(self, job_id: str, asset_id: str, source: str) -> None:
        return None

    async def aclose(self) -> None:
        return None


@dataclass(slots=True)
class _AssetGroup:
    label: str
    filename_hint: str | None
    primary_source: str
    alternate_sources: list[str]
    normalized_keys: set[str]
    canonical_sources: set[str]
    expected_bytes: int | None


def execution_assets_from_resource_job(
    payload: ResourceJobCreateRequest,
) -> tuple[DownloadExecutionAsset, ...]:
    """Compile confirmed PlanItems into deterministic logical files.

    Multiple candidates become alternate sources only when Capture already carries
    deterministic identity evidence (same normalized_key) or their canonical URLs
    are identical. PlanItem membership alone never implies mirror identity.
    """
    if payload.capture is None:
        return ()

    candidate_map = {
        candidate.candidate_id: candidate
        for candidate in payload.capture.candidates
    }
    groups: list[_AssetGroup] = []

    for item in payload.plan.selected:
        for candidate_id in item.candidate_ids:
            candidate = candidate_map.get(candidate_id)
            if candidate is None:
                raise ValueError(f"已确认资源缺少页面来源：{candidate_id}")
            source = candidate.value.strip()
            if not source:
                raise ValueError(f"已确认资源没有可执行来源：{candidate_id}")

            normalized_key = (candidate.normalized_key or "").strip()
            canonical = canonicalize_source(source)
            group = _matching_group(groups, normalized_key, canonical)
            if group is None:
                groups.append(
                    _AssetGroup(
                        label=item.label,
                        filename_hint=_candidate_filename_hint(candidate),
                        primary_source=source,
                        alternate_sources=[],
                        normalized_keys={normalized_key} if normalized_key else set(),
                        canonical_sources={canonical},
                        expected_bytes=_candidate_expected_bytes(candidate),
                    )
                )
                continue

            if normalized_key:
                group.normalized_keys.add(normalized_key)
            if canonical not in group.canonical_sources:
                group.alternate_sources.append(source)
                group.canonical_sources.add(canonical)
            if group.filename_hint is None:
                group.filename_hint = _candidate_filename_hint(candidate)
            if group.expected_bytes is None:
                group.expected_bytes = _candidate_expected_bytes(candidate)

    return tuple(
        DownloadExecutionAsset(
            asset_id=f"asset_{index}",
            label=group.label,
            filename_hint=group.filename_hint,
            primary_source=group.primary_source,
            alternate_sources=tuple(group.alternate_sources),
            expected_bytes=group.expected_bytes,
        )
        for index, group in enumerate(groups, start=1)
    )


def execution_assets_from_manual_job(
    payload: ManualJobCreateRequest,
) -> tuple[DownloadExecutionAsset, ...]:
    """Manual links are separate files unless their canonical URLs are identical."""
    assets: list[DownloadExecutionAsset] = []
    seen: set[str] = set()
    for value in payload.links:
        source = value.strip()
        if not source:
            continue
        canonical = canonicalize_source(source)
        if canonical in seen:
            continue
        seen.add(canonical)
        filename_hint = _filename_from_source(source)
        assets.append(
            DownloadExecutionAsset(
                asset_id=f"asset_{len(assets) + 1}",
                label=filename_hint or payload.title or f"下载文件 {len(assets) + 1}",
                filename_hint=filename_hint,
                primary_source=source,
            )
        )
    return tuple(assets)


def execution_request_from_assets(
    job: ResourceJobSnapshot,
    assets: tuple[DownloadExecutionAsset, ...],
) -> DownloadExecutionRequest:
    return DownloadExecutionRequest(job=job, assets=assets)


def execution_expected_total_bytes(assets: tuple[DownloadExecutionAsset, ...]) -> int:
    if not assets or any(asset.expected_bytes is None for asset in assets):
        return 0
    return sum(asset.expected_bytes or 0 for asset in assets)


def execution_source_count(assets: tuple[DownloadExecutionAsset, ...]) -> int:
    return sum(1 + len(asset.alternate_sources) for asset in assets)


def replace_execution_asset(
    request: DownloadExecutionRequest,
    asset_id: str,
    *,
    alternate_source: str,
) -> DownloadExecutionRequest:
    next_assets: list[DownloadExecutionAsset] = []
    found = False
    canonical = canonicalize_source(alternate_source)
    for asset in request.assets:
        if asset.asset_id != asset_id:
            next_assets.append(asset)
            continue
        found = True
        existing = {
            canonicalize_source(asset.primary_source),
            *(canonicalize_source(value) for value in asset.alternate_sources),
        }
        if canonical in existing:
            next_assets.append(asset)
            continue
        next_assets.append(
            replace(
                asset,
                alternate_sources=asset.alternate_sources + (alternate_source,),
            )
        )
    if not found:
        raise ValueError(f"ExecutionAsset 不存在：{asset_id}")
    return replace(request, assets=tuple(next_assets))


def canonicalize_source(value: str) -> str:
    """Conservative identity key; signed/query-bearing URLs are never over-normalized."""
    source = value.strip()
    parts = urlsplit(source)
    if parts.scheme.lower() not in {"http", "https"}:
        return source

    scheme = parts.scheme.lower()
    netloc = parts.netloc
    if parts.username is None and parts.password is None and parts.hostname:
        host = parts.hostname.lower()
        port = parts.port
        if port is not None and not (
            (scheme == "http" and port == 80)
            or (scheme == "https" and port == 443)
        ):
            host = f"{host}:{port}"
        netloc = host
    path = parts.path or "/"
    return urlunsplit((scheme, netloc, path, parts.query, ""))


def _matching_group(
    groups: list[_AssetGroup],
    normalized_key: str,
    canonical_source: str,
) -> _AssetGroup | None:
    for group in groups:
        if normalized_key and normalized_key in group.normalized_keys:
            return group
        if canonical_source in group.canonical_sources:
            return group
    return None


def _candidate_filename_hint(candidate: CapturedResourceCandidate) -> str | None:
    filename = candidate.metadata.get("filename")
    if isinstance(filename, str) and filename.strip():
        return filename.strip()
    if candidate.display_name and candidate.display_name.strip():
        return candidate.display_name.strip()
    return _filename_from_source(candidate.value)


def _candidate_expected_bytes(candidate: CapturedResourceCandidate) -> int | None:
    if candidate.probe_facts and candidate.probe_facts.content_length is not None:
        return candidate.probe_facts.content_length
    return None


def _filename_from_source(source: str) -> str | None:
    if not source.startswith(("http://", "https://")):
        return None
    path = unquote(urlsplit(source).path.rstrip("/"))
    if not path:
        return None
    value = path.rsplit("/", 1)[-1].strip()
    return value or None
