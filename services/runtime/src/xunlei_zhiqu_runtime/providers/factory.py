from xunlei_zhiqu_runtime.config import Settings
from xunlei_zhiqu_runtime.providers import openai_compatible
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter
from xunlei_zhiqu_runtime.providers.fixture import FixtureProvider
from xunlei_zhiqu_runtime.providers.openai_compatible import OpenAICompatibleProvider


_BASE_SYSTEM_PROMPT = openai_compatible.SYSTEM_PROMPT
_FAST_PROFILE_SUFFIX = """

快速实验档（准确性规则优先于精简规则）：
- 保持上面的当前设备、主资源、附件和真实 candidate_id 约束不变；如果精简会损害这些约束，宁可多输出。
- selected 尽量 1~2 个；alternatives 尽量不超过 4 个逻辑组；excluded 不超过 2 个；uncertainties 不超过 2 个；recommendations 不超过 3 个。
- overview 尽量控制在 120 个中文字符以内；label 尽量不超过 28 个字符；plain_explanation 尽量不超过 80 个中文字符；reason 尽量不超过 50 个中文字符；recommendation.summary 尽量不超过 60 个中文字符。
- 不在多个字段重复相同文件名、设备信息、版本号或 candidate id；technical_attributes 只保留真正影响用户选择的少量属性。
- 相同用途的其他平台、其他架构、源码、校验附件优先按逻辑组概括，不要逐文件复述。
"""


def create_provider(settings: Settings) -> ModelProviderAdapter:
    if settings.model_provider == "fixture":
        if not settings.enable_fixture_provider:
            raise ValueError(
                "FixtureProvider is development-only; set ENABLE_FIXTURE_PROVIDER=true explicitly"
            )
        return FixtureProvider()
    if settings.model_provider == "openai_compatible":
        key = settings.model_api_key.get_secret_value() if settings.model_api_key else ""
        fast_profile = settings.node_a_profile == "fast"
        # The quality profile remains byte-for-byte the existing Stage D6 prompt.
        # Fast is opt-in and only tightens presentation/output budgets; it does not
        # add more aggressive candidate grouping or remove evidence before Node A.
        openai_compatible.SYSTEM_PROMPT = (
            f"{_BASE_SYSTEM_PROMPT}{_FAST_PROFILE_SUFFIX}"
            if fast_profile
            else _BASE_SYSTEM_PROMPT
        )
        max_completion_tokens = (
            min(settings.model_max_completion_tokens, 2304)
            if fast_profile
            else settings.model_max_completion_tokens
        )
        return OpenAICompatibleProvider(
            base_url=settings.model_base_url,
            api_key=key,
            model=settings.model_name,
            connect_timeout_seconds=settings.model_connect_timeout_seconds,
            read_timeout_seconds=settings.model_read_timeout_seconds,
            write_timeout_seconds=settings.model_write_timeout_seconds,
            max_completion_tokens=max_completion_tokens,
        )
    raise ValueError(f"Unsupported MODEL_PROVIDER: {settings.model_provider}")
