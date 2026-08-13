from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
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
from xunlei_zhiqu_runtime.services.confirmation import compile_confirmed_request
from xunlei_zhiqu_runtime.services.job_store import (
    create_favorite,
    create_job,
    create_manual_job,
    get_job,
    list_jobs as list_stored_jobs,
    list_link_history,
    pause_job,
    resume_job,
    set_favorite,
)
from xunlei_zhiqu_runtime.services.plan_cache import ResourcePlanCache


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    provider = create_provider(settings)
    app.state.settings = settings
    app.state.provider = provider
    app.state.plan_cache = ResourcePlanCache(
        ttl_seconds=settings.plan_cache_ttl_seconds,
        max_entries=settings.plan_cache_max_entries,
    )
    app.state.analyzer = CaptureAnalyzer(provider, cache=app.state.plan_cache)
    yield
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
    allow_headers=["Content-Type"],
)


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


@app.post("/v1/jobs", response_model=ResourceJobSnapshot)
async def create_resource_job(payload: ResourceJobCreateRequest) -> ResourceJobSnapshot:
    try:
        return create_job(compile_confirmed_request(payload))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/v1/jobs/manual", response_model=ResourceJobSnapshot)
async def create_manual_resource_job(payload: ManualJobCreateRequest) -> ResourceJobSnapshot:
    try:
        return create_manual_job(payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/v1/jobs", response_model=list[ResourceJobSnapshot])
async def list_jobs() -> list[ResourceJobSnapshot]:
    return list_stored_jobs()


@app.get("/v1/jobs/{job_id}", response_model=ResourceJobSnapshot)
async def read_job(job_id: str) -> ResourceJobSnapshot:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="ResourceJob not found")
    return job


@app.post("/v1/jobs/{job_id}/pause", response_model=ResourceJobSnapshot)
async def pause_resource_job(job_id: str) -> ResourceJobSnapshot:
    try:
        job = pause_job(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if job is None:
        raise HTTPException(status_code=404, detail="ResourceJob not found")
    return job


@app.post("/v1/jobs/{job_id}/resume", response_model=ResourceJobSnapshot)
async def resume_resource_job(job_id: str) -> ResourceJobSnapshot:
    try:
        job = resume_job(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if job is None:
        raise HTTPException(status_code=404, detail="ResourceJob not found")
    return job


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
