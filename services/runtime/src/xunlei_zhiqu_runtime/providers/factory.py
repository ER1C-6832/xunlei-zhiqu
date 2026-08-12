from xunlei_zhiqu_runtime.config import Settings
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter
from xunlei_zhiqu_runtime.providers.fixture import FixtureProvider
from xunlei_zhiqu_runtime.providers.openai_compatible import OpenAICompatibleProvider


def create_provider(settings: Settings) -> ModelProviderAdapter:
    if settings.model_provider == "fixture":
        if not settings.enable_fixture_provider:
            raise ValueError(
                "FixtureProvider is development-only; set ENABLE_FIXTURE_PROVIDER=true explicitly"
            )
        return FixtureProvider()
    if settings.model_provider == "openai_compatible":
        key = settings.model_api_key.get_secret_value() if settings.model_api_key else ""
        return OpenAICompatibleProvider(
            base_url=settings.model_base_url,
            api_key=key,
            model=settings.model_name,
            connect_timeout_seconds=settings.model_connect_timeout_seconds,
            read_timeout_seconds=settings.model_read_timeout_seconds,
            write_timeout_seconds=settings.model_write_timeout_seconds,
        )
    raise ValueError(f"Unsupported MODEL_PROVIDER: {settings.model_provider}")
