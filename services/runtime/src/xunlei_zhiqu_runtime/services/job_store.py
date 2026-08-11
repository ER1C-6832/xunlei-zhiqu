from datetime import UTC, datetime
from uuid import uuid4

from xunlei_zhiqu_runtime.models import ResourceJobSnapshot


_jobs: list[ResourceJobSnapshot] = []


def create_job(title: str, subtitle: str, plan_id: str, destination: str | None = None) -> ResourceJobSnapshot:
    job = ResourceJobSnapshot(
        job_id=f"job_{uuid4().hex[:10]}",
        title=title,
        subtitle=subtitle,
        kind="zhiqu",
        status="planning",
        progress=0,
        downloaded_bytes=0,
        total_bytes=0,
        speed_bytes_per_second=0,
        eta_seconds=None,
        stage_label="已创建资源任务，等待执行",
        next_action="resume",
        source_count=1,
        excluded_count=0,
        created_at=datetime.now(UTC),
        destination=destination,
        plan_id=plan_id,
        execution_mode="demo",
    )
    _jobs.insert(0, job)
    return job


def list_created_jobs() -> list[ResourceJobSnapshot]:
    return list(_jobs)
