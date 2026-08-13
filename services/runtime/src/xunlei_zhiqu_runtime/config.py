from functools import lru_cache
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "迅雷智取 Runtime"
    model_provider: Literal["fixture", "openai_compatible"] = "openai_compatible"
    enable_fixture_provider: bool = False
    model_base_url: str = "https://api.openai.com/v1"
    model_name: str = "gpt-4.1-mini"
    model_api_key: SecretStr | None = None
    model_connect_timeout_seconds: float = 10.0
    model_read_timeout_seconds: float = 120.0
    model_write_timeout_seconds: float = 30.0
    # Stage D6 A/B profiles: quality is the correctness baseline; fast is the
    # original latency baseline; wire/wire2 are the proven cost lineage.
    # latency keeps the proven wire2 protocol but swaps only the model so model
    # decode/service latency can be measured independently. wire3/compact are
    # retained only so failed experiments remain reproducible.
    model_max_completion_tokens: int = 4096
    node_a_profile: Literal[
        "quality",
        "fast",
        "compact",
        "wire",
        "wire2",
        "wire3",
        "latency",
    ] = "quality"
    node_a_latency_model: str = "qwen3.6-flash"
    plan_cache_ttl_seconds: float = 1200.0
    plan_cache_max_entries: int = 64
    runtime_host: str = "127.0.0.1"
    runtime_port: int = 8765
    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
