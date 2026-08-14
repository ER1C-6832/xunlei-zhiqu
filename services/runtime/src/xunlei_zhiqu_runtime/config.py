from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "迅雷智取 Runtime"
    # Supplier/API dialect is independent from Node-A prompt/transport profile.
    model_provider: Literal[
        "fixture",
        "openai",
        "dashscope",
        "openai_compatible",
    ] = "openai_compatible"
    enable_fixture_provider: bool = False
    model_base_url: str = "https://api.openai.com/v1"
    model_name: str = "gpt-4.1-mini"
    model_api_key: SecretStr | None = None
    model_connect_timeout_seconds: float = 10.0
    model_read_timeout_seconds: float = 120.0
    model_write_timeout_seconds: float = 30.0
    model_max_completion_tokens: int = 4096
    # E0.10: stream internally to measure TTFT/generation. The validated
    # ResourcePlan remains the only product output.
    model_stream_diagnostics: bool = False
    # E0 Wave B found no stable HTTP/2 benefit on the tested DashScope/proxy path.
    # Keep false by default and re-benchmark per deployment path.
    model_http2_enabled: bool = False

    # Node-A protocol profiles are our own A/B surface. They must not select a
    # supplier or model. `pipeline_v3` is the Wave B recommendation for the
    # tested DashScope + deepseek-v4-flash path; `pipeline` remains its v2
    # rollback profile. The generic default stays `quality` so an unbenchmarked
    # provider/model does not silently inherit a provider-specific conclusion.
    node_a_profile: Literal[
        "quality",
        "fast",
        "wire",
        "wire2",
        "pipeline",
        "pipeline_v3",
    ] = "quality"

    plan_cache_ttl_seconds: float = 1200.0
    plan_cache_max_entries: int = 64

    # Stage E: real local HTTP execution is the product default. `noop` remains
    # available only as an executor fixture/fallback; it does not enable UI jobs.
    download_executor: Literal["http", "noop"] = "http"
    download_directory: str = ""
    # Stage-B task fixtures are a separate, explicit UI-development switch.
    task_fixtures_enabled: bool = False

    runtime_host: str = "127.0.0.1"
    runtime_port: int = 8765
    runtime_cors_origins: str = (
        "http://127.0.0.1:5173,http://localhost:5173,"
        "http://127.0.0.1:8765,http://localhost:8765"
    )
    runtime_auth_mode: Literal["off", "static_token"] = "off"
    runtime_static_session_token: SecretStr | None = None
    log_level: str = "INFO"

    @property
    def cors_origins(self) -> list[str]:
        return [
            origin.strip().rstrip("/")
            for origin in self.runtime_cors_origins.split(",")
            if origin.strip()
        ]

    @property
    def download_directory_path(self) -> Path:
        configured = self.download_directory.strip()
        if configured:
            return Path(configured).expanduser()
        return Path.home() / "Downloads" / "迅雷智取"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
