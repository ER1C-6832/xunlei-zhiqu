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
    model_timeout_seconds: float = 30.0
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
