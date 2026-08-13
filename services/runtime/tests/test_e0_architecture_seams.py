import pytest

from xunlei_zhiqu_runtime.models import ManualJobCreateRequest
from xunlei_zhiqu_runtime.services.client_session import (
    AuthOffClientSession,
    StaticTokenClientSession,
)
from xunlei_zhiqu_runtime.services.download_executor import (
    NoopDownloadExecutor,
    execution_request_from_manual_job,
)
from xunlei_zhiqu_runtime.services.job_store import cancel_job, create_manual_job, get_job


def test_runtime_client_session_modes_are_explicit() -> None:
    off = AuthOffClientSession()
    assert off.authenticate(None) is not None

    static = StaticTokenClientSession("test-session")
    assert static.authenticate(None) is None
    assert static.authenticate("wrong-session") is None
    session = static.authenticate("test-session")
    assert session is not None
    assert session.auth_mode == "static_token"


def test_cancel_removes_demo_job_without_expanding_public_job_status() -> None:
    job = create_manual_job(
        ManualJobCreateRequest(
            schema_version="0.1",
            links=["https://example.test/e0-cancel-fixture.zip"],
            title="E0 cancel fixture",
            delivery_target="local",
        )
    )
    assert get_job(job.job_id) is not None
    assert cancel_job(job.job_id) is True
    assert get_job(job.job_id) is None


@pytest.mark.asyncio
async def test_noop_download_executor_receives_runtime_internal_sources() -> None:
    payload = ManualJobCreateRequest(
        schema_version="0.1",
        links=[
            "https://example.test/e0-executor-fixture.zip",
            "https://mirror.example.test/e0-executor-fixture.zip",
        ],
        title="E0 executor fixture",
        delivery_target="local",
    )
    job = create_manual_job(payload)
    execution = execution_request_from_manual_job(job, payload)
    assert execution.job.job_id == job.job_id
    assert execution.sources == tuple(payload.links)

    executor = NoopDownloadExecutor()
    await executor.create(execution)
    await executor.pause(job.job_id)
    await executor.resume(job.job_id)
    await executor.add_source(job.job_id, "https://mirror-2.example.test/e0-executor-fixture.zip")
    assert await executor.status(job.job_id) is None
    await executor.cancel(job.job_id)
    assert cancel_job(job.job_id) is True
