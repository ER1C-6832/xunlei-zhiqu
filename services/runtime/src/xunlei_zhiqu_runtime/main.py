from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from xunlei_zhiqu_runtime import __version__
from xunlei_zhiqu_runtime.config import get_settings
from xunlei_zhiqu_runtime.models import CaptureBatch, HealthResponse, ResourceJobSnapshot, ResourcePlan
from xunlei_zhiqu_runtime.providers.factory import create_provider
from xunlei_zhiqu_runtime.services.analyzer import CaptureAnalyzer
from xunlei_zhiqu_runtime.services.jobs import fixture_jobs
from xunlei_zhiqu_runtime.services.job_store import create_job, list_created_jobs


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    provider = create_provider(settings)
    app.state.settings = settings
    app.state.provider = provider
    app.state.analyzer = CaptureAnalyzer(provider)
    yield
    await provider.aclose()


app = FastAPI(
    title="迅雷智取 Runtime",
    version=__version__,
    description="单编排器、双智能节点、确定性执行的本地 Runtime 骨架。",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:8765", "http://localhost:8765"],
    allow_origin_regex=r"chrome-extension://.*",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.get("/v1/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    return HealthResponse(provider=request.app.state.provider.name)


@app.post("/v1/capture/analyze", response_model=ResourcePlan)
async def analyze_capture(batch: CaptureBatch, request: Request) -> ResourcePlan:
    return await request.app.state.analyzer.analyze(batch)


@app.post("/v1/jobs", response_model=ResourceJobSnapshot)
async def create_resource_job(payload: dict) -> ResourceJobSnapshot:
    plan = payload.get("plan", {})
    title = plan.get("resource_title", "未命名资源")
    subtitle = plan.get("overview", "节点 A 资源计划")
    return create_job(title, subtitle, plan.get("plan_id", "unknown"), payload.get("destination"))


@app.get("/v1/jobs", response_model=list[ResourceJobSnapshot])
async def list_jobs() -> list[ResourceJobSnapshot]:
    return list_created_jobs() + fixture_jobs()


PROJECT_ROOT = Path(__file__).resolve().parents[4]
TASK_CENTER_DIST = PROJECT_ROOT / "apps" / "task-center" / "dist"
if TASK_CENTER_DIST.exists():
    app.mount("/app", StaticFiles(directory=TASK_CENTER_DIST, html=True), name="task-center")
else:
    @app.get("/app", include_in_schema=False, response_class=HTMLResponse)
    async def task_center_not_built() -> str:
        return "<h2>任务中心尚未构建</h2><p>请先执行 task-center build。</p>"


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    return RedirectResponse("/app" if TASK_CENTER_DIST.exists() else "/docs")
