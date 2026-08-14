import logging

from xunlei_zhiqu_runtime.config import Settings
from xunlei_zhiqu_runtime.providers.adapters.factory import create_api_adapter
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter
from xunlei_zhiqu_runtime.providers.evidence_wire import EvidenceWireProvider
from xunlei_zhiqu_runtime.providers.fixture import FixtureProvider
from xunlei_zhiqu_runtime.providers.node_a_profiles import build_node_a_profile
from xunlei_zhiqu_runtime.providers.runtime_structured import RuntimeStructuredChatProvider


logger = logging.getLogger("uvicorn.error")


def create_provider(settings: Settings) -> ModelProviderAdapter:
    if settings.model_provider == "fixture":
        if not settings.enable_fixture_provider:
            raise ValueError(
                "FixtureProvider is development-only; set ENABLE_FIXTURE_PROVIDER=true explicitly"
            )
        return FixtureProvider()

    profile = build_node_a_profile(
        profile=settings.node_a_profile,
        max_completion_tokens=settings.model_max_completion_tokens,
    )
    api_adapter = create_api_adapter(
        provider=settings.model_provider,
        base_url=settings.model_base_url,
    )
    key = settings.model_api_key.get_secret_value() if settings.model_api_key else ""

    logger.info(
        "node_a_profile profile=%s prompt_version=%s api_provider=%s model=%s "
        "max_completion_tokens=%d stream_diagnostics=%s http2_enabled=%s",
        profile.name,
        profile.prompt_version,
        api_adapter.name,
        settings.model_name,
        profile.max_completion_tokens,
        str(settings.model_stream_diagnostics).lower(),
        str(settings.model_http2_enabled).lower(),
    )

    provider: ModelProviderAdapter = RuntimeStructuredChatProvider(
        api_adapter=api_adapter,
        base_url=settings.model_base_url,
        api_key=key,
        model=settings.model_name,
        connect_timeout_seconds=settings.model_connect_timeout_seconds,
        read_timeout_seconds=settings.model_read_timeout_seconds,
        write_timeout_seconds=settings.model_write_timeout_seconds,
        max_completion_tokens=profile.max_completion_tokens,
        system_prompt=profile.system_prompt,
        output_contract=profile.output_contract,
        prompt_version=profile.prompt_version,
        normalizer=profile.normalizer,
        request_builder=profile.request_builder,
        stream_diagnostics=settings.model_stream_diagnostics,
        http2_enabled=settings.model_http2_enabled,
    )
    return EvidenceWireProvider(provider) if profile.use_evidence_wire else provider
