from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import time

import pytest

from xunlei_zhiqu_runtime.models import ManualJobCreateRequest, ResourceJobSnapshot
from xunlei_zhiqu_runtime.services.download_executor import (
    DownloadExecutionAsset,
    DownloadExecutionRequest,
    DownloadExecutionStatus,
    execution_assets_from_manual_job,
)
from xunlei_zhiqu_runtime.services.download_state_store import DownloadStateStore
from xunlei_zhiqu_runtime.services.http_download_executor import HttpDownloadExecutor
from xunlei_zhiqu_runtime.services.job_store import (
    _reset_job_store_for_tests,
    create_manual_job,
    get_job,
    persist_execution_state,
    restored_execution_records,
)


@pytest.fixture(autouse=True)
def clean_store():
    _reset_job_store_for_tests(fixtures_enabled=False)
    yield
    _reset_job_store_for_tests(fixtures_enabled=False)


@pytest.mark.asyncio
async def test_range_resume_uses_disk_offset_and_exact_206(tmp_path: Path) -> None:
    payload = b"resume" * 800_000
    state = ServerState(payload, etag='"v1"')
    server, thread = start_server(range_handler(state))
    offset = len(payload) // 3 + 77
    part = tmp_path / "jdk.bin.part"
    final = tmp_path / "jdk.bin"
    part.write_bytes(payload[:offset])
    asset = DownloadExecutionAsset(
        asset_id="asset_1", label="jdk.bin", filename_hint="jdk.bin",
        primary_source=f"http://127.0.0.1:{server.server_port}/jdk.bin",
        expected_bytes=len(payload), filename="jdk.bin", final_path=str(final),
        part_path=str(part), downloaded_bytes=offset - 4096, etag='"v1"',
    )
    executor = HttpDownloadExecutor(tmp_path)
    try:
        await executor.restore(
            DownloadExecutionRequest(job=job("job_resume", tmp_path), assets=(asset,)),
            DownloadExecutionStatus(state="failed", failure_kind="connection_interrupted", resume_available=True),
        )
        assert (await executor.status("job_resume")).downloaded_bytes == offset
        await executor.resume("job_resume")
        status = await wait_state(executor, "job_resume", "completed")
        assert status.downloaded_bytes == len(payload)
        assert final.read_bytes() == payload
        assert state.range_offsets == [offset]
        assert state.if_ranges == ['"v1"']
    finally:
        await executor.aclose(); stop_server(server, thread)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mode", "expected_kind"),
    [("ignored", "range_unsupported"), ("shifted", "range_mismatch"), ("etag", "remote_changed")],
)
async def test_unsafe_resume_never_appends(tmp_path: Path, mode: str, expected_kind: str) -> None:
    payload = b"guard" * 500_000
    state = ServerState(
        payload,
        ignore_range=mode == "ignored",
        shift=1 if mode == "shifted" else 0,
        etag='"new"' if mode == "etag" else None,
    )
    server, thread = start_server(range_handler(state))
    offset = len(payload) // 4
    part = tmp_path / "guard.bin.part"
    final = tmp_path / "guard.bin"
    part.write_bytes(payload[:offset])
    before = part.read_bytes()
    asset = DownloadExecutionAsset(
        asset_id="asset_1", label="guard.bin", filename_hint="guard.bin",
        primary_source=f"http://127.0.0.1:{server.server_port}/guard.bin",
        expected_bytes=len(payload), filename="guard.bin", final_path=str(final), part_path=str(part),
        downloaded_bytes=offset, etag='"old"' if mode == "etag" else None,
    )
    executor = HttpDownloadExecutor(tmp_path)
    try:
        await executor.restore(
            DownloadExecutionRequest(job=job(f"job_{mode}", tmp_path), assets=(asset,)),
            DownloadExecutionStatus(state="failed", failure_kind="connection_interrupted", resume_available=True),
        )
        await executor.resume(f"job_{mode}")
        status = await wait_state(executor, f"job_{mode}", "failed")
        assert status.failure_kind == expected_kind
        assert part.read_bytes() == before
        assert not final.exists()
    finally:
        await executor.aclose(); stop_server(server, thread)


@pytest.mark.asyncio
async def test_pause_closes_stream_and_resume_creates_range_request(tmp_path: Path) -> None:
    payload = b"pause" * 1_000_000
    state = ServerState(payload, slow=True)
    server, thread = start_server(range_handler(state))
    executor = HttpDownloadExecutor(tmp_path)
    request = DownloadExecutionRequest(job=job("job_pause", tmp_path), assets=(DownloadExecutionAsset(
        asset_id="asset_1", label="pause.bin", filename_hint="pause.bin",
        primary_source=f"http://127.0.0.1:{server.server_port}/pause.bin", expected_bytes=len(payload),
    ),))
    try:
        await executor.create(request)
        part = await wait_part(tmp_path)
        await executor.pause("job_pause")
        paused_size = part.stat().st_size
        requests_before = state.get_count
        await sleep(0.1)
        assert part.stat().st_size == paused_size
        await executor.resume("job_pause")
        await wait_state(executor, "job_pause", "completed", timeout=8)
        assert state.get_count > requests_before
        assert paused_size in state.range_offsets
    finally:
        await executor.aclose(); stop_server(server, thread)


@pytest.mark.asyncio
async def test_sqlite_restart_restores_same_path_and_interrupted_resume(tmp_path: Path) -> None:
    payload = b"persist" * 900_000
    state = ServerState(payload, slow=True)
    server, thread = start_server(range_handler(state))
    db = tmp_path / "runtime.db"
    store1 = DownloadStateStore(db)
    _reset_job_store_for_tests(persistence=store1)
    manual = ManualJobCreateRequest(
        links=[f"http://127.0.0.1:{server.server_port}/persist.bin"], title="persist.bin"
    )
    created = create_manual_job(
        manual, execution_mode="download_engine", total_bytes_override=len(payload), destination_override=str(tmp_path)
    )
    asset = replace(execution_assets_from_manual_job(manual)[0], expected_bytes=len(payload))
    executor1 = HttpDownloadExecutor(tmp_path, state_sink=persist_execution_state)
    try:
        await executor1.create(DownloadExecutionRequest(job=created, assets=(asset,)))
        part = await wait_part(tmp_path)
        path_before = str(part)
        size_before = part.stat().st_size
        await executor1.aclose()
        store1.close()

        store2 = DownloadStateStore(db)
        _reset_job_store_for_tests(persistence=store2)
        restored_request, restored_status = restored_execution_records()[0]
        executor2 = HttpDownloadExecutor(tmp_path, state_sink=persist_execution_state)
        requests_before = state.get_count
        await executor2.restore(restored_request, restored_status)
        status = await executor2.status(created.job_id)
        public = get_job(created.job_id)
        assert status is not None and status.state == "failed" and status.resume_available
        assert status.downloaded_bytes >= size_before
        assert public is not None and public.status == "interrupted" and public.next_action == "resume"
        assert state.get_count == requests_before
        restored_asset = (await executor2.execution_request(created.job_id)).assets[0]
        assert restored_asset.part_path == path_before
        await executor2.resume(created.job_id)
        await wait_state(executor2, created.job_id, "completed", timeout=8)
        assert state.range_offsets and state.range_offsets[-1] >= size_before
        assert (tmp_path / "persist.bin").read_bytes() == payload
        await executor2.aclose(); store2.close()
    finally:
        stop_server(server, thread)


@pytest.mark.asyncio
async def test_multi_asset_restart_skips_completed_and_resumes_partial(tmp_path: Path) -> None:
    first = b"first-complete"
    second = b"second" * 400_000
    state = ServerState(second)
    server, thread = start_server(range_handler(state))
    first_final = tmp_path / "first.bin"; first_final.write_bytes(first)
    second_part = tmp_path / "second.bin.part"; offset = len(second) // 2; second_part.write_bytes(second[:offset])
    request = DownloadExecutionRequest(job=job("job_multi", tmp_path), assets=(
        DownloadExecutionAsset(asset_id="asset_1", label="first.bin", filename_hint="first.bin", primary_source="https://unused.test/first.bin", expected_bytes=len(first), filename="first.bin", final_path=str(first_final), part_path=str(tmp_path / "first.bin.part"), downloaded_bytes=len(first), completed=True),
        DownloadExecutionAsset(asset_id="asset_2", label="second.bin", filename_hint="second.bin", primary_source=f"http://127.0.0.1:{server.server_port}/second.bin", expected_bytes=len(second), filename="second.bin", final_path=str(tmp_path / "second.bin"), part_path=str(second_part), downloaded_bytes=offset),
    ))
    executor = HttpDownloadExecutor(tmp_path)
    try:
        await executor.restore(request, DownloadExecutionStatus(state="failed", failure_kind="runtime_interrupted", resume_available=True))
        await executor.resume("job_multi")
        await wait_state(executor, "job_multi", "completed")
        assert first_final.read_bytes() == first
        assert (tmp_path / "second.bin").read_bytes() == second
        assert state.range_offsets == [offset]
    finally:
        await executor.aclose(); stop_server(server, thread)


@pytest.mark.asyncio
async def test_jpg_multi_image_and_mp4_are_plain_http_assets(tmp_path: Path) -> None:
    files = {
        "/one.jpg": (b"\xff\xd8\xff" + b"J" * 4096, "image/jpeg"),
        "/two.png": (b"\x89PNG\r\n\x1a\n" + b"P" * 4096, "image/png"),
        "/three.jpg": (b"\xff\xd8\xff" + b"K" * 3072, "image/jpeg"),
        "/clip.mp4": (b"\x00\x00\x00\x18ftypmp42" + b"V" * 8192, "video/mp4"),
    }
    server, thread = start_server(file_handler(files))
    assets = tuple(
        DownloadExecutionAsset(asset_id=f"asset_{index}", label=path[1:], filename_hint=path[1:], primary_source=f"http://127.0.0.1:{server.server_port}{path}")
        for index, path in enumerate(files, start=1)
    )
    executor = HttpDownloadExecutor(tmp_path)
    try:
        await executor.create(DownloadExecutionRequest(job=job("job_smoke", tmp_path), assets=assets))
        await wait_state(executor, "job_smoke", "completed")
        for path, (body, _) in files.items():
            assert (tmp_path / path[1:]).read_bytes() == body
    finally:
        await executor.aclose(); stop_server(server, thread)


class ServerState:
    def __init__(self, payload: bytes, *, etag: str | None = None, ignore_range: bool = False, shift: int = 0, slow: bool = False):
        self.payload = payload; self.etag = etag; self.ignore_range = ignore_range; self.shift = shift; self.slow = slow
        self.get_count = 0; self.range_offsets: list[int] = []; self.if_ranges: list[str] = []


def range_handler(state: ServerState):
    class Handler(BaseHTTPRequestHandler):
        def do_HEAD(self):  # noqa: N802
            self.send_response(200); self.send_header("Content-Length", str(len(state.payload)))
            if state.etag: self.send_header("ETag", state.etag)
            self.send_header("Content-Type", "application/octet-stream"); self.end_headers()

        def do_GET(self):  # noqa: N802
            state.get_count += 1
            header = self.headers.get("Range")
            if header and header.startswith("bytes=") and not state.ignore_range:
                requested = int(header[6:].split("-", 1)[0]); state.range_offsets.append(requested)
                if self.headers.get("If-Range"): state.if_ranges.append(self.headers["If-Range"])
                if requested >= len(state.payload):
                    self.send_response(416); self.send_header("Content-Range", f"bytes */{len(state.payload)}")
                    if state.etag: self.send_header("ETag", state.etag)
                    self.end_headers(); return
                start = requested + state.shift
                body = state.payload[start:]
                self.send_response(206); self.send_header("Content-Range", f"bytes {start}-{len(state.payload)-1}/{len(state.payload)}")
            else:
                body = state.payload; self.send_response(200)
            self.send_header("Content-Length", str(len(body))); self.send_header("Content-Type", "application/octet-stream")
            if state.etag: self.send_header("ETag", state.etag)
            self.end_headers()
            for position in range(0, len(body), 64 * 1024):
                try:
                    self.wfile.write(body[position:position + 64 * 1024]); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
                if state.slow: time.sleep(0.003)

        def log_message(self, format: str, *args: object) -> None: return None
    return Handler


def file_handler(files: dict[str, tuple[bytes, str]]):
    class Handler(BaseHTTPRequestHandler):
        def do_HEAD(self):  # noqa: N802
            item = files.get(self.path)
            if item is None: self.send_response(404); self.end_headers(); return
            body, content_type = item; self.send_response(200); self.send_header("Content-Length", str(len(body))); self.send_header("Content-Type", content_type); self.end_headers()
        def do_GET(self):  # noqa: N802
            item = files.get(self.path)
            if item is None: self.send_response(404); self.end_headers(); return
            body, content_type = item; self.send_response(200); self.send_header("Content-Length", str(len(body))); self.send_header("Content-Type", content_type); self.send_header("Content-Disposition", f'attachment; filename="{self.path[1:]}"'); self.end_headers(); self.wfile.write(body)
        def log_message(self, format: str, *args: object) -> None: return None
    return Handler


def start_server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler); thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start(); return server, thread


def stop_server(server: ThreadingHTTPServer, thread: threading.Thread) -> None:
    server.shutdown(); server.server_close(); thread.join(timeout=2)


def job(job_id: str, directory: Path) -> ResourceJobSnapshot:
    return ResourceJobSnapshot(job_id=job_id, title=job_id, subtitle="test", kind="normal", status="planning", progress=0, downloaded_bytes=0, total_bytes=0, speed_bytes_per_second=0, eta_seconds=None, stage_label="准备下载", next_action="pause", source_count=1, excluded_count=0, created_at=datetime.now(UTC), destination=str(directory), delivery_target="local", execution_mode="download_engine", resource_type="archive", selected_items=[job_id])


async def wait_part(directory: Path, timeout: float = 3.0) -> Path:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        parts = list(directory.glob("*.part"))
        if parts and parts[0].stat().st_size > 0: return parts[0]
        await sleep(0.02)
    raise AssertionError(".part file did not appear")


async def wait_state(executor: HttpDownloadExecutor, job_id: str, expected: str, timeout: float = 4.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = await executor.status(job_id)
        if status is not None and status.state == expected: return status
        await sleep(0.02)
    raise AssertionError(f"executor did not reach {expected}: {await executor.status(job_id)}")


async def sleep(seconds: float) -> None:
    import asyncio
    await asyncio.sleep(seconds)
