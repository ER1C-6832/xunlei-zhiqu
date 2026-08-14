import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
import json
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from xunlei_zhiqu_runtime import __version__
from xunlei_zhiqu_runtime.config import get_settings
from xunlei_zhiqu_runtime.models import (
    CaptureBatch,
    HealthResponse,
    LinkFavoriteCreateRequest,
    LinkFavoriteUpdateRequest,
    LinkHistoryItem,
    ManualJobCreateRequest,
    ResourceJobCreateRequest,
    ResourceJobSnapshot,
    ResourcePlan,
)
from xunlei_zhiqu_runtime.providers.base import (
    ModelProviderRequestError,
    ModelProviderResponseError,
    ModelProviderTimeoutError,
)
from xunlei_zhiqu_runtime.providers.factory import create_provider
from xunlei_zhiqu_runtime.services.analyzer import CaptureAnalyzer
from xunlei_zhiqu_runtime.services.client_session import create_client_session_auth
from xunlei_zhiqu_runtime.services.confirmation import compile_confirmed_request
from xunlei_zhiqu_runtime.services.download_executor import (
    NoopDownloadExecutor,
    execution_assets_from_manual_job,
    execution_assets_from_resource_job,
    execution_expected_total_bytes,
    execution_request_from_assets,
    execution_source_count,
)
from xunlei_zhiqu_runtime.services.http_download_executor import HttpDownloadExecutor
from xunlei_zhiqu_runtime.services.job_store import (
    cancel_job,
    create_favorite,
    create_job,
    create_manual_job,
    get_job,
    list_jobs as list_stored_jobs,
    list_link_history,
    pause_job,
    project_execution_status,
    resume_job,
    set_favorite,
)
from xunlei_zhiqu_runtime.services.plan_cache import ResourcePlanCache


logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    provider = create_provider(settings)
    session_token = (
        settings.runtime_static_session_token.get_secret_value()
        if settings.runtime_static_session_token is not None
        else None
    )
    download_executor = (
        HttpDownloadExecutor(settings.download_directory_path)
        if settings.download_executor == "http"
        else NoopDownloadExecutor()
    )
    app.state.settings = settings
    app.state.provider = provider
    app.state.client_session_auth = create_client_session_auth(
        settings.runtime_auth_mode,
        session_token,
    )
    app.state.download_executor = download_executor
    app.state.download_executor_mode = settings.download_executor
    app.state.plan_cache = ResourcePlanCache(
        ttl_seconds=settings.plan_cache_ttl_seconds,
        max_entries=settings.plan_cache_max_entries,
    )
    app.state.analyzer = CaptureAnalyzer(provider, cache=app.state.plan_cache)
    try:
        yield
    finally:
        await download_executor.aclose()
        await provider.aclose()


_boot_settings = get_settings()
app = FastAPI(
    title="迅雷智取 Runtime",
    version=__version__,
    description="单编排器、双智能节点、确定性执行的本地 Runtime。",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_boot_settings.cors_origins,
    allow_origin_regex=r"chrome-extension://.*",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Zhiqu-Session"],
)


@app.middleware("http")
async def runtime_client_session_boundary(request: Request, call_next):
    protected = (
        request.method != "OPTIONS"
        and request.url.path.startswith("/v1/")
        and request.url.path != "/v1/health"
    )
    if protected:
        session = request.app.state.client_session_auth.authenticate(
            request.headers.get("X-Zhiqu-Session")
        )
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
    except ModelProviderRequestError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ModelProviderResponseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"模型返回的 ResourcePlan 未通过确定性校验：{exc}",
        ) from exc


@app.post("/v1/capture/analyze-stream", response_class=StreamingResponse)
async def analyze_capture_stream(
    batch: CaptureBatch,
    request: Request,
    refresh: bool = False,
) -> StreamingResponse:
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
                plan = await analyzer.analyze(
                    batch,
                    force_refresh=refresh,
                    phase_sink=phase_sink,
                )
                await queue.put({"type": "phase", "phase": "done"})
                await queue.put(
                    {
                        "type": "result",
                        "plan": plan.model_dump(mode="json"),
                        "cache_hit": cache_hit,
                    }
                )
            except (
                ModelProviderTimeoutError,
                ModelProviderRequestError,
                ModelProviderResponseError,
                ValueError,
            ) as exc:
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

    return StreamingResponse(
        stream_events(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/v1/jobs", response_model=ResourceJobSnapshot)
async def create_resource_job(payload: ResourceJobCreateRequest, request: Request) -> ResourceJobSnapshot:
    try:
        compiled = compile_confirmed_request(payload)
        if _uses_real_local_executor(request, compiled.delivery_target):
            assets = execution_assets_from_resource_job(compiled)
            request.app.state.download_executor.validate_assets(assets)
            destination = str(request.app.state.settings.download_directory_path.expanduser().resolve())
            job = create_job(
                compiled,
                execution_mode="download_engine",
                total_bytes_override=execution_expected_total_bytes(assets),
                source_count_override=execution_source_count(assets),
                destination_override=destination,
            )
            try:
                await request.app.state.download_executor.create(
                    execution_request_from_assets(job, assets)
                )
            except Exception:
                cancel_job(job.job_id)
                raise
            return await _refresh_execution_job(request, job)

        job = create_job(compiled)
        if compiled.delivery_target == "local":
            await request.app.state.download_executor.create(
                execution_request_from_assets(job, execution_assets_from_resource_job(compiled))
            )
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
            job = create_manual_job(
                payload,
                execution_mode="download_engine",
                total_bytes_override=execution_expected_total_bytes(assets),
                source_count_override=execution_source_count(assets),
                destination_override=destination,
            )
            try:
                await request.app.state.download_executor.create(
                    execution_request_from_assets(job, assets)
                )
            except Exception:
                cancel_job(job.job_id)
                raise
            return await _refresh_execution_job(request, job)

        job = create_manual_job(payload)
        if payload.delivery_target == "local":
            await request.app.state.download_executor.create(
                execution_request_from_assets(job, execution_assets_from_manual_job(payload))
            )
        return job
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="无法创建本地下载文件") from exc


@app.get("/v1/jobs", response_model=list[ResourceJobSnapshot])
async def list_jobs(request: Request) -> list[ResourceJobSnapshot]:
    jobs = list_stored_jobs()
    return [await _refresh_execution_job(request, job) for job in jobs]


@app.get("/v1/jobs/{job_id}", response_model=ResourceJobSnapshot)
async def read_job(job_id: str, request: Request) -> ResourceJobSnapshot:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="ResourceJob not found")
    return await _refresh_execution_job(request, job)


@app.post("/v1/jobs/{job_id}/pause", response_model=ResourceJobSnapshot)
async def pause_resource_job(job_id: str, request: Request) -> ResourceJobSnapshot:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="ResourceJob not found")
    try:
        if job.execution_mode == "download_engine":
            await request.app.state.download_executor.pause(job_id)
            return await _refresh_execution_job(request, job)
        paused = pause_job(job_id)
        if paused is None:
            raise HTTPException(status_code=404, detail="ResourceJob not found")
        await request.app.state.download_executor.pause(job_id)
        return paused
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/v1/jobs/{job_id}/resume", response_model=ResourceJobSnapshot)
async def resume_resource_job(job_id: str, request: Request) -> ResourceJobSnapshot:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="ResourceJob not found")
    try:
        if job.execution_mode == "download_engine":
            await request.app.state.download_executor.resume(job_id)
            return await _refresh_execution_job(request, job)
        resumed = resume_job(job_id)
        if resumed is None:
            raise HTTPException(status_code=404, detail="ResourceJob not found")
        await request.app.state.download_executor.resume(job_id)
        return resumed
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/v1/jobs/{job_id}/cancel", status_code=204)
async def cancel_resource_job(job_id: str, request: Request) -> Response:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="ResourceJob not found")
    await request.app.state.download_executor.cancel(job_id)
    if not cancel_job(job_id):
        raise HTTPException(status_code=404, detail="ResourceJob not found")
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


async def _refresh_execution_job(request: Request, job: ResourceJobSnapshot) -> ResourceJobSnapshot:
    if job.execution_mode != "download_engine":
        return job
    status = await request.app.state.download_executor.status(job.job_id)
    if status is None:
        return job
    return project_execution_status(job.job_id, status) or job


def _analysis_stream_error(exc: Exception) -> str:
    if isinstance(exc, ValueError) and not isinstance(
        exc,
        (ModelProviderTimeoutError, ModelProviderRequestError, ModelProviderResponseError),
    ):
        return f"模型返回的 ResourcePlan 未通过确定性校验：{exc}"
    return str(exc)


PROJECT_ROOT = Path(__file__).resolve().parents[4]
TASK_CENTER_DIST = PROJECT_ROOT / "apps" / "task-center" / "dist"
if TASK_CENTER_DIST.exists():
    app.mount("/app", StaticFiles(directory=TASK_CENTER_DIST, html=True), name="task-center")
else:
    @app.get("/app", include_in_schema=False, response_class=HTMLResponse)
    async def task_center_not_built() -> str:
        return """
        <!doctype html>
        <html lang="zh-CN">
          <meta charset="utf-8">
          <title>迅雷智取任务中心尚未构建</title>
          <body style="font-family:system-ui;padding:40px;color:#293241">
            <h2>任务中心尚未构建</h2>
            <p>请在仓库根目录运行 <code>corepack pnpm --filter @xunlei-zhiqu/task-center build</code>，然后重启 Runtime。</p>
            <p>开发模式可直接访问 <code>http://127.0.0.1:5173/</code>。</p>
          </body>
        </html>
        """


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    return RedirectResponse("/app" if TASK_CENTER_DIST.exists() else "/docs")
