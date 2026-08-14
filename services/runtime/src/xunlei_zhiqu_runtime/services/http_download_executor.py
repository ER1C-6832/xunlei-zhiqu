from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, replace
from email.message import Message
import logging
from pathlib import Path
import re
import shutil
import tempfile
import time
from urllib.parse import unquote, urlsplit

import httpx

from xunlei_zhiqu_runtime.services.download_executor import (
    DownloadExecutionAsset,
    DownloadExecutionRequest,
    DownloadExecutionStatus,
    DownloadFailureKind,
    replace_asset_in_request,
    replace_execution_asset,
)


_MANIFEST_SUFFIXES = {".m3u8", ".mpd"}
_MANIFEST_CONTENT_TYPES = {
    "application/dash+xml",
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl",
}
_NON_FILE_CONTENT_TYPES = {"text/html", "application/xhtml+xml"}
_WINDOWS_RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}
_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_CONTENT_RANGE = re.compile(r"^bytes\s+(\d+)-(\d+)/(\d+|\*)$", re.IGNORECASE)
_UNSATISFIED_RANGE = re.compile(r"^bytes\s+\*/(\d+|\*)$", re.IGNORECASE)
_PERSIST_INTERVAL_SECONDS = 0.8
_CHUNK_SIZE = 256 * 1024

StateSink = Callable[[DownloadExecutionRequest, DownloadExecutionStatus], None]


@dataclass(slots=True)
class _Execution:
    request: DownloadExecutionRequest
    status: DownloadExecutionStatus
    asset_totals: dict[str, int | None]
    task: asyncio.Task[None] | None = None
    cancel_requested: bool = False
    pause_requested: bool = False
    shutdown_requested: bool = False
    last_persist_at: float = 0.0


@dataclass(frozen=True, slots=True)
class _RemoteHints:
    content_length: int | None = None
    content_type: str | None = None
    etag: str | None = None
    last_modified: str | None = None
    final_url: str | None = None


class HttpDownloadExecutor:
    """Small deterministic HTTP/HTTPS executor with safe same-source Range resume."""

    def __init__(
        self,
        download_directory: Path,
        *,
        state_sink: StateSink | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self.download_directory = download_directory.expanduser().resolve()
        self._state_sink = state_sink
        self._logger = logger or logging.getLogger("xunlei_zhiqu.download")
        self._client = httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0),
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4, keepalive_expiry=120.0),
            headers={"User-Agent": "Xunlei-Zhiqu-Runtime/0.1"},
        )
        self._executions: dict[str, _Execution] = {}

    def validate_assets(self, assets: tuple[DownloadExecutionAsset, ...]) -> None:
        if not assets:
            raise ValueError("没有可执行的下载文件")
        unsupported = [asset.label for asset in assets if not _is_supported_http_asset(asset)]
        if unsupported:
            labels = "、".join(unsupported[:3])
            raise ValueError(f"当前下载器暂不支持这种资源类型：{labels}")

    async def create(self, request: DownloadExecutionRequest) -> None:
        self.validate_assets(request.assets)
        job_id = request.job.job_id
        if job_id in self._executions:
            return
        _ensure_writable_directory(self.download_directory)
        execution = _Execution(
            request=request,
            status=DownloadExecutionStatus(
                state="queued",
                total_bytes=_resolved_total_bytes({asset.asset_id: asset.expected_bytes for asset in request.assets}),
                destination=str(self.download_directory),
            ),
            asset_totals={asset.asset_id: asset.expected_bytes for asset in request.assets},
        )
        self._executions[job_id] = execution
        self._persist(execution, force=True)
        execution.task = self._spawn(execution)

    async def restore(
        self,
        request: DownloadExecutionRequest,
        status: DownloadExecutionStatus,
    ) -> None:
        """Rehydrate without network I/O. Disk files override stale progress metadata."""
        self.validate_assets(request.assets)
        job_id = request.job.job_id
        if job_id in self._executions:
            return
        execution = _Execution(
            request=request,
            status=replace(status, speed_bytes_per_second=0, eta_seconds=None),
            asset_totals={asset.asset_id: asset.expected_bytes for asset in request.assets},
        )
        self._executions[job_id] = execution
        abnormal = self._sync_disk_facts(execution)
        all_complete = bool(execution.request.assets) and all(asset.completed for asset in execution.request.assets)
        if abnormal:
            execution.status = replace(
                execution.status,
                state="failed",
                error="本地断点大小异常，无法安全继续",
                failure_kind="range_mismatch",
                resume_available=False,
            )
        elif all_complete:
            total = _aggregate_downloaded(execution.request.assets)
            execution.status = replace(
                execution.status,
                state="completed",
                downloaded_bytes=total,
                total_bytes=total,
                current_asset_id=None,
                current_asset_label=None,
                current_filename=None,
                error=None,
                failure_kind=None,
                http_status_code=None,
                resume_available=False,
            )
        elif status.state == "paused":
            execution.status = replace(
                execution.status,
                state="paused",
                error=None,
                failure_kind=None,
                http_status_code=None,
                resume_available=True,
            )
        elif status.state in {"queued", "downloading"}:
            kept = _aggregate_downloaded(execution.request.assets)
            execution.status = replace(
                execution.status,
                state="failed",
                error=(
                    "本地服务已重启，已保留当前进度"
                    if kept > 0
                    else "本地服务已重启，任务可以继续"
                ),
                failure_kind="runtime_interrupted",
                http_status_code=None,
                resume_available=True,
            )
        elif status.state == "completed":
            execution.status = replace(
                execution.status,
                state="failed",
                error="已完成文件不存在，任务状态需要人工确认",
                failure_kind="local_io",
                resume_available=False,
            )
        elif status.state == "failed":
            unsafe = status.failure_kind in {"range_unsupported", "range_mismatch", "remote_changed"}
            has_partial = _has_partial_progress(execution.request.assets)
            execution.status = replace(
                execution.status,
                state="failed",
                resume_available=has_partial and not unsafe,
            )
        else:
            execution.status = replace(execution.status, resume_available=False)
        self._refresh_status_totals(execution)
        self._persist(execution, force=True)

    async def pause(self, job_id: str) -> None:
        execution = self._require(job_id)
        if execution.status.state == "paused":
            return
        if execution.status.state not in {"queued", "downloading"}:
            raise ValueError(f"任务当前状态 {execution.status.state} 不支持暂停")
        execution.pause_requested = True
        task = execution.task
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        execution.task = None
        self._sync_disk_facts(execution)
        if execution.status.state != "completed":
            execution.status = replace(
                execution.status,
                state="paused",
                speed_bytes_per_second=0,
                eta_seconds=None,
                error=None,
                failure_kind=None,
                http_status_code=None,
                resume_available=True,
            )
        execution.pause_requested = False
        self._persist(execution, force=True)

    async def resume(self, job_id: str) -> None:
        execution = self._require(job_id)
        if execution.status.state not in {"paused", "failed"}:
            raise ValueError(f"任务当前状态 {execution.status.state} 不支持恢复")
        if execution.status.state == "failed" and not execution.status.resume_available:
            raise ValueError(execution.status.error or "下载已中断，当前不能安全继续")
        if execution.task is not None and not execution.task.done():
            return
        abnormal = self._sync_disk_facts(execution)
        if abnormal:
            execution.status = replace(
                execution.status,
                state="failed",
                error="本地断点大小异常，无法安全继续",
                failure_kind="range_mismatch",
                resume_available=False,
            )
            self._persist(execution, force=True)
            raise ValueError(execution.status.error)
        execution.pause_requested = False
        execution.cancel_requested = False
        execution.shutdown_requested = False
        execution.status = replace(
            execution.status,
            state="downloading",
            speed_bytes_per_second=0,
            eta_seconds=None,
            error=None,
            failure_kind=None,
            http_status_code=None,
            resume_available=False,
        )
        self._persist(execution, force=True)
        execution.task = self._spawn(execution)

    async def cancel(self, job_id: str) -> None:
        execution = self._executions.get(job_id)
        if execution is None:
            return
        execution.cancel_requested = True
        task = execution.task
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        execution.task = None
        for asset in execution.request.assets:
            if not asset.completed and asset.part_path:
                _delete_partial(Path(asset.part_path))
        self._sync_disk_facts(execution)
        execution.status = replace(
            execution.status,
            state="cancelled",
            speed_bytes_per_second=0,
            eta_seconds=None,
            error=None,
            failure_kind=None,
            http_status_code=None,
            resume_available=False,
        )

    async def status(self, job_id: str) -> DownloadExecutionStatus | None:
        execution = self._executions.get(job_id)
        if execution is None:
            return None
        return replace(execution.status)

    async def execution_request(self, job_id: str) -> DownloadExecutionRequest | None:
        execution = self._executions.get(job_id)
        return execution.request if execution is not None else None

    async def add_source(self, job_id: str, asset_id: str, source: str) -> None:
        execution = self._require(job_id)
        value = source.strip()
        if not value:
            raise ValueError("备用来源不能为空")
        execution.request = replace_execution_asset(execution.request, asset_id, alternate_source=value)
        self._persist(execution, force=True)

    async def aclose(self) -> None:
        tasks: list[tuple[_Execution, asyncio.Task[None]]] = []
        for execution in self._executions.values():
            task = execution.task
            if task is None or task.done():
                continue
            execution.shutdown_requested = True
            task.cancel()
            tasks.append((execution, task))
        for execution, task in tasks:
            with suppress(asyncio.CancelledError):
                await task
            execution.task = None
            self._sync_disk_facts(execution)
            if execution.status.state in {"queued", "downloading"}:
                execution.status = replace(
                    execution.status,
                    speed_bytes_per_second=0,
                    eta_seconds=None,
                    resume_available=_has_partial_progress(execution.request.assets),
                )
            self._persist(execution, force=True)
        await self._client.aclose()

    def _spawn(self, execution: _Execution) -> asyncio.Task[None]:
        return asyncio.create_task(
            self._run_job(execution),
            name=f"zhiqu-download-{execution.request.job.job_id}",
        )

    async def _run_job(self, execution: _Execution) -> None:
        try:
            for current in tuple(execution.request.assets):
                asset = self._asset(execution, current.asset_id)
                if asset.completed and asset.final_path and Path(asset.final_path).exists():
                    continue
                execution.status = replace(
                    execution.status,
                    state="downloading",
                    current_asset_id=asset.asset_id,
                    current_asset_label=asset.label,
                    current_filename=asset.filename,
                    speed_bytes_per_second=0,
                    eta_seconds=None,
                    error=None,
                    failure_kind=None,
                    http_status_code=None,
                    resume_available=False,
                )
                self._refresh_status_totals(execution)
                self._persist(execution, force=True)
                updated = await self._download_asset(execution, asset)
                execution.request = replace_asset_in_request(execution.request, updated)
                execution.asset_totals[updated.asset_id] = updated.expected_bytes or updated.downloaded_bytes
                self._refresh_status_totals(execution)
                self._persist(execution, force=True)

            total = _aggregate_downloaded(execution.request.assets)
            execution.status = replace(
                execution.status,
                state="completed",
                downloaded_bytes=total,
                total_bytes=total,
                speed_bytes_per_second=0,
                eta_seconds=None,
                current_asset_id=None,
                current_asset_label=None,
                current_filename=None,
                error=None,
                failure_kind=None,
                http_status_code=None,
                resume_available=False,
            )
            self._persist(execution, force=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._sync_disk_facts(execution)
            failure_kind, http_status_code, message = _failure_fact(exc)
            unsafe = failure_kind in {"range_unsupported", "range_mismatch", "remote_changed"}
            resumable = _has_partial_progress(execution.request.assets) and not unsafe
            if resumable and failure_kind in {"connection_interrupted", "runtime_interrupted", "length_mismatch"}:
                message = f"{message}，已保留当前进度"
            execution.status = replace(
                execution.status,
                state="failed",
                speed_bytes_per_second=0,
                eta_seconds=None,
                error=message,
                failure_kind=failure_kind,
                http_status_code=http_status_code,
                resume_available=resumable,
            )
            self._persist(execution, force=True)

    async def _download_asset(
        self,
        execution: _Execution,
        asset: DownloadExecutionAsset,
    ) -> DownloadExecutionAsset:
        source = asset.primary_source
        _ensure_supported_source(source)
        _ensure_writable_directory(self.download_directory)

        asset = self._refresh_asset_from_disk(asset)
        if asset.expected_bytes is not None and asset.downloaded_bytes > asset.expected_bytes:
            raise _RangeMismatch(asset.downloaded_bytes, None, asset.expected_bytes)

        if asset.expected_bytes is None:
            hints = await self._head_hints(source)
            if hints.content_length is not None:
                asset = replace(asset, expected_bytes=hints.content_length)
                execution.asset_totals[asset.asset_id] = hints.content_length
            asset = replace(
                asset,
                content_type=asset.content_type or hints.content_type,
                etag=asset.etag or hints.etag,
                last_modified=asset.last_modified or hints.last_modified,
                final_url=asset.final_url or hints.final_url,
            )
            execution.request = replace_asset_in_request(execution.request, asset)
            self._refresh_status_totals(execution)
            self._persist(execution, force=True)

        offset = asset.downloaded_bytes
        if asset.expected_bytes is not None:
            _ensure_disk_space(self.download_directory, max(0, asset.expected_bytes - offset))

        headers: dict[str, str] = {}
        if offset > 0:
            headers["Range"] = f"bytes={offset}-"
            validator = _if_range_validator(asset)
            if validator:
                headers["If-Range"] = validator

        try:
            async with self._client.stream("GET", source, headers=headers) as response:
                if offset > 0:
                    maybe_complete = self._validate_resume_response(execution, asset, response, offset)
                    if maybe_complete is not None:
                        return maybe_complete
                elif response.status_code >= 400:
                    raise _HttpStatusFailure(response.status_code)
                elif response.status_code not in {200, 206}:
                    raise _HttpStatusFailure(response.status_code)

                _ensure_supported_source(str(response.url))
                _ensure_supported_response(response)
                content_type = _content_type(response)
                response_etag = _clean_header(response.headers.get("etag"))
                response_last_modified = _clean_header(response.headers.get("last-modified"))

                if offset == 0:
                    total = _initial_response_total(response)
                    if total is not None:
                        asset = replace(asset, expected_bytes=total)
                        execution.asset_totals[asset.asset_id] = total
                    if response.status_code == 206:
                        start, _, remote_total = _parse_content_range(response.headers.get("content-range"))
                        if start != 0:
                            raise _RangeMismatch(0, start, remote_total)
                        asset = replace(asset, range_capability="supported")

                if asset.final_path is None or asset.part_path is None:
                    filename = _choose_filename(response, asset)
                    final_path, part_path = _allocate_paths(self.download_directory, filename)
                    asset = replace(
                        asset,
                        filename=final_path.name,
                        final_path=str(final_path),
                        part_path=str(part_path),
                    )
                else:
                    final_path = Path(asset.final_path)
                    part_path = Path(asset.part_path)
                    if final_path.exists() and not asset.completed:
                        raise _LocalDestinationConflict()

                asset = replace(
                    asset,
                    final_url=str(response.url),
                    content_type=content_type or asset.content_type,
                    etag=response_etag or asset.etag,
                    last_modified=response_last_modified or asset.last_modified,
                    downloaded_bytes=offset,
                )
                execution.request = replace_asset_in_request(execution.request, asset)
                execution.status = replace(
                    execution.status,
                    current_filename=Path(asset.final_path).name,
                    destination=str(self.download_directory),
                )
                self._refresh_status_totals(execution)
                self._persist(execution, force=True)

                if asset.expected_bytes is not None:
                    remaining = max(0, asset.expected_bytes - offset)
                    _ensure_disk_space(self.download_directory, remaining)

                mode = "ab" if offset > 0 else "wb"
                last_sample_at = time.perf_counter()
                last_sample_bytes = execution.status.downloaded_bytes
                with Path(asset.part_path).open(mode) as handle:
                    async for chunk in response.aiter_raw(chunk_size=_CHUNK_SIZE):
                        if not chunk:
                            continue
                        handle.write(chunk)
                        # In append mode tell() includes the pre-existing .part bytes.
                        current_size = handle.tell()
                        asset = replace(asset, downloaded_bytes=current_size)
                        execution.request = replace_asset_in_request(execution.request, asset)
                        now = time.perf_counter()
                        elapsed = now - last_sample_at
                        speed = execution.status.speed_bytes_per_second
                        aggregate = _aggregate_downloaded(execution.request.assets)
                        if elapsed >= 0.35:
                            speed = max(0, int((aggregate - last_sample_bytes) / elapsed))
                            last_sample_at = now
                            last_sample_bytes = aggregate
                        self._refresh_status_totals(execution)
                        execution.status = replace(
                            execution.status,
                            state="downloading",
                            speed_bytes_per_second=speed,
                            eta_seconds=_eta(execution.status.total_bytes, aggregate, speed),
                        )
                        self._persist(execution)

                actual_size = Path(asset.part_path).stat().st_size
                if asset.expected_bytes is not None and actual_size != asset.expected_bytes:
                    raise _LengthMismatch(asset.expected_bytes, actual_size)
                if asset.expected_bytes is None:
                    asset = replace(asset, expected_bytes=actual_size)
                    execution.asset_totals[asset.asset_id] = actual_size
                final_path = Path(asset.final_path)
                part_path = Path(asset.part_path)
                if final_path.exists():
                    raise _LocalDestinationConflict()
                part_path.replace(final_path)
                asset = replace(
                    asset,
                    downloaded_bytes=actual_size,
                    completed=True,
                    range_capability=("supported" if offset > 0 else asset.range_capability),
                )
                execution.request = replace_asset_in_request(execution.request, asset)
                return asset
        except httpx.RequestError as exc:
            raise _NetworkFailure() from exc

    def _validate_resume_response(
        self,
        execution: _Execution,
        asset: DownloadExecutionAsset,
        response: httpx.Response,
        offset: int,
    ) -> DownloadExecutionAsset | None:
        response_etag = _clean_header(response.headers.get("etag"))
        response_last_modified = _clean_header(response.headers.get("last-modified"))
        expected = asset.expected_bytes

        if response.status_code == 416:
            remote_total = _parse_unsatisfied_total(response.headers.get("content-range"))
            validator_match = _validator_match(asset, response_etag, response_last_modified)
            self._log_resume(
                execution, asset, offset, 416, None, remote_total, validator_match, False
            )
            if validator_match is False:
                raise _RemoteChanged()
            if expected is not None and offset == expected and (remote_total is None or remote_total == expected):
                if asset.part_path is None or asset.final_path is None:
                    raise _RangeMismatch(offset, None, remote_total)
                part_path = Path(asset.part_path)
                final_path = Path(asset.final_path)
                if not part_path.exists() or part_path.stat().st_size != expected:
                    raise _RangeMismatch(offset, None, remote_total)
                if final_path.exists():
                    raise _LocalDestinationConflict()
                part_path.replace(final_path)
                completed = replace(asset, downloaded_bytes=expected, completed=True)
                execution.request = replace_asset_in_request(execution.request, completed)
                return completed
            raise _RangeMismatch(offset, None, remote_total)

        if response.status_code == 200:
            response_total = _header_content_length(response.headers.get("content-length"))
            validator_match = _validator_match(asset, response_etag, response_last_modified)
            self._log_resume(execution, asset, offset, 200, None, response_total, validator_match, False)
            if validator_match is False or (expected is not None and response_total is not None and response_total != expected):
                raise _RemoteChanged()
            execution.request = replace_asset_in_request(
                execution.request,
                replace(asset, range_capability="unsupported"),
            )
            raise _RangeUnsupported()

        if response.status_code >= 400:
            self._log_resume(execution, asset, offset, response.status_code, None, None, None, False)
            raise _HttpStatusFailure(response.status_code)
        if response.status_code != 206:
            self._log_resume(execution, asset, offset, response.status_code, None, None, None, False)
            raise _RangeUnsupported()

        start, _, remote_total = _parse_content_range(response.headers.get("content-range"))
        validator_match = _validator_match(asset, response_etag, response_last_modified)
        self._log_resume(execution, asset, offset, 206, start, remote_total, validator_match, start == offset)
        if start != offset:
            raise _RangeMismatch(offset, start, remote_total)
        if remote_total is None:
            raise _RangeMismatch(offset, start, remote_total)
        if expected is not None and remote_total != expected:
            raise _RemoteChanged()
        if validator_match is False:
            raise _RemoteChanged()

        execution.asset_totals[asset.asset_id] = remote_total
        updated = replace(
            asset,
            expected_bytes=remote_total,
            final_url=str(response.url),
            content_type=_content_type(response) or asset.content_type,
            etag=response_etag or asset.etag,
            last_modified=response_last_modified or asset.last_modified,
            range_capability="supported",
        )
        execution.request = replace_asset_in_request(execution.request, updated)
        return None

    async def _head_hints(self, source: str) -> _RemoteHints:
        try:
            response = await self._client.head(source)
        except httpx.RequestError:
            return _RemoteHints()
        if response.status_code >= 400:
            return _RemoteHints()
        try:
            _ensure_supported_source(str(response.url))
        except ValueError:
            return _RemoteHints()
        return _RemoteHints(
            content_length=_header_content_length(response.headers.get("content-length")),
            content_type=_content_type(response),
            etag=_clean_header(response.headers.get("etag")),
            last_modified=_clean_header(response.headers.get("last-modified")),
            final_url=str(response.url),
        )

    def _asset(self, execution: _Execution, asset_id: str) -> DownloadExecutionAsset:
        for asset in execution.request.assets:
            if asset.asset_id == asset_id:
                return asset
        raise ValueError(f"ExecutionAsset 不存在：{asset_id}")

    def _refresh_asset_from_disk(self, asset: DownloadExecutionAsset) -> DownloadExecutionAsset:
        if asset.completed and asset.final_path:
            final_path = Path(asset.final_path)
            if final_path.exists():
                size = final_path.stat().st_size
                if asset.expected_bytes is not None and size != asset.expected_bytes:
                    return replace(asset, completed=False, downloaded_bytes=0)
                return replace(asset, downloaded_bytes=size)
        if asset.part_path:
            part_path = Path(asset.part_path)
            if part_path.exists():
                return replace(asset, downloaded_bytes=part_path.stat().st_size, completed=False)
        return replace(asset, downloaded_bytes=0, completed=False)

    def _sync_disk_facts(self, execution: _Execution) -> bool:
        abnormal = False
        assets: list[DownloadExecutionAsset] = []
        for asset in execution.request.assets:
            updated = asset
            if asset.final_path and Path(asset.final_path).exists():
                size = Path(asset.final_path).stat().st_size
                if asset.expected_bytes is not None and size != asset.expected_bytes:
                    abnormal = True
                else:
                    updated = replace(asset, downloaded_bytes=size, completed=True)
            elif asset.part_path and Path(asset.part_path).exists():
                size = Path(asset.part_path).stat().st_size
                if asset.expected_bytes is not None and size > asset.expected_bytes:
                    abnormal = True
                updated = replace(asset, downloaded_bytes=size, completed=False)
            else:
                updated = replace(asset, downloaded_bytes=0, completed=False)
            assets.append(updated)
            execution.asset_totals[updated.asset_id] = updated.expected_bytes
        execution.request = replace(execution.request, assets=tuple(assets))
        self._refresh_status_totals(execution)
        return abnormal

    def _refresh_status_totals(self, execution: _Execution) -> None:
        downloaded = _aggregate_downloaded(execution.request.assets)
        total = _resolved_total_bytes({asset.asset_id: asset.expected_bytes for asset in execution.request.assets})
        execution.status = replace(execution.status, downloaded_bytes=downloaded, total_bytes=total)

    def _persist(self, execution: _Execution, *, force: bool = False) -> None:
        if self._state_sink is None:
            return
        now = time.monotonic()
        if not force and now - execution.last_persist_at < _PERSIST_INTERVAL_SECONDS:
            return
        execution.last_persist_at = now
        self._state_sink(execution.request, execution.status)

    def _log_resume(
        self,
        execution: _Execution,
        asset: DownloadExecutionAsset,
        offset: int,
        response_status: int,
        content_range_start: int | None,
        remote_total: int | None,
        etag_match: bool | None,
        range_resume: bool,
    ) -> None:
        self._logger.info(
            "download_resume job_id=%s asset_id=%s offset=%s response_status=%s "
            "content_range_start=%s remote_total=%s etag_match=%s range_resume=%s",
            execution.request.job.job_id,
            asset.asset_id,
            offset,
            response_status,
            content_range_start,
            remote_total,
            etag_match,
            range_resume,
        )

    def _require(self, job_id: str) -> _Execution:
        execution = self._executions.get(job_id)
        if execution is None:
            raise ValueError("下载任务不存在或已不在当前本地服务中")
        return execution


class _HttpStatusFailure(RuntimeError):
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(f"HTTP {status_code}")


class _NetworkFailure(RuntimeError):
    pass


class _LengthMismatch(RuntimeError):
    def __init__(self, expected: int, actual: int) -> None:
        self.expected = expected
        self.actual = actual
        super().__init__(f"expected={expected} actual={actual}")


class _RangeUnsupported(RuntimeError):
    pass


class _RangeMismatch(RuntimeError):
    def __init__(self, requested: int, returned: int | None, total: int | None) -> None:
        self.requested = requested
        self.returned = returned
        self.total = total
        super().__init__(f"requested={requested} returned={returned} total={total}")


class _RemoteChanged(RuntimeError):
    pass


class _PreflightFailure(RuntimeError):
    def __init__(self, message: str) -> None:
        self.user_message = message
        super().__init__(message)


class _LocalDestinationConflict(RuntimeError):
    pass


def _is_supported_http_asset(asset: DownloadExecutionAsset) -> bool:
    try:
        _ensure_supported_source(asset.primary_source)
    except ValueError:
        return False
    return True


def _ensure_supported_source(source: str) -> None:
    parts = urlsplit(source)
    if parts.scheme.lower() not in {"http", "https"}:
        raise ValueError("当前下载器暂不支持这种资源类型")
    suffix = Path(unquote(parts.path)).suffix.lower()
    if suffix in _MANIFEST_SUFFIXES:
        raise ValueError("当前下载器暂不支持流媒体清单下载")


def _content_type(response: httpx.Response) -> str | None:
    value = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    return value or None


def _ensure_supported_response(response: httpx.Response) -> None:
    content_type = _content_type(response)
    if content_type in _MANIFEST_CONTENT_TYPES:
        raise ValueError("当前下载器暂不支持流媒体清单下载")
    if content_type in _NON_FILE_CONTENT_TYPES:
        raise _PreflightFailure("当前地址返回的是网页，不是可直接下载的文件")


def _ensure_writable_directory(directory: Path) -> None:
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix=".zhiqu-write-", dir=directory, delete=True):
            pass
    except OSError as exc:
        raise _PreflightFailure("保存位置不可用") from exc


def _ensure_disk_space(directory: Path, remaining_required: int) -> None:
    if remaining_required <= 0:
        return
    try:
        free = shutil.disk_usage(directory).free
    except OSError as exc:
        raise _PreflightFailure("保存位置不可用") from exc
    if free < remaining_required:
        raise _PreflightFailure("磁盘空间不足")


def _choose_filename(response: httpx.Response, asset: DownloadExecutionAsset) -> str:
    candidates = [
        _content_disposition_filename(response.headers.get("content-disposition")),
        _url_filename(str(response.url)),
        asset.filename_hint,
        f"download_{asset.asset_id}",
    ]
    for candidate in candidates:
        sanitized = _sanitize_filename(candidate)
        if sanitized:
            return sanitized
    return f"download_{asset.asset_id}"


def _content_disposition_filename(value: str | None) -> str | None:
    if not value:
        return None
    message = Message()
    message["Content-Disposition"] = value
    filename = message.get_filename()
    return filename.strip() if filename else None


def _url_filename(value: str) -> str | None:
    path = unquote(urlsplit(value).path.rstrip("/"))
    if not path:
        return None
    filename = path.rsplit("/", 1)[-1].strip()
    return filename or None


def _sanitize_filename(value: str | None) -> str | None:
    if not value:
        return None
    candidate = unquote(value).replace("\\", "/").rsplit("/", 1)[-1]
    candidate = _INVALID_FILENAME.sub("_", candidate).strip(" .")
    if not candidate or candidate in {".", ".."}:
        return None
    stem = Path(candidate).stem.strip(" .").lower()
    if stem in _WINDOWS_RESERVED_NAMES:
        candidate = f"_{candidate}"
    if len(candidate) > 180:
        suffix = Path(candidate).suffix[:24]
        keep = max(1, 180 - len(suffix))
        candidate = f"{Path(candidate).stem[:keep]}{suffix}"
    return candidate


def _allocate_paths(directory: Path, filename: str) -> tuple[Path, Path]:
    base = Path(filename)
    stem = base.stem or "download"
    suffix = base.suffix
    for index in range(0, 10_000):
        name = filename if index == 0 else f"{stem} ({index}){suffix}"
        final_path = directory / name
        part_path = directory / f"{name}.part"
        if not final_path.exists() and not part_path.exists():
            return final_path, part_path
    raise RuntimeError("无法为下载文件分配安全文件名")


def _clean_header(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _strong_etag(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip()
    if cleaned.lower().startswith("w/"):
        return None
    return cleaned


def _if_range_validator(asset: DownloadExecutionAsset) -> str | None:
    return _strong_etag(asset.etag) or asset.last_modified


def _validator_match(
    asset: DownloadExecutionAsset,
    response_etag: str | None,
    response_last_modified: str | None,
) -> bool | None:
    stored_strong = _strong_etag(asset.etag)
    if stored_strong:
        response_strong = _strong_etag(response_etag)
        return None if response_strong is None else response_strong == stored_strong
    if asset.last_modified:
        return None if response_last_modified is None else response_last_modified == asset.last_modified
    return None


def _header_content_length(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def _initial_response_total(response: httpx.Response) -> int | None:
    if response.status_code == 206:
        _, _, total = _parse_content_range(response.headers.get("content-range"))
        return total
    return _header_content_length(response.headers.get("content-length"))


def _parse_content_range(value: str | None) -> tuple[int | None, int | None, int | None]:
    if not value:
        return None, None, None
    match = _CONTENT_RANGE.match(value.strip())
    if not match:
        return None, None, None
    start = int(match.group(1))
    end = int(match.group(2))
    total = None if match.group(3) == "*" else int(match.group(3))
    if end < start:
        return None, None, total
    return start, end, total


def _parse_unsatisfied_total(value: str | None) -> int | None:
    if not value:
        return None
    match = _UNSATISFIED_RANGE.match(value.strip())
    if not match or match.group(1) == "*":
        return None
    return int(match.group(1))


def _aggregate_downloaded(assets: tuple[DownloadExecutionAsset, ...]) -> int:
    return sum(max(0, asset.downloaded_bytes) for asset in assets)


def _has_partial_progress(assets: tuple[DownloadExecutionAsset, ...]) -> bool:
    return any(not asset.completed and asset.downloaded_bytes > 0 for asset in assets)


def _resolved_total_bytes(asset_totals: dict[str, int | None]) -> int:
    if not asset_totals or any(value is None for value in asset_totals.values()):
        return 0
    return sum(value or 0 for value in asset_totals.values())


def _eta(total_bytes: int, downloaded_bytes: int, speed: int) -> int | None:
    if total_bytes <= downloaded_bytes or speed <= 0:
        return None
    return max(1, int((total_bytes - downloaded_bytes) / speed))


def _delete_partial(path: Path | None) -> None:
    if path is None:
        return
    with suppress(FileNotFoundError, PermissionError):
        path.unlink()


def _failure_fact(exc: Exception) -> tuple[DownloadFailureKind, int | None, str]:
    if isinstance(exc, _HttpStatusFailure):
        if exc.status_code == 404:
            message = "服务器未找到文件"
        elif exc.status_code == 403:
            message = "服务器拒绝访问"
        elif exc.status_code == 410:
            message = "服务器上的文件已不可用"
        else:
            message = f"服务器返回 {exc.status_code}"
        return "http_error", exc.status_code, message
    if isinstance(exc, _NetworkFailure):
        return "connection_interrupted", None, "下载连接已中断"
    if isinstance(exc, _LengthMismatch):
        return "length_mismatch", None, "下载中断，文件大小与服务器声明不一致"
    if isinstance(exc, _RangeUnsupported):
        return "range_unsupported", None, "当前来源不支持断点续传"
    if isinstance(exc, _RangeMismatch):
        return "range_mismatch", None, "服务器返回的断点位置不一致，无法安全继续"
    if isinstance(exc, _RemoteChanged):
        return "remote_changed", None, "下载内容已经发生变化，无法安全继续"
    if isinstance(exc, _PreflightFailure):
        return "preflight", None, exc.user_message
    if isinstance(exc, _LocalDestinationConflict):
        return "local_io", None, "目标文件已存在，未覆盖已有文件"
    if isinstance(exc, OSError):
        return "local_io", None, "保存文件时发生错误"
    if isinstance(exc, ValueError):
        return "unknown", None, str(exc)
    return "unknown", None, "下载中断"
