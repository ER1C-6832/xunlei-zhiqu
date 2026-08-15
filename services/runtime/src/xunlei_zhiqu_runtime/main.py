import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
import json
import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from xunlei_zhiqu_runtime import __version__
from xunlei_zhiqu_runtime.config import get_settings
from xunlei_zhiqu_runtime.models import CaptureBatch, HealthResponse, LinkFavoriteCreateRequest, LinkFavoriteUpdateRequest, LinkHistoryItem, ManualJobCreateRequest, ResourceJobCreateRequest, ResourceJobSnapshot, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import ModelProviderRequestError, ModelProviderResponseError, ModelProviderTimeoutError
from xunlei_zhiqu_runtime.providers.factory import create_provider
from xunlei_zhiqu_runtime.resources import task_center_dist_path
from xunlei_zhiqu_runtime.services import job_store as job_store_module
from xunlei_zhiqu_runtime.services.analyzer import CaptureAnalyzer
from xunlei_zhiqu_runtime.services.client_session import create_client_session_auth
from xunlei_zhiqu_runtime.services.confirmation import compile_confirmed_request
from xunlei_zhiqu_runtime.services.download_executor import NoopDownloadExecutor, execution_assets_from_manual_job, execution_assets_from_resource_job, execution_expected_total_bytes, execution_request_from_assets, execution_source_count
from xunlei_zhiqu_runtime.services.download_state_store import DownloadStateStore
from xunlei_zhiqu_runtime.services.job_store import cancel_job, create_favorite, create_job, create_manual_job, initialize_job_store, list_link_history, pause_job, persist_execution_state, project_execution_status, restored_execution_records, resume_job, set_favorite
from xunlei_zhiqu_runtime.services.plan_cache import ResourcePlanCache
from xunlei_zhiqu_runtime.services.recovery import PendingRecoveryView, RecoveryCandidateChoiceResult, RecoveryCaptureRequest, RecoveryCaptureResult, RecoveryHandoff, RecoveryService
from xunlei_zhiqu_runtime.services.recovery_http_executor import RecoverableHttpDownloadExecutor

logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    state_store = DownloadStateStore(settings.runtime_state_db_path)
    initialize_job_store(settings.task_fixtures_enabled, persistence=state_store)
    provider = create_provider(settings)
    session_token = settings.runtime_static_session_token.get_secret_value() if settings.runtime_static_session_token is not None else None
    download_executor = RecoverableHttpDownloadExecutor(settings.download_directory_path, state_sink=persist_execution_state, logger=logger) if settings.download_executor == "http" else NoopDownloadExecutor()
    recovery_service = RecoveryService(provider=provider, executor=download_executor, state_store=state_store) if isinstance(download_executor, RecoverableHttpDownloadExecutor) else None
    app.state.settings = settings
    app.state.provider = provider
    app.state.state_store = state_store
    app.state.client_session_auth = create_client_session_auth(settings.runtime_auth_mode, session_token)
    app.state.download_executor = download_executor
    app.state.download_executor_mode = settings.download_executor
    app.state.recovery_service = recovery_service
    app.state.plan_cache = ResourcePlanCache(ttl_seconds=settings.plan_cache_ttl_seconds, max_entries=settings.plan_cache_max_entries)
    app.state.analyzer = CaptureAnalyzer(provider, cache=app.state.plan_cache)

    restored = restored_execution_records()
    if settings.download_executor == "http":
        for execution_request, execution_status in restored:
            await download_executor.restore(execution_request, execution_status)
    restored_statuses = [status for execution_request, _ in restored if (status := await download_executor.status(execution_request.job.job_id)) is not None]
    logger.info("download_rehydrate jobs_loaded=%s resumable_jobs=%s completed_jobs=%s", len(restored), sum(1 for status in restored_statuses if status.state in {"paused", "failed"} and status.resume_available), sum(1 for status in restored_statuses if status.state == "completed"))

    reconcile_task = asyncio.create_task(
        _reconcile_execution_loop(app),
        name="zhiqu-execution-reconcile",
    ) if recovery_service is not None else None
    try:
        yield
    finally:
        if reconcile_task is not None:
            reconcile_task.cancel()
            with suppress(asyncio.CancelledError):
                await reconcile_task
        await download_executor.aclose()
        await provider.aclose()
        state_store.close()


_boot_settings = get_settings()
app = FastAPI(title="迅雷智取 Runtime", version=__version__, description="单编排器、双智能节点、确定性执行的本地 Runtime。", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=_boot_settings.cors_origins, allow_origin_regex=r"chrome-extension://.*", allow_credentials=False, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "X-Zhiqu-Session"])


@app.middleware("http")
async def runtime_client_session_boundary(request: Request, call_next):
    protected = request.method != "OPTIONS" and request.url.path.startswith("/v1/") and request.url.path != "/v1/health"
    if protected:
        session = request.app.state.client_session_auth.authenticate(request.headers.get("X-Zhiqu-Session"))
        if session is None:
            return JSONResponse(status_code=401, content={"detail": "Runtime session required"})
        request.state.zhiqu_session = session
    return await call_next(request)


@app.get("/v1/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    return HealthResponse(provider=request.app.state.provider.name)


@app.post("/v1/capture/analyze", response_model=ResourcePlan)
async def analyze_capture(batch: CaptureBatch, request: Request, refresh: bool = False) -> ResourcePlan:
    try:
        return await request.app.state.analyzer.analyze(batch, force_refresh=refresh)
    except ModelProviderTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except (ModelProviderRequestError, ModelProviderResponseError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"模型返回的 ResourcePlan 未通过确定性校验：{exc}") from exc


@app.post("/v1/capture/analyze-stream", response_class=StreamingResponse)
async def analyze_capture_stream(batch: CaptureBatch, request: Request, refresh: bool = False) -> StreamingResponse:
    analyzer = request.app.state.analyzer

    async def stream_events() -> AsyncIterator[str]:
        queue: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()
        cache_hit = False

        async def phase_sink(phase: str) -> None:
            nonlocal cache_hit
            if phase == "cache_hit":
                cache_hit = True
            await queue.put({"type": "phase", "phase": phase})

        async def run_analysis() -> None:
            try:
                plan = await analyzer.analyze(batch, force_refresh=refresh, phase_sink=phase_sink)
                await queue.put({"type": "phase", "phase": "done"})
                await queue.put({"type": "result", "plan": plan.model_dump(mode="json"), "cache_hit": cache_hit})
            except (ModelProviderTimeoutError, ModelProviderRequestError, ModelProviderResponseError, ValueError) as exc:
                await queue.put({"type": "error", "message": _analysis_stream_error(exc)})
            except Exception:
                logger.exception("progressive analysis failed unexpectedly")
                await queue.put({"type": "error", "message": "智能分析失败，请稍后重试。"})
            finally:
                await queue.put(None)

        task = asyncio.create_task(run_analysis())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
        finally:
            if not task.done():
                task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    return StreamingResponse(stream_events(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.post("/v1/jobs", response_model=ResourceJobSnapshot)
async def create_resource_job(payload: ResourceJobCreateRequest, request: Request) -> ResourceJobSnapshot:
    try:
        compiled = compile_confirmed_request(payload)
        if _uses_real_local_executor(request, compiled.delivery_target):
            assets = execution_assets_from_resource_job(compiled)
            request.app.state.download_executor.validate_assets(assets)
            destination = str(request.app.state.settings.download_directory_path.expanduser().resolve())
            job = create_job(compiled, execution_mode="download_engine", total_bytes_override=execution_expected_total_bytes(assets), source_count_override=execution_source_count(assets), destination_override=destination, private_context=payload)
            try:
                await request.app.state.download_executor.create(execution_request_from_assets(job, assets))
            except Exception:
                cancel_job(job.job_id)
                raise
            return _read_job_snapshot(job.job_id) or job
        job = create_job(compiled)
        if compiled.delivery_target == "local":
            await request.app.state.download_executor.create(execution_request_from_assets(job, execution_assets_from_resource_job(compiled)))
        return job
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="无法创建本地下载文件") from exc


@app.post("/v1/jobs/manual", response_model=ResourceJobSnapshot)
async def create_manual_resource_job(payload: ManualJobCreateRequest, request: Request) -> ResourceJobSnapshot:
    try:
        if _uses_real_local_executor(request, payload.delivery_target):
            assets = execution_assets_from_manual_job(payload)
            request.app.state.download_executor.validate_assets(assets)
            destination = str(request.app.state.settings.download_directory_path.expanduser().resolve())
            job = create_manual_job(payload, execution_mode="download_engine", total_bytes_override=execution_expected_total_bytes(assets), source_count_override=execution_source_count(assets), destination_override=destination)
            try:
                await request.app.state.download_executor.create(execution_request_from_assets(job, assets))
            except Exception:
                cancel_job(job.job_id)
                raise
            return _read_job_snapshot(job.job_id) or job
        job = create_manual_job(payload)
        if payload.delivery_target == "local":
            await request.app.state.download_executor.create(execution_request_from_assets(job, execution_assets_from_manual_job(payload)))
        return job
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="无法创建本地下载文件") from exc


@app.get("/v1/jobs", response_model=list[ResourceJobSnapshot])
async def list_jobs() -> list[ResourceJobSnapshot]:
    return _read_jobs_snapshot()


@app.get("/v1/jobs/{job_id}", response_model=ResourceJobSnapshot)
async def read_job(job_id: str) -> ResourceJobSnapshot:
    job = _read_job_snapshot(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="下载任务不存在")
    return job


@app.post("/v1/jobs/{job_id}/pause", response_model=ResourceJobSnapshot)
async def pause_resource_job(job_id: str, request: Request) -> ResourceJobSnapshot:
    job = _read_job_snapshot(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="下载任务不存在")
    try:
        if job.execution_mode == "download_engine":
            if job.status in {"interrupted", "waiting_for_source"}:
                raise ValueError("下载当前不能暂停")
            await request.app.state.download_executor.pause(job_id)
            return _read_job_snapshot(job_id) or job
        paused = pause_job(job_id)
        if paused is None:
            raise HTTPException(status_code=404, detail="下载任务不存在")
        await request.app.state.download_executor.pause(job_id)
        return paused
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/v1/jobs/{job_id}/resume", response_model=ResourceJobSnapshot)
async def resume_resource_job(job_id: str, request: Request) -> ResourceJobSnapshot:
    job = _read_job_snapshot(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="下载任务不存在")
    try:
        if job.execution_mode == "download_engine":
            if job.status == "waiting_for_source":
                raise ValueError("当前下载地址不可继续，请使用一键续取")
            executor = request.app.state.download_executor
            status = await executor.status(job_id)
            service: RecoveryService | None = request.app.state.recovery_service
            if status is not None and service is not None and status.state == "failed":
                if job.status == "interrupted" and job.next_action == "continue_acquisition":
                    await executor.retry_same_source(job_id)
                    return _read_job_snapshot(job_id) or job
                execution_request = await executor.execution_request(job_id)
                asset = _active_execution_asset(execution_request, status.current_asset_id)
                decision = service.diagnosis_for(job_id, status, asset)
                if decision.action == "reacquire_source":
                    if decision.reason == "network_interrupted":
                        service.offer_alternative_source(job_id)
                        raise ValueError("当前连接仍不可用，可以继续重试或寻找其他来源")
                    service.mark_waiting_for_source(job_id, decision)
                    raise ValueError("当前下载地址不可继续，请使用一键续取")
                if decision.action == "fix_local_issue":
                    raise ValueError(status.error or "请先修复本地保存问题")
                if decision.action in {"retry_same_source", "resume_same_source"}:
                    service.note_same_source_retry(job_id, status)
                    await executor.retry_same_source(job_id)
                    return _read_job_snapshot(job_id) or job
            await executor.resume(job_id)
            return _read_job_snapshot(job_id) or job
        resumed = resume_job(job_id)
        if resumed is None:
            raise HTTPException(status_code=404, detail="下载任务不存在")
        await request.app.state.download_executor.resume(job_id)
        return resumed
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/v1/jobs/{job_id}/continue-acquisition", response_model=RecoveryHandoff)
async def continue_acquisition(job_id: str, request: Request) -> RecoveryHandoff:
    service: RecoveryService | None = request.app.state.recovery_service
    if service is None:
        raise HTTPException(status_code=409, detail="当前下载执行器不支持一键续取")
    job = _read_job_snapshot(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="下载任务不存在")
    browser_reacquisition = job.status == "interrupted" and job.next_action == "continue_acquisition"
    if job.status != "waiting_for_source" and not browser_reacquisition:
        raise HTTPException(status_code=409, detail="当前任务不需要寻找其他来源")
    try:
        return await service.continue_acquisition(
            job_id,
            browser_reacquisition=browser_reacquisition,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/v1/recovery/pending", response_model=list[PendingRecoveryView])
async def pending_recovery(request: Request) -> list[PendingRecoveryView]:
    service: RecoveryService | None = request.app.state.recovery_service
    return service.pending() if service is not None else []


@app.post("/v1/recovery/{recovery_id}/capture", response_model=RecoveryCaptureResult)
async def submit_recovery_capture(recovery_id: str, payload: RecoveryCaptureRequest, request: Request) -> RecoveryCaptureResult:
    service: RecoveryService | None = request.app.state.recovery_service
    if service is None:
        raise HTTPException(status_code=409, detail="当前下载执行器不支持重新智取")
    try:
        return await service.submit_capture(recovery_id, payload.capture)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/v1/recovery/{recovery_id}/candidates/{candidate_id}", response_model=RecoveryCandidateChoiceResult)
async def choose_recovery_candidate(recovery_id: str, candidate_id: str, request: Request) -> RecoveryCandidateChoiceResult:
    service: RecoveryService | None = request.app.state.recovery_service
    if service is None:
        raise HTTPException(status_code=409, detail="当前下载执行器不支持重新智取")
    try:
        return await service.choose_candidate(recovery_id, candidate_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/v1/jobs/{job_id}/cancel", status_code=204)
async def cancel_resource_job(job_id: str, request: Request) -> Response:
    job = _read_job_snapshot(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="下载任务不存在")
    await request.app.state.download_executor.cancel(job_id)
    if not cancel_job(job_id):
        raise HTTPException(status_code=404, detail="下载任务不存在")
    return Response(status_code=204)


@app.get("/v1/link-history", response_model=list[LinkHistoryItem])
@app.get("/v1/link-library", response_model=list[LinkHistoryItem])
async def read_link_library() -> list[LinkHistoryItem]:
    return list_link_history()


@app.post("/v1/link-library/favorites", response_model=LinkHistoryItem)
async def create_link_favorite(payload: LinkFavoriteCreateRequest) -> LinkHistoryItem:
    return create_favorite(payload)


@app.post("/v1/link-library/{history_id}/favorite", response_model=LinkHistoryItem)
async def update_link_favorite(history_id: str, payload: LinkFavoriteUpdateRequest) -> LinkHistoryItem:
    item = set_favorite(history_id, payload.favorite)
    if item is None:
        raise HTTPException(status_code=404, detail="Link library item not found")
    return item


def _uses_real_local_executor(request: Request, delivery_target: str) -> bool:
    return delivery_target == "local" and request.app.state.download_executor_mode == "http"


def _read_jobs_snapshot() -> list[ResourceJobSnapshot]:
    """Pure in-memory read; state progression belongs to the Runtime reconciler."""
    return list(job_store_module._jobs)


def _read_job_snapshot(job_id: str) -> ResourceJobSnapshot | None:
    index = job_store_module._find_index(job_id)
    return job_store_module._jobs[index] if index is not None else None


async def _reconcile_execution_loop(app: FastAPI) -> None:
    while True:
        for job in _read_jobs_snapshot():
            if job.execution_mode != "download_engine":
                continue
            try:
                await _reconcile_execution_job(app, job)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("download_reconcile_failed job_id=%s", job.job_id)
        await asyncio.sleep(0.5)


async def _reconcile_execution_job(app: FastAPI, job: ResourceJobSnapshot) -> None:
    # Once the user has been offered/entered reacquisition, the failed executor
    # remains intentionally frozen until an explicit user recovery action occurs.
    # Do not let its old failure facts overwrite the pending recovery UI state.
    if job.status == "waiting_for_source" or (
        job.status == "interrupted" and job.next_action == "continue_acquisition"
    ):
        return

    executor = app.state.download_executor
    status = await executor.status(job.job_id)
    if status is None:
        return
    project_execution_status(job.job_id, status)
    service: RecoveryService | None = app.state.recovery_service
    if service is None or status.state != "failed":
        return

    execution_request = await executor.execution_request(job.job_id)
    asset = _active_execution_asset(execution_request, status.current_asset_id)
    decision = service.diagnosis_for(job.job_id, status, asset)
    logger.info(
        "download_diagnosis job_id=%s failure_kind=%s http_status=%s action=%s reason=%s",
        job.job_id,
        status.failure_kind,
        status.http_status_code,
        decision.action,
        decision.reason,
    )

    live_transient = status.failure_kind == "connection_interrupted" or (
        status.failure_kind == "http_error"
        and status.http_status_code in {500, 502, 503, 504}
    )
    if live_transient and decision.action in {"retry_same_source", "resume_same_source"}:
        service.note_same_source_retry(job.job_id, status)
        logger.info(
            "download_same_source_retry job_id=%s failure_kind=%s http_status=%s",
            job.job_id,
            status.failure_kind,
            status.http_status_code,
        )
        try:
            await executor.retry_same_source(job.job_id)
        except ValueError:
            logger.warning("download_same_source_retry_rejected job_id=%s", job.job_id)
        return

    if decision.action == "reacquire_source":
        if decision.reason == "network_interrupted":
            service.offer_alternative_source(job.job_id)
        else:
            service.mark_waiting_for_source(job.job_id, decision)


def _active_execution_asset(execution_request, current_asset_id: str | None):
    if execution_request is None:
        return None
    if current_asset_id:
        for asset in execution_request.assets:
            if asset.asset_id == current_asset_id:
                return asset
    return next((asset for asset in execution_request.assets if not asset.completed), execution_request.assets[0] if execution_request.assets else None)


def _analysis_stream_error(exc: Exception) -> str:
    if isinstance(exc, ValueError) and not isinstance(exc, (ModelProviderTimeoutError, ModelProviderRequestError, ModelProviderResponseError)):
        return f"模型返回的 ResourcePlan 未通过确定性校验：{exc}"
    return str(exc)


TASK_CENTER_DIST = task_center_dist_path()
if TASK_CENTER_DIST.exists():
    app.mount("/app", StaticFiles(directory=TASK_CENTER_DIST, html=True), name="task-center")
else:
    @app.get("/app", include_in_schema=False, response_class=HTMLResponse)
    async def task_center_not_built() -> str:
        return """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>迅雷智取任务中心尚未构建</title><body style="font-family:system-ui;padding:40px;color:#293241"><h2>任务中心尚未构建</h2><p>请在仓库根目录运行 <code>corepack pnpm --filter @xunlei-zhiqu/task-center build</code>，然后重启 Runtime。</p><p>开发模式可直接访问 <code>http://127.0.0.1:5173/</code>。</p></body></html>"""


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    return RedirectResponse("/app" if TASK_CENTER_DIST.exists() else "/docs")
