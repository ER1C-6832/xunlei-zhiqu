from datetime import UTC, datetime, timedelta
from urllib.parse import unquote, urlsplit, urlunsplit
from uuid import uuid4

from xunlei_zhiqu_runtime.models import (
    LinkFavoriteCreateRequest,
    LinkHistoryItem,
    ManualJobCreateRequest,
    ResourceJobCreateRequest,
    ResourceJobSnapshot,
)
from xunlei_zhiqu_runtime.services.download_executor import DownloadExecutionStatus
from xunlei_zhiqu_runtime.services.jobs import fixture_jobs


_jobs: list[ResourceJobSnapshot] = []
_created_job_ids: set[str] = set()
_job_contexts: dict[str, ResourceJobCreateRequest] = {}
_history: list[LinkHistoryItem] = []
_store_initialized = False


def initialize_job_store(fixtures_enabled: bool = False) -> None:
    """Initialize the in-memory store once; fixtures are always explicit."""
    global _store_initialized
    if _store_initialized:
        return
    _store_initialized = True
    if not fixtures_enabled:
        return

    jobs = fixture_jobs()
    _jobs.extend(jobs)
    _history.extend(_fixture_history(jobs))


def _reset_job_store_for_tests(*, fixtures_enabled: bool = False) -> None:
    global _store_initialized
    _jobs.clear()
    _created_job_ids.clear()
    _job_contexts.clear()
    _history.clear()
    _store_initialized = False
    initialize_job_store(fixtures_enabled)


def create_job(
    payload: ResourceJobCreateRequest,
    *,
    execution_mode: str = "demo",
    total_bytes_override: int | None = None,
    source_count_override: int | None = None,
    destination_override: str | None = None,
) -> ResourceJobSnapshot:
    for existing in _jobs:
        if existing.plan_id == payload.plan.plan_id and existing.delivery_target == payload.delivery_target:
            return existing

    selected_order = [
        candidate_id
        for item in payload.plan.selected
        for candidate_id in item.candidate_ids
    ]
    selected_ids = set(selected_order)
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

    total_bytes = (
        total_bytes_override
        if total_bytes_override is not None
        else _selected_total_bytes(payload, selected_order)
    )
    selected_labels = [item.label for item in payload.plan.selected]
    subtitle = " · ".join(selected_labels[:3]) or payload.plan.overview or "已确认资源"
    target = payload.delivery_target
    destination = (
        destination_override
        or payload.destination
        or _default_destination(payload.plan.resource_title, target)
    )
    source_page = payload.capture.page.url if payload.capture else None
    real_local = target == "local" and execution_mode == "download_engine"

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
        stage_label=(
            "智取计划已确认，准备保存到云盘"
            if target == "cloud"
            else "准备下载" if real_local else "任务已创建，等待执行"
        ),
        next_action="pause",
        source_count=source_count_override if source_count_override is not None else len(source_ids),
        excluded_count=len(excluded_ids),
        created_at=datetime.now(UTC),
        destination=destination,
        delivery_target=target,
        plan_id=payload.plan.plan_id,
        execution_mode="download_engine" if real_local else "demo",
        resource_type=payload.plan.resource_type,
        plan_overview=payload.plan.overview,
        selected_items=selected_labels,
        alternative_count=len(payload.plan.alternatives),
        source_page=source_page,
    )
    _jobs.insert(0, job)
    if job.execution_mode == "demo":
        _created_job_ids.add(job.job_id)
    _job_contexts[job.job_id] = payload
    _record_history(job, payload, selected_order)
    return job


def create_manual_job(
    payload: ManualJobCreateRequest,
    *,
    execution_mode: str = "demo",
    total_bytes_override: int | None = None,
    source_count_override: int | None = None,
    destination_override: str | None = None,
) -> ResourceJobSnapshot:
    links = [value.strip() for value in payload.links if value.strip()]
    if not links:
        raise ValueError("至少需要一个有效链接")

    primary = links[0]
    title = payload.title.strip() if payload.title and payload.title.strip() else _title_from_link(primary)
    target = payload.delivery_target
    destination = destination_override or payload.destination or _default_destination(title, target)
    resource_type = _infer_resource_type(primary)
    selected_items = [_title_from_link(link) for link in links[:5]]
    real_local = target == "local" and execution_mode == "download_engine"

    job = ResourceJobSnapshot(
        job_id=f"job_{uuid4().hex[:10]}",
        title=title,
        subtitle=f"普通下载 · {len(links)} 个链接",
        kind="normal",
        status="planning",
        progress=0,
        downloaded_bytes=0,
        total_bytes=total_bytes_override if total_bytes_override is not None else 0,
        speed_bytes_per_second=0,
        eta_seconds=None,
        stage_label="准备下载" if real_local else "普通任务已创建，等待执行",
        next_action="pause",
        source_count=source_count_override if source_count_override is not None else len(links),
        excluded_count=0,
        created_at=datetime.now(UTC),
        destination=destination,
        delivery_target=target,
        execution_mode="download_engine" if real_local else "demo",
        resource_type=resource_type,
        plan_overview="手工创建的下载任务",
        selected_items=selected_items,
        alternative_count=0,
        source_page=primary if primary.startswith(("http://", "https://")) else None,
    )
    _jobs.insert(0, job)
    if job.execution_mode == "demo":
        _created_job_ids.add(job.job_id)
    _history.insert(
        0,
        LinkHistoryItem(
            history_id=f"history_{uuid4().hex[:10]}",
            title=title,
            link_type=_link_type(primary, None),
            display_link=_safe_display_link(primary),
            added_at=job.created_at,
            job_id=job.job_id,
            delivery_target=target,
            status="active",
            source_page=job.source_page,
            resource_type=resource_type,
        ),
    )
    return job


def create_favorite(payload: LinkFavoriteCreateRequest) -> LinkHistoryItem:
    selected_order = [
        candidate_id
        for item in payload.plan.selected
        for candidate_id in item.candidate_ids
    ]
    candidate = None
    if payload.capture:
        candidate_map = {item.candidate_id: item for item in payload.capture.candidates}
        candidate = next((candidate_map[cid] for cid in selected_order if cid in candidate_map), None)

    raw_value = candidate.value if candidate else payload.capture.page.url if payload.capture else "resource-plan"
    display_link = _safe_display_link(raw_value)
    now = datetime.now(UTC)

    for index, existing in enumerate(_history):
        if existing.display_link == display_link and existing.title == payload.plan.resource_title:
            updated = existing.model_copy(
                update={
                    "favorite": True,
                    "favorite_at": now,
                    "resource_type": payload.plan.resource_type,
                    "source_page": payload.capture.page.url if payload.capture else existing.source_page,
                }
            )
            _history[index] = updated
            return updated

    total_bytes = _selected_total_bytes_from_capture(payload.capture, selected_order)
    item = LinkHistoryItem(
        history_id=f"history_{uuid4().hex[:10]}",
        title=payload.plan.resource_title,
        link_type=_link_type(raw_value, candidate.candidate_type if candidate else None),
        display_link=display_link,
        size_bytes=total_bytes or None,
        added_at=now,
        job_id=None,
        delivery_target=None,
        status="saved",
        source_page=payload.capture.page.url if payload.capture else None,
        resource_type=payload.plan.resource_type,
        favorite=True,
        favorite_at=now,
    )
    _history.insert(0, item)
    return item


def set_favorite(history_id: str, favorite: bool) -> LinkHistoryItem | None:
    for index, item in enumerate(_history):
        if item.history_id != history_id:
            continue
        updated = item.model_copy(
            update={
                "favorite": favorite,
                "favorite_at": datetime.now(UTC) if favorite else None,
            }
        )
        _history[index] = updated
        return updated
    return None


def list_jobs() -> list[ResourceJobSnapshot]:
    for index, job in enumerate(_jobs):
        _jobs[index] = _advance_demo_job(job)
    _refresh_history_statuses()
    return list(_jobs)


def get_job(job_id: str) -> ResourceJobSnapshot | None:
    index = _find_index(job_id)
    if index is None:
        return None
    _jobs[index] = _advance_demo_job(_jobs[index])
    _refresh_history_statuses()
    return _jobs[index]


def project_execution_status(
    job_id: str,
    status: DownloadExecutionStatus,
) -> ResourceJobSnapshot | None:
    index = _find_index(job_id)
    if index is None:
        return None
    job = _jobs[index]
    if job.execution_mode != "download_engine":
        return job

    total_bytes = status.total_bytes if status.total_bytes > 0 else job.total_bytes
    downloaded_bytes = status.downloaded_bytes
    if status.state == "completed":
        total_bytes = max(total_bytes, downloaded_bytes)
        downloaded_bytes = total_bytes
        progress = 100.0
    elif total_bytes > 0:
        progress = round(min(100.0, downloaded_bytes / total_bytes * 100), 1)
    else:
        progress = 0.0

    public_status = {
        "queued": "planning",
        "downloading": "downloading",
        "paused": "paused",
        "completed": "completed",
        "failed": "interrupted",
        "cancelled": job.status,
    }[status.state]
    stage_label = _execution_stage_label(status)
    issue = status.error if status.state == "failed" else None
    next_action = {
        "queued": "pause",
        "downloading": "pause",
        "paused": "resume",
        "completed": "open",
        "failed": None,
        "cancelled": None,
    }[status.state]

    updated = job.model_copy(
        update={
            "status": public_status,
            "progress": progress,
            "downloaded_bytes": downloaded_bytes,
            "total_bytes": total_bytes,
            "speed_bytes_per_second": status.speed_bytes_per_second,
            "eta_seconds": status.eta_seconds,
            "stage_label": stage_label,
            "issue": issue,
            "next_action": next_action,
            "destination": status.destination or job.destination,
        }
    )
    _jobs[index] = updated
    _refresh_history_statuses()
    return updated


def list_link_history() -> list[LinkHistoryItem]:
    _refresh_history_statuses()
    return sorted(_history, key=lambda item: item.added_at, reverse=True)


def pause_job(job_id: str) -> ResourceJobSnapshot | None:
    index = _find_index(job_id)
    if index is None:
        return None
    job = _jobs[index]
    if job.execution_mode == "download_engine":
        raise ValueError("真实下载任务由下载执行器控制")
    if job.status not in {"planning", "downloading", "verifying", "paused"}:
        raise ValueError(f"任务当前状态 {job.status} 不支持暂停")
    if job.status != "paused":
        job = job.model_copy(
            update={
                "status": "paused",
                "stage_label": "云盘任务已暂停" if job.delivery_target == "cloud" else "已暂停",
                "speed_bytes_per_second": 0,
                "eta_seconds": None,
                "next_action": "resume",
            }
        )
        _jobs[index] = job
    _refresh_history_statuses()
    return job


def resume_job(job_id: str) -> ResourceJobSnapshot | None:
    index = _find_index(job_id)
    if index is None:
        return None
    job = _jobs[index]
    if job.execution_mode == "download_engine":
        raise ValueError("真实下载任务由下载执行器控制")
    if job.status != "paused":
        raise ValueError(f"任务当前状态 {job.status} 不支持恢复")
    speed = _demo_speed(job.total_bytes) if job.job_id in _created_job_ids else 8_400_000
    job = job.model_copy(
        update={
            "status": "downloading",
            "stage_label": "正在继续保存到云盘" if job.delivery_target == "cloud" else "正在继续任务",
            "speed_bytes_per_second": speed,
            "eta_seconds": _eta(job.total_bytes, job.downloaded_bytes, speed),
            "next_action": "pause",
        }
    )
    _jobs[index] = job
    _refresh_history_statuses()
    return job


def cancel_job(job_id: str) -> bool:
    index = _find_index(job_id)
    if index is None:
        return False

    _jobs.pop(index)
    _created_job_ids.discard(job_id)
    _job_contexts.pop(job_id, None)

    retained_history: list[LinkHistoryItem] = []
    for item in _history:
        if item.job_id != job_id:
            retained_history.append(item)
            continue
        if item.favorite:
            retained_history.append(
                item.model_copy(
                    update={
                        "job_id": None,
                        "delivery_target": None,
                        "status": "saved",
                    }
                )
            )
    _history[:] = retained_history
    return True


def _execution_stage_label(status: DownloadExecutionStatus) -> str:
    if status.state == "queued":
        return "准备下载"
    if status.state == "downloading":
        return f"正在下载 {status.current_asset_label}" if status.current_asset_label else "正在下载"
    if status.state == "paused":
        return "已暂停"
    if status.state == "completed":
        return "已完成"
    if status.state == "failed":
        return "下载中断"
    return "任务已取消"


def _selected_total_bytes(payload: ResourceJobCreateRequest, selected_order: list[str]) -> int:
    return _selected_total_bytes_from_capture(payload.capture, selected_order)


def _selected_total_bytes_from_capture(capture, selected_order: list[str]) -> int:
    if not capture:
        return 0
    candidate_map = {candidate.candidate_id: candidate for candidate in capture.candidates}
    total = 0
    for candidate_id in selected_order:
        candidate = candidate_map.get(candidate_id)
        if candidate and candidate.probe_facts and candidate.probe_facts.content_length:
            total += candidate.probe_facts.content_length
    return total


def _record_history(job: ResourceJobSnapshot, payload: ResourceJobCreateRequest, selected_order: list[str]) -> None:
    candidate = None
    if payload.capture:
        candidate_map = {item.candidate_id: item for item in payload.capture.candidates}
        candidate = next((candidate_map[cid] for cid in selected_order if cid in candidate_map), None)

    raw_value = candidate.value if candidate else payload.capture.page.url if payload.capture else "resource-plan"
    display_link = _safe_display_link(raw_value)
    source_page = payload.capture.page.url if payload.capture else None

    for index, existing in enumerate(_history):
        if existing.display_link == display_link and existing.title == job.title and existing.job_id is None:
            _history[index] = existing.model_copy(
                update={
                    "size_bytes": job.total_bytes or existing.size_bytes,
                    "job_id": job.job_id,
                    "delivery_target": job.delivery_target,
                    "status": _history_status(job.status),
                    "source_page": source_page or existing.source_page,
                    "resource_type": job.resource_type,
                }
            )
            return

    _history.insert(
        0,
        LinkHistoryItem(
            history_id=f"history_{uuid4().hex[:10]}",
            title=job.title,
            link_type=_link_type(raw_value, candidate.candidate_type if candidate else None),
            display_link=display_link,
            size_bytes=job.total_bytes or None,
            added_at=job.created_at,
            job_id=job.job_id,
            delivery_target=job.delivery_target,
            status=_history_status(job.status),
            source_page=source_page,
            resource_type=job.resource_type,
        ),
    )


def _refresh_history_statuses() -> None:
    jobs_by_id = {job.job_id: job for job in _jobs}
    for index, item in enumerate(_history):
        if not item.job_id or item.job_id not in jobs_by_id:
            continue
        status = _history_status(jobs_by_id[item.job_id].status)
        if status != item.status:
            _history[index] = item.model_copy(update={"status": status})


def _history_status(status: str) -> str:
    if status == "completed":
        return "completed"
    return "active"


def _link_type(value: str, candidate_type: str | None) -> str:
    if candidate_type == "magnet" or value.startswith("magnet:"):
        return "magnet"
    if candidate_type == "media":
        return "media"
    if value.startswith("http://") or value.startswith("https://"):
        return "http"
    return "unknown"


def _infer_resource_type(value: str) -> str:
    lower = value.lower().split("?", 1)[0]
    if lower.endswith((".mp4", ".mkv", ".m3u8", ".webm")):
        return "video"
    if lower.endswith((".mp3", ".flac", ".aac", ".wav", ".ogg")):
        return "audio"
    if lower.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")):
        return "image"
    if lower.endswith((".zip", ".rar", ".7z", ".tar", ".gz", ".xz")):
        return "archive"
    if lower.endswith((".exe", ".msi", ".dmg", ".pkg", ".appimage", ".deb", ".rpm")):
        return "software"
    return "unknown"


def _safe_display_link(value: str) -> str:
    if value.startswith("http://") or value.startswith("https://"):
        parts = urlsplit(value)
        value = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    return value if len(value) <= 108 else f"{value[:105]}..."


def _title_from_link(value: str) -> str:
    if value.startswith(("http://", "https://")):
        path = unquote(urlsplit(value).path.rstrip("/"))
        if path:
            return path.rsplit("/", 1)[-1] or "新建下载任务"
        host = urlsplit(value).netloc
        return host or "新建下载任务"
    if value.startswith("magnet:"):
        return "Magnet 任务"
    return value[:64] or "新建下载任务"


def _default_destination(title: str, target: str) -> str:
    safe_title = title.replace("/", "-").replace("\\", "-")
    return f"迅雷云盘/智取下载/{safe_title}" if target == "cloud" else f"D:/Downloads/{safe_title}"


def _find_index(job_id: str) -> int | None:
    for index, job in enumerate(_jobs):
        if job.job_id == job_id:
            return index
    return None


def _advance_demo_job(job: ResourceJobSnapshot) -> ResourceJobSnapshot:
    if job.execution_mode != "demo":
        return job
    if job.job_id not in _created_job_ids or job.status in {
        "paused",
        "interrupted",
        "waiting_for_source",
        "completed",
    }:
        return job

    cloud = job.delivery_target == "cloud"
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
                "stage_label": (
                    "正在将资源保存到云盘（演示）"
                    if cloud
                    else "正在执行演示任务"
                ),
                "next_action": "pause",
            }
        )

    if job.status == "downloading" and job.total_bytes > 0:
        ceiling = int(job.total_bytes * 0.92)
        step = max(1_048_576, int(job.total_bytes * 0.025))
        downloaded = min(ceiling, job.downloaded_bytes + step)
        progress = round(downloaded / job.total_bytes * 100, 1)
        speed = _demo_speed(job.total_bytes)
        return job.model_copy(
            update={
                "progress": progress,
                "downloaded_bytes": downloaded,
                "speed_bytes_per_second": 0 if downloaded >= ceiling else speed,
                "eta_seconds": None if downloaded >= ceiling else _eta(job.total_bytes, downloaded, speed),
                "stage_label": "正在保存到云盘（演示）" if cloud else "演示任务进行中",
            }
        )

    if job.status == "downloading" and job.total_bytes == 0:
        return job.model_copy(
            update={
                "speed_bytes_per_second": 0,
                "eta_seconds": None,
                "stage_label": "已进入云盘任务队列" if cloud else "演示任务已创建",
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


def _fixture_history(jobs: list[ResourceJobSnapshot]) -> list[LinkHistoryItem]:
    if len(jobs) < 4:
        return []
    return [
        LinkHistoryItem(
            history_id="history_fixture_001",
            title="Example App 5.2.1",
            link_type="http",
            display_link="https://downloads.example.test/ExampleApp_5.2.1_win_x64_portable.zip",
            size_bytes=2_692_000_000,
            added_at=jobs[0].created_at,
            job_id="job_zhiqu_001",
            delivery_target="local",
            status="active",
            source_page="https://example.test/downloads",
            resource_type="software",
            favorite=True,
            favorite_at=jobs[0].created_at + timedelta(minutes=2),
        ),
        LinkHistoryItem(
            history_id="history_fixture_002",
            title="Open Media Course · 1080p",
            link_type="magnet",
            display_link="magnet:?xt=urn:btih:OPENMEDIACOURSEDEMO",
            size_bytes=7_643_000_000,
            added_at=jobs[1].created_at,
            job_id="job_zhiqu_002",
            delivery_target="cloud",
            status="failed",
            source_page="https://media.example.test/course",
            resource_type="video",
        ),
        LinkHistoryItem(
            history_id="history_fixture_003",
            title="sample-dataset.zip",
            link_type="http",
            display_link="https://data.example.test/sample-dataset.zip",
            size_bytes=482_000_000,
            added_at=jobs[2].created_at,
            job_id="job_normal_001",
            delivery_target="local",
            status="completed",
            source_page="https://data.example.test/datasets",
            resource_type="archive",
        ),
        LinkHistoryItem(
            history_id="history_fixture_004",
            title="Open Tools Pack 2026.08",
            link_type="http",
            display_link="https://downloads.example.test/OpenToolsPack_2026.08_x64.exe",
            size_bytes=734_000_000,
            added_at=jobs[3].created_at,
            job_id="job_zhiqu_003",
            delivery_target="cloud",
            status="completed",
            source_page="https://tools.example.test/releases",
            resource_type="software",
            favorite=True,
            favorite_at=jobs[3].created_at + timedelta(minutes=4),
        ),
    ]
