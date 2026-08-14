from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass, replace
from email.message import Message
from pathlib import Path
import re
import time
from urllib.parse import unquote, urlsplit

import httpx

from xunlei_zhiqu_runtime.services.download_executor import (
    DownloadExecutionAsset,
    DownloadExecutionRequest,
    DownloadExecutionStatus,
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
    "con",
    "prn",
    "aux",
    "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}
_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


@dataclass(slots=True)
class _Execution:
    request: DownloadExecutionRequest
    status: DownloadExecutionStatus
    pause_gate: asyncio.Event
    asset_totals: dict[str, int | None]
    task: asyncio.Task[None] | None = None
    current_part: Path | None = None
    cancel_requested: bool = False


class HttpDownloadExecutor:
    """Small real HTTP/HTTPS executor for the Stage E local Demo path."""

    def __init__(self, download_directory: Path) -> None:
        self.download_directory = download_directory.expanduser().resolve()
        self._client = httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0),
            limits=httpx.Limits(
                max_connections=8,
                max_keepalive_connections=4,
                keepalive_expiry=120.0,
            ),
            headers={"User-Agent": "Xunlei-Zhiqu-Runtime/0.1"},
        )
        self._executions: dict[str, _Execution] = {}

    def validate_assets(self, assets: tuple[DownloadExecutionAsset, ...]) -> None:
        if not assets:
            raise ValueError("没有可执行的下载文件")
        unsupported = [asset.label for asset in assets if not _is_supported_http_asset(asset)]
        if unsupported:
            labels = "、".join(unsupported[:3])
            raise ValueError(f"当前演示版下载器暂不支持这种资源类型：{labels}")

    async def create(self, request: DownloadExecutionRequest) -> None:
        self.validate_assets(request.assets)
        if request.job.job_id in self._executions:
            return
        self.download_directory.mkdir(parents=True, exist_ok=True)
        pause_gate = asyncio.Event()
        pause_gate.set()
        execution = _Execution(
            request=request,
            status=DownloadExecutionStatus(
                state="queued",
                downloaded_bytes=0,
                total_bytes=_initial_total_bytes(request.assets),
                destination=str(self.download_directory),
            ),
            pause_gate=pause_gate,
            asset_totals={asset.asset_id: asset.expected_bytes for asset in request.assets},
        )
        self._executions[request.job.job_id] = execution
        execution.task = asyncio.create_task(
            self._run_job(execution),
            name=f"zhiqu-download-{request.job.job_id}",
        )

    async def pause(self, job_id: str) -> None:
        execution = self._require(job_id)
        if execution.status.state == "paused":
            return
        if execution.status.state not in {"queued", "downloading"}:
            raise ValueError(f"任务当前状态 {execution.status.state} 不支持暂停")
        execution.pause_gate.clear()
        execution.status = replace(
            execution.status,
            state="paused",
            speed_bytes_per_second=0,
            eta_seconds=None,
        )

    async def resume(self, job_id: str) -> None:
        execution = self._require(job_id)
        if execution.status.state != "paused":
            raise ValueError(f"任务当前状态 {execution.status.state} 不支持恢复")
        execution.pause_gate.set()
        execution.status = replace(execution.status, state="downloading")

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
        _delete_partial(execution.current_part)
        execution.current_part = None
        execution.status = replace(
            execution.status,
            state="cancelled",
            speed_bytes_per_second=0,
            eta_seconds=None,
            error=None,
        )

    async def status(self, job_id: str) -> DownloadExecutionStatus | None:
        execution = self._executions.get(job_id)
        if execution is None:
            return None
        return replace(execution.status)

    async def add_source(self, job_id: str, asset_id: str, source: str) -> None:
        execution = self._require(job_id)
        value = source.strip()
        if not value:
            raise ValueError("备用来源不能为空")
        execution.request = replace_execution_asset(
            execution.request,
            asset_id,
            alternate_source=value,
        )

    async def aclose(self) -> None:
        tasks: list[asyncio.Task[None]] = []
        for execution in self._executions.values():
            task = execution.task
            if task is None or task.done():
                continue
            task.cancel()
            tasks.append(task)
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
        await self._client.aclose()

    async def _run_job(self, execution: _Execution) -> None:
        completed_bytes = 0
        try:
            for asset in execution.request.assets:
                await execution.pause_gate.wait()
                execution.status = replace(
                    execution.status,
                    state="downloading",
                    current_asset_id=asset.asset_id,
                    current_asset_label=asset.label,
                    current_filename=None,
                    speed_bytes_per_second=0,
                    eta_seconds=None,
                    error=None,
                )
                asset_bytes = await self._download_asset(
                    execution,
                    asset,
                    completed_bytes=completed_bytes,
                )
                completed_bytes += asset_bytes
                execution.asset_totals[asset.asset_id] = asset_bytes
                total_bytes = _resolved_total_bytes(execution.asset_totals)
                execution.status = replace(
                    execution.status,
                    downloaded_bytes=completed_bytes,
                    total_bytes=total_bytes,
                    speed_bytes_per_second=0,
                    eta_seconds=None,
                )

            execution.status = replace(
                execution.status,
                state="completed",
                downloaded_bytes=completed_bytes,
                total_bytes=completed_bytes,
                speed_bytes_per_second=0,
                eta_seconds=None,
                current_asset_id=None,
                current_asset_label=None,
                current_filename=None,
                error=None,
            )
        except asyncio.CancelledError:
            if execution.cancel_requested:
                _delete_partial(execution.current_part)
                execution.current_part = None
            raise
        except Exception as exc:
            execution.status = replace(
                execution.status,
                state="failed",
                speed_bytes_per_second=0,
                eta_seconds=None,
                error=_user_error(exc),
            )

    async def _download_asset(
        self,
        execution: _Execution,
        asset: DownloadExecutionAsset,
        *,
        completed_bytes: int,
    ) -> int:
        source = asset.primary_source
        _ensure_supported_source(source)
        try:
            async with self._client.stream("GET", source) as response:
                if response.status_code >= 400:
                    raise _HttpStatusFailure(response.status_code)
                _ensure_supported_source(str(response.url))
                _ensure_supported_response(response)

                content_length = _header_content_length(response.headers.get("content-length"))
                if content_length is not None:
                    execution.asset_totals[asset.asset_id] = content_length
                filename = _choose_filename(response, asset)
                final_path, part_path = _allocate_paths(self.download_directory, filename)
                execution.current_part = part_path
                total_bytes = _resolved_total_bytes(execution.asset_totals)
                execution.status = replace(
                    execution.status,
                    total_bytes=total_bytes,
                    current_filename=final_path.name,
                    destination=str(self.download_directory),
                )

                asset_downloaded = 0
                last_sample_at = time.perf_counter()
                last_sample_bytes = completed_bytes
                with part_path.open("wb") as handle:
                    async for chunk in response.aiter_raw(chunk_size=256 * 1024):
                        if not chunk:
                            continue
                        await execution.pause_gate.wait()
                        handle.write(chunk)
                        asset_downloaded += len(chunk)
                        current_downloaded = completed_bytes + asset_downloaded
                        now = time.perf_counter()
                        elapsed = now - last_sample_at
                        speed = execution.status.speed_bytes_per_second
                        if elapsed >= 0.35:
                            speed = max(0, int((current_downloaded - last_sample_bytes) / elapsed))
                            last_sample_at = now
                            last_sample_bytes = current_downloaded
                        total_bytes = _resolved_total_bytes(execution.asset_totals)
                        execution.status = replace(
                            execution.status,
                            state="downloading" if execution.pause_gate.is_set() else "paused",
                            downloaded_bytes=current_downloaded,
                            total_bytes=total_bytes,
                            speed_bytes_per_second=speed if execution.pause_gate.is_set() else 0,
                            eta_seconds=_eta(total_bytes, current_downloaded, speed),
                        )

                if content_length is not None and asset_downloaded != content_length:
                    raise _LengthMismatch(content_length, asset_downloaded)
                execution.asset_totals[asset.asset_id] = asset_downloaded
                part_path.replace(final_path)
                execution.current_part = None
                return asset_downloaded
        except httpx.RequestError as exc:
            raise _NetworkFailure() from exc

    def _require(self, job_id: str) -> _Execution:
        execution = self._executions.get(job_id)
        if execution is None:
            raise ValueError("下载任务不存在或已不在当前 Runtime 进程中")
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


def _is_supported_http_asset(asset: DownloadExecutionAsset) -> bool:
    try:
        _ensure_supported_source(asset.primary_source)
    except ValueError:
        return False
    return True


def _ensure_supported_source(source: str) -> None:
    parts = urlsplit(source)
    if parts.scheme.lower() not in {"http", "https"}:
        raise ValueError("当前演示版下载器暂不支持这种资源类型")
    suffix = Path(unquote(parts.path)).suffix.lower()
    if suffix in _MANIFEST_SUFFIXES:
        raise ValueError("当前演示版下载器暂不支持流媒体清单下载")


def _ensure_supported_response(response: httpx.Response) -> None:
    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type in _MANIFEST_CONTENT_TYPES:
        raise ValueError("当前演示版下载器暂不支持流媒体清单下载")
    if content_type in _NON_FILE_CONTENT_TYPES:
        raise ValueError("当前地址返回的是网页，不是可直接下载的文件")


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


def _header_content_length(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def _initial_total_bytes(assets: tuple[DownloadExecutionAsset, ...]) -> int:
    if any(asset.expected_bytes is None for asset in assets):
        return 0
    return sum(asset.expected_bytes or 0 for asset in assets)


def _resolved_total_bytes(asset_totals: dict[str, int | None]) -> int:
    if any(value is None for value in asset_totals.values()):
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


def _user_error(exc: Exception) -> str:
    if isinstance(exc, _HttpStatusFailure):
        return f"服务器返回 {exc.status_code}"
    if isinstance(exc, _NetworkFailure):
        return "当前来源无法访问"
    if isinstance(exc, _LengthMismatch):
        return "下载中断，文件大小与服务器声明不一致"
    if isinstance(exc, ValueError):
        return str(exc)
    return "下载中断"
