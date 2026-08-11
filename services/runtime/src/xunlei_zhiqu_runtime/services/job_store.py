from datetime import UTC, datetime
from uuid import uuid4

from xunlei_zhiqu_runtime.models import ResourceJobCreateRequest, ResourceJobSnapshot
from xunlei_zhiqu_runtime.services.jobs import fixture_jobs


_jobs: list[ResourceJobSnapshot] = fixture_jobs()
_created_job_ids: set[str] = set()
_job_contexts: dict[str, ResourceJobCreateRequest] = {}


def create_job(payload: ResourceJobCreateRequest) -> ResourceJobSnapshot:
    for existing in _jobs:
        if existing.plan_id == payload.plan.plan_id:
            return existing

    selected_ids = {
        candidate_id
        for item in payload.plan.selected
        for candidate_id in item.candidate_ids
    }
    source_ids = selected_ids | {
        candidate_id
        for item in payload.plan.alternatives
        for candidate_id in item.candidate_ids
    }
    excluded_ids = {
        candidate_id
        for item in payload.plan.excluded
        for candidate_id in item.candidate_ids
    }

    total_bytes = 0
    if payload.capture:
        candidate_map = {candidate.candidate_id: candidate for candidate in payload.capture.candidates}
        for candidate_id in selected_ids:
            candidate = candidate_map.get(candidate_id)
            if candidate and candidate.probe_facts and candidate.probe_facts.content_length:
                total_bytes += candidate.probe_facts.content_length

    selected_labels = [item.label for item in payload.plan.selected[:3]]
    subtitle = " · ".join(selected_labels) or payload.plan.overview or "节点 A 资源计划"

    job = ResourceJobSnapshot(
        job_id=f"job_{uuid4().hex[:10]}",
        title=payload.plan.resource_title,
        subtitle=subtitle,
        kind="zhiqu",
        status="planning",
        progress=0,
        downloaded_bytes=0,
        total_bytes=total_bytes,
        speed_bytes_per_second=0,
        eta_seconds=None,
        stage_label="资源计划已确认，Runtime 正在创建任务",
        next_action="pause",
        source_count=max(1, len(source_ids)),
        excluded_count=len(excluded_ids),
        created_at=datetime.now(UTC),
        destination=payload.destination,
        plan_id=payload.plan.plan_id,
        execution_mode="demo",
    )
    _jobs.insert(0, job)
    _created_job_ids.add(job.job_id)
    _job_contexts[job.job_id] = payload
    return job


def list_jobs() -> list[ResourceJobSnapshot]:
    for index, job in enumerate(_jobs):
        _jobs[index] = _advance_demo_job(job)
    return list(_jobs)


def get_job(job_id: str) -> ResourceJobSnapshot | None:
    index = _find_index(job_id)
    if index is None:
        return None
    _jobs[index] = _advance_demo_job(_jobs[index])
    return _jobs[index]


def pause_job(job_id: str) -> ResourceJobSnapshot | None:
    index = _find_index(job_id)
    if index is None:
        return None
    job = _jobs[index]
    if job.status not in {"planning", "downloading", "verifying", "paused"}:
        raise ValueError(f"任务当前状态 {job.status} 不支持暂停")
    if job.status != "paused":
        job = job.model_copy(
            update={
                "status": "paused",
                "stage_label": "已暂停",
                "speed_bytes_per_second": 0,
                "eta_seconds": None,
                "next_action": "resume",
            }
        )
        _jobs[index] = job
    return job


def resume_job(job_id: str) -> ResourceJobSnapshot | None:
    index = _find_index(job_id)
    if index is None:
        return None
    job = _jobs[index]
    if job.status != "paused":
        raise ValueError(f"任务当前状态 {job.status} 不支持恢复")
    speed = _demo_speed(job.total_bytes) if job.job_id in _created_job_ids else 8_400_000
    job = job.model_copy(
        update={
            "status": "downloading",
            "stage_label": "正在继续任务",
            "speed_bytes_per_second": speed,
            "eta_seconds": _eta(job.total_bytes, job.downloaded_bytes, speed),
            "next_action": "pause",
        }
    )
    _jobs[index] = job
    return job


def _find_index(job_id: str) -> int | None:
    for index, job in enumerate(_jobs):
        if job.job_id == job_id:
            return index
    return None


def _advance_demo_job(job: ResourceJobSnapshot) -> ResourceJobSnapshot:
    if job.job_id not in _created_job_ids or job.status in {"paused", "waiting_for_source", "completed"}:
        return job

    if job.status == "planning":
        speed = _demo_speed(job.total_bytes)
        downloaded = min(int(job.total_bytes * 0.02), job.total_bytes) if job.total_bytes else 0
        progress = round(downloaded / job.total_bytes * 100, 1) if job.total_bytes else 0
        return job.model_copy(
            update={
                "status": "downloading",
                "progress": progress,
                "downloaded_bytes": downloaded,
                "speed_bytes_per_second": speed,
                "eta_seconds": _eta(job.total_bytes, downloaded, speed),
                "stage_label": "Runtime 已接管资源任务（B2 演示执行）",
                "next_action": "pause",
            }
        )

    if job.status == "downloading" and job.total_bytes > 0:
        ceiling = int(job.total_bytes * 0.92)
        step = max(1_048_576, int(job.total_bytes * 0.025))
        downloaded = min(ceiling, job.downloaded_bytes + step)
        progress = round(downloaded / job.total_bytes * 100, 1)
        speed = _demo_speed(job.total_bytes)
        stage_label = (
            "B2 数据流已验证，等待阶段 E 真实下载引擎"
            if downloaded >= ceiling
            else "Runtime 正在更新任务进度（B2 演示执行）"
        )
        return job.model_copy(
            update={
                "progress": progress,
                "downloaded_bytes": downloaded,
                "speed_bytes_per_second": 0 if downloaded >= ceiling else speed,
                "eta_seconds": None if downloaded >= ceiling else _eta(job.total_bytes, downloaded, speed),
                "stage_label": stage_label,
            }
        )

    if job.status == "downloading" and job.total_bytes == 0:
        return job.model_copy(
            update={
                "speed_bytes_per_second": 0,
                "eta_seconds": None,
                "stage_label": "任务已进入 Runtime，等待阶段 E 下载引擎提供真实进度",
            }
        )

    return job


def _demo_speed(total_bytes: int) -> int:
    if total_bytes <= 0:
        return 0
    return max(1_500_000, min(8_000_000, total_bytes // 40))


def _eta(total_bytes: int, downloaded_bytes: int, speed: int) -> int | None:
    if total_bytes <= downloaded_bytes or speed <= 0:
        return None
    return max(1, (total_bytes - downloaded_bytes) // speed)
