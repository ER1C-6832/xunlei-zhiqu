from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from xunlei_zhiqu_runtime.services.download_executor import replace_asset_in_request
from xunlei_zhiqu_runtime.services.http_download_executor import HttpDownloadExecutor

_SAMPLE_SIZE = 32 * 1024


@dataclass(frozen=True, slots=True)
class SourceVerificationResult:
    status: str
    method: str | None = None
    remote_total: int | None = None
    etag: str | None = None
    last_modified: str | None = None
    samples_checked: int = 0
    detail: str | None = None

    @property
    def verified(self) -> bool:
        return self.status == "verified"


class RecoverableHttpDownloadExecutor(HttpDownloadExecutor):
    """Stage F verification/source switching layered on the frozen Stage E executor."""

    async def retry_same_source(self, job_id: str) -> None:
        execution = self._require(job_id)
        if execution.status.state != "failed":
            raise ValueError("当前任务不需要重新连接")
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
        self._persist(execution, force=True)
        await self.resume(job_id)

    async def verify_source(self, job_id: str, asset_id: str, source: str) -> SourceVerificationResult:
        execution = self._require(job_id)
        asset = self._refresh_asset_from_disk(self._asset(execution, asset_id))
        source = source.strip()
        if not source or urlsplit(source).scheme.lower() not in {"http", "https"}:
            return SourceVerificationResult("unavailable", detail="当前来源不是 HTTP 文件")
        expected_total = asset.expected_bytes
        part_size = asset.downloaded_bytes
        if part_size > 0 and (not asset.part_path or not Path(asset.part_path).exists()):
            return SourceVerificationResult("local_error", detail="本地断点文件不存在")
        if expected_total is not None and part_size > expected_total:
            return SourceVerificationResult("mismatch", detail="本地断点大小超过已知总大小")

        starts = _sample_starts(part_size) or [0]
        remote_total: int | None = None
        response_etag: str | None = None
        response_last_modified: str | None = None
        samples_checked = 0
        try:
            local_handle = Path(asset.part_path).open("rb") if part_size > 0 and asset.part_path else None
            try:
                for start in starts:
                    length = min(_SAMPLE_SIZE, max(1, part_size - start)) if part_size > 0 else 1
                    end = start + length - 1
                    response = await self._client.get(source, headers={"Range": f"bytes={start}-{end}"})
                    if response.status_code == 200:
                        return SourceVerificationResult("range_unsupported", detail="新来源不支持 Range，不能复用已有进度")
                    if response.status_code >= 400:
                        return SourceVerificationResult("unavailable", detail=f"新来源返回 HTTP {response.status_code}")
                    if response.status_code != 206:
                        return SourceVerificationResult("range_unsupported", detail=f"新来源未返回 206（HTTP {response.status_code}）")
                    range_start, range_end, current_total = _parse_content_range(response.headers.get("content-range"))
                    if range_start != start or range_end != end or current_total is None:
                        return SourceVerificationResult("mismatch", detail="新来源返回的 Content-Range 与验证区间不一致")
                    if remote_total is None:
                        remote_total = current_total
                    elif remote_total != current_total:
                        return SourceVerificationResult("mismatch", detail="新来源总大小在验证期间发生变化")
                    if expected_total is not None and current_total != expected_total:
                        return SourceVerificationResult("mismatch", detail="新来源总大小与原任务不一致")
                    body = response.content
                    if len(body) != length:
                        return SourceVerificationResult("mismatch", detail="新来源抽样字节长度不一致")
                    if local_handle is not None:
                        local_handle.seek(start)
                        if body != local_handle.read(length):
                            self._logger.info("source_verify job_id=%s asset_id=%s result=mismatch sample_offset=%s", job_id, asset_id, start)
                            return SourceVerificationResult("mismatch", remote_total=current_total, samples_checked=samples_checked, detail="此来源与已下载内容不一致")
                    response_etag = _clean_header(response.headers.get("etag")) or response_etag
                    response_last_modified = _clean_header(response.headers.get("last-modified")) or response_last_modified
                    samples_checked += 1
            finally:
                if local_handle is not None:
                    local_handle.close()
        except httpx.RequestError:
            return SourceVerificationResult("unavailable", detail="无法连接新来源")
        except OSError:
            return SourceVerificationResult("local_error", detail="无法读取本地断点文件")

        method = "sample_match" if part_size > 0 else "size_and_range"
        self._logger.info("source_verify job_id=%s asset_id=%s result=verified method=%s samples=%s remote_total=%s", job_id, asset_id, method, samples_checked, remote_total)
        return SourceVerificationResult("verified", method=method, remote_total=remote_total, etag=response_etag, last_modified=response_last_modified, samples_checked=samples_checked)

    async def switch_source(self, job_id: str, asset_id: str, source: str, verification: SourceVerificationResult) -> None:
        if not verification.verified:
            raise ValueError("新来源尚未通过确定性验证")
        execution = self._require(job_id)
        asset = self._refresh_asset_from_disk(self._asset(execution, asset_id))
        old_primary = asset.primary_source
        alternate_sources: list[str] = []
        for value in (old_primary, *asset.alternate_sources):
            if value == source or value in alternate_sources:
                continue
            alternate_sources.append(value)
        updated = replace(
            asset,
            primary_source=source,
            alternate_sources=tuple(alternate_sources),
            expected_bytes=verification.remote_total or asset.expected_bytes,
            downloaded_bytes=asset.downloaded_bytes,
            final_url=None,
            etag=verification.etag,
            last_modified=verification.last_modified,
            range_capability="supported",
            completed=False,
        )
        execution.request = replace_asset_in_request(execution.request, updated)
        execution.asset_totals[asset_id] = updated.expected_bytes
        execution.status = replace(
            execution.status,
            state="paused",
            downloaded_bytes=sum(max(0, item.downloaded_bytes) for item in execution.request.assets),
            total_bytes=sum(item.expected_bytes or 0 for item in execution.request.assets) if all(item.expected_bytes is not None for item in execution.request.assets) else 0,
            speed_bytes_per_second=0,
            eta_seconds=None,
            current_asset_id=asset_id,
            current_asset_label=updated.label,
            current_filename=updated.filename,
            error=None,
            failure_kind=None,
            http_status_code=None,
            resume_available=True,
        )
        self._persist(execution, force=True)
        self._logger.info("source_switch job_id=%s asset_id=%s offset=%s verification=%s", job_id, asset_id, updated.downloaded_bytes, verification.method)


def _sample_starts(part_size: int) -> list[int]:
    if part_size <= 0:
        return []
    length = min(_SAMPLE_SIZE, part_size)
    return list(dict.fromkeys([0, max(0, (part_size - length) // 2), max(0, part_size - length)]))


def _parse_content_range(value: str | None) -> tuple[int | None, int | None, int | None]:
    if not value:
        return None, None, None
    text = value.strip().lower()
    if not text.startswith("bytes ") or "/" not in text or "-" not in text:
        return None, None, None
    try:
        interval, total_text = text[6:].split("/", 1)
        start_text, end_text = interval.split("-", 1)
        total = int(total_text) if total_text != "*" else None
        return int(start_text), int(end_text), total
    except ValueError:
        return None, None, None


def _clean_header(value: str | None) -> str | None:
    cleaned = value.strip() if value else ""
    return cleaned or None
