from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import time

import pytest

from xunlei_zhiqu_runtime.models import (
    ManualJobCreateRequest,
    ResourceJobCreateRequest,
    ResourceJobSnapshot,
)
from xunlei_zhiqu_runtime.services.confirmation import compile_confirmed_request
from xunlei_zhiqu_runtime.services.download_executor import (
    DownloadExecutionAsset,
    DownloadExecutionRequest,
    DownloadExecutionStatus,
    execution_assets_from_manual_job,
    execution_assets_from_resource_job,
)
from xunlei_zhiqu_runtime.services.http_download_executor import HttpDownloadExecutor
from xunlei_zhiqu_runtime.services.job_store import (
    cancel_job,
    create_manual_job,
    get_job,
    project_execution_status,
)


BASE_REQUEST = {
    "schema_version": "0.1",
    "confirmed_item_ids": ["item_main"],
    "delivery_target": "local",
    "plan": {
        "schema_version": "0.1",
        "plan_id": "plan_stage_e",
        "batch_id": "batch_stage_e",
        "provider": "fixture",
        "resource_type": "archive",
        "resource_title": "Stage E archive",
        "overview": "fixture",
        "selected": [
            {
                "item_id": "item_main",
                "candidate_ids": ["c1", "c2"],
                "label": "主文件",
                "plain_explanation": "fixture",
                "reason": "fixture",
                "role": "primary",
            }
        ],
        "alternatives": [
            {
                "item_id": "item_other",
                "candidate_ids": ["c3"],
                "label": "另一个文件",
                "plain_explanation": "fixture",
                "reason": "fixture",
                "role": "alternative",
            }
        ],
        "excluded": [],
        "uncertainties": [],
        "recommendations": [],
    },
    "capture": {
        "schema_version": "0.1",
        "batch_id": "batch_stage_e",
        "trigger": "automatic",
        "page": {"url": "https://example.test", "title": "fixture"},
        "candidates": [
            {
                "candidate_id": "c1",
                "value": "https://mirror-a.test/file.zip",
                "candidate_type": "file",
                "capture_channel": "dom_link",
                "page_url": "https://example.test",
                "display_name": "file.zip",
                "normalized_key": "same-file",
                "probe_facts": {"content_length": 100},
            },
            {
                "candidate_id": "c2",
                "value": "https://mirror-b.test/file.zip",
                "candidate_type": "file",
                "capture_channel": "dom_link",
                "page_url": "https://example.test",
                "display_name": "file.zip",
                "normalized_key": "same-file",
                "probe_facts": {"content_length": 100},
            },
            {
                "candidate_id": "c3",
                "value": "https://downloads.test/other.zip",
                "candidate_type": "file",
                "capture_channel": "dom_link",
                "page_url": "https://example.test",
                "display_name": "other.zip",
                "normalized_key": "other-file",
                "probe_facts": {"content_length": 200},
            },
        ],
    },
}


def test_execution_compiler_groups_only_deterministic_same_resource() -> None:
    payload = ResourceJobCreateRequest.model_validate(BASE_REQUEST)
    assets = execution_assets_from_resource_job(payload)

    assert len(assets) == 1
    assert assets[0].primary_source == "https://mirror-a.test/file.zip"
    assert assets[0].alternate_sources == ("https://mirror-b.test/file.zip",)
    assert assets[0].expected_bytes == 100


def test_execution_compiler_keeps_distinct_confirmed_assets_and_drops_unconfirmed() -> None:
    source = {
        **BASE_REQUEST,
        "confirmed_item_ids": ["item_main", "item_other"],
    }
    payload = compile_confirmed_request(ResourceJobCreateRequest.model_validate(source))
    assets = execution_assets_from_resource_job(payload)

    assert len(assets) == 2
    assert {asset.primary_source for asset in assets} == {
        "https://mirror-a.test/file.zip",
        "https://downloads.test/other.zip",
    }

    only_other = {
        **BASE_REQUEST,
        "confirmed_item_ids": ["item_other"],
    }
    compiled = compile_confirmed_request(ResourceJobCreateRequest.model_validate(only_other))
    filtered_assets = execution_assets_from_resource_job(compiled)
    assert [asset.primary_source for asset in filtered_assets] == [
        "https://downloads.test/other.zip"
    ]


def test_manual_job_treats_distinct_urls_as_distinct_assets() -> None:
    payload = ManualJobCreateRequest(
        schema_version="0.1",
        links=[
            "https://EXAMPLE.test:443/a.zip#section",
            "https://example.test/a.zip",
            "https://example.test/b.zip",
        ],
        delivery_target="local",
    )
    assets = execution_assets_from_manual_job(payload)
    assert [asset.primary_source for asset in assets] == [
        "https://EXAMPLE.test:443/a.zip#section",
        "https://example.test/b.zip",
    ]
    assert all(asset.alternate_sources == () for asset in assets)


def test_real_job_never_uses_demo_progress_and_projects_executor_truth(tmp_path: Path) -> None:
    payload = ManualJobCreateRequest(
        schema_version="0.1",
        links=["https://example.test/real-job.zip"],
        title="real-job.zip",
        delivery_target="local",
    )
    job = create_manual_job(
        payload,
        execution_mode="download_engine",
        total_bytes_override=1000,
        destination_override=str(tmp_path),
    )
    try:
        untouched = get_job(job.job_id)
        assert untouched is not None
        assert untouched.progress == 0
        assert untouched.downloaded_bytes == 0

        projected = project_execution_status(
            job.job_id,
            DownloadExecutionStatus(
                state="downloading",
                downloaded_bytes=400,
                total_bytes=1000,
                speed_bytes_per_second=200,
                eta_seconds=3,
                current_asset_id="asset_1",
                current_asset_label="real-job.zip",
                destination=str(tmp_path),
            ),
        )
        assert projected is not None
        assert projected.execution_mode == "download_engine"
        assert projected.progress == 40.0
        assert projected.downloaded_bytes == 400
        assert projected.total_bytes == 1000
        assert projected.speed_bytes_per_second == 200
        assert projected.eta_seconds == 3

        read_again = get_job(job.job_id)
        assert read_again is not None
        assert read_again.downloaded_bytes == 400
        assert read_again.progress == 40.0
    finally:
        cancel_job(job.job_id)


def test_http_executor_rejects_non_http_and_manifest_assets(tmp_path: Path) -> None:
    executor = HttpDownloadExecutor(tmp_path)
    with pytest.raises(ValueError):
        executor.validate_assets(
            (
                DownloadExecutionAsset(
                    asset_id="asset_1",
                    label="Magnet",
                    filename_hint=None,
                    primary_source="magnet:?xt=urn:btih:demo",
                ),
            )
        )
    with pytest.raises(ValueError):
        executor.validate_assets(
            (
                DownloadExecutionAsset(
                    asset_id="asset_1",
                    label="HLS",
                    filename_hint="video.m3u8",
                    primary_source="https://example.test/video.m3u8",
                ),
            )
        )


@pytest.mark.asyncio
async def test_http_executor_writes_part_pauses_resumes_and_renames(tmp_path: Path) -> None:
    payload = b"stage-e" * 600_000
    server = ThreadingHTTPServer(("127.0.0.1", 0), _slow_handler(payload))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    executor = HttpDownloadExecutor(tmp_path)
    job = _job("job_http_smoke", tmp_path)
    request = DownloadExecutionRequest(
        job=job,
        assets=(
            DownloadExecutionAsset(
                asset_id="asset_1",
                label="测试文件",
                filename_hint="fallback.bin",
                primary_source=f"http://127.0.0.1:{server.server_port}/file.bin",
                expected_bytes=len(payload),
            ),
        ),
    )

    try:
        await executor.create(request)
        part = await _wait_for_part(tmp_path)
        assert part.name == "safe.bin.part"
        assert part.stat().st_size > 0

        await executor.pause(job.job_id)
        await _wait_until(lambda: executor.status(job.job_id), state="paused")
        await _wait_for_stable_size(part)
        paused_size = part.stat().st_size
        await _sleep(0.12)
        assert part.stat().st_size == paused_size

        await executor.resume(job.job_id)
        await _wait_until(lambda: executor.status(job.job_id), state="completed", timeout=8.0)
        final = tmp_path / "safe.bin"
        assert final.exists()
        assert final.read_bytes() == payload
        assert not part.exists()
    finally:
        await executor.aclose()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.asyncio
async def test_http_executor_cancel_removes_current_part(tmp_path: Path) -> None:
    payload = b"cancel-me" * 700_000
    server = ThreadingHTTPServer(("127.0.0.1", 0), _slow_handler(payload))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    executor = HttpDownloadExecutor(tmp_path)
    job = _job("job_http_cancel", tmp_path)
    request = DownloadExecutionRequest(
        job=job,
        assets=(
            DownloadExecutionAsset(
                asset_id="asset_1",
                label="取消测试",
                filename_hint="cancel.bin",
                primary_source=f"http://127.0.0.1:{server.server_port}/cancel.bin",
                expected_bytes=len(payload),
            ),
        ),
    )

    try:
        await executor.create(request)
        part = await _wait_for_part(tmp_path)
        assert part.exists()
        await executor.cancel(job.job_id)
        assert not part.exists()
        status = await executor.status(job.job_id)
        assert status is not None and status.state == "cancelled"
    finally:
        await executor.aclose()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _job(job_id: str, destination: Path) -> ResourceJobSnapshot:
    from datetime import UTC, datetime

    return ResourceJobSnapshot(
        job_id=job_id,
        title="fixture",
        subtitle="fixture",
        kind="normal",
        status="planning",
        progress=0,
        downloaded_bytes=0,
        total_bytes=0,
        speed_bytes_per_second=0,
        eta_seconds=None,
        stage_label="准备下载",
        next_action="pause",
        source_count=1,
        excluded_count=0,
        created_at=datetime.now(UTC),
        destination=str(destination),
        delivery_target="local",
        execution_mode="download_engine",
    )


def _slow_handler(payload: bytes):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", 'attachment; filename="../../safe.bin"')
            self.end_headers()
            for offset in range(0, len(payload), 64 * 1024):
                try:
                    self.wfile.write(payload[offset: offset + 64 * 1024])
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
                time.sleep(0.006)

        def log_message(self, format: str, *args: object) -> None:
            return None

    return Handler


async def _wait_for_part(directory: Path, timeout: float = 3.0) -> Path:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        parts = list(directory.glob("*.part"))
        if parts and parts[0].stat().st_size > 0:
            return parts[0]
        await _sleep(0.02)
    raise AssertionError(".part file did not appear")


async def _wait_for_stable_size(path: Path) -> None:
    previous = -1
    for _ in range(20):
        current = path.stat().st_size
        if current == previous:
            return
        previous = current
        await _sleep(0.02)


async def _wait_until(factory, *, state: str, timeout: float = 3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = await factory()
        if value is not None and value.state == state:
            return value
        await _sleep(0.02)
    raise AssertionError(f"executor did not reach {state}")


async def _sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)
