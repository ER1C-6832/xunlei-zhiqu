import logging

from xunlei_zhiqu_runtime.config import Settings
from xunlei_zhiqu_runtime.providers import openai_compatible
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter
from xunlei_zhiqu_runtime.providers.fixture import FixtureProvider
from xunlei_zhiqu_runtime.providers.openai_compatible import OpenAICompatibleProvider


logger = logging.getLogger("uvicorn.error")

_BASE_SYSTEM_PROMPT = openai_compatible.SYSTEM_PROMPT
_BASE_OUTPUT_CONTRACT = openai_compatible.OUTPUT_CONTRACT
_BASE_PROMPT_VERSION = openai_compatible.PROMPT_VERSION

# Fast is a separate compact prompt, not a suffix appended to the quality prompt.
# It deliberately keeps all evidence and all deterministic correctness constraints.
_FAST_SYSTEM_PROMPT = """你是“迅雷智取”节点 A。把 EvidencePack 整理成简洁 ResourcePlan，只依据已有证据，不猜隐藏意图，不编造 URL、版本、平台、架构、大小、清晰度或 candidate id。

先选主资源，再处理其他平台/格式/版本和附件。设备信息可用于默认兼容推荐，但用户最终可修改。

必须遵守：
- 只能引用 EvidencePack 中已有 candidate id；group evidence 的 candidate_ids 中每个 ID 都可引用。
- 若存在匹配 device.os/device.arch 的主资源，selected 至少包含一个匹配项；不得只选其他系统、源码或验证附件。
- 签名、checksum、GPG、SBOM、Sigstore 等只能作为附件；存在主资源时不能成为唯一 selected。
- 软件存在当前设备可直接使用的安装包/压缩包时，源码放 alternatives。
- resource_family_hint 只是提示；ambiguous=true 时结合文件名、上下文、MIME、技术元数据判断。
- ResourcePlan 只是建议，不是用户最终决定。

输出要短：
- selected 通常 1 个，确有必要最多 2 个。
- alternatives 最多 3 个逻辑组；同用途候选用一个 PlanItem.candidate_ids[] 聚合。
- excluded 最多 1 组；uncertainties 最多 1 组；recommendations 最多 1 条。
- overview 1~2 句；label 短；plain_explanation 只说“是什么/适合谁”；reason 只说最关键依据。
- 不在多个字段重复文件名、设备、版本、candidate id；technical_attributes 只留影响选择的属性；evidence_refs 没必要就空数组。
- 泛化不确定性写 overview，不要创建 candidate_ids=[] 的 PlanItem。

所有 PlanItem 至少引用 1 个真实 candidate_id；technical_attributes 必须是 JSON object；candidate_ids/evidence_refs/recommendation.item_ids 必须是数组。只输出一个 JSON 对象，不要 Markdown。"""

_FAST_OUTPUT_CONTRACT = {
    "resource_type": "enum",
    "resource_title": "string",
    "overview": "string",
    "selected": "PlanItem[]",
    "alternatives": "PlanItem[]",
    "excluded": "PlanItem[]",
    "uncertainties": "PlanItem[]",
    "recommendations": "Recommendation[]",
    "PlanItem": {
        "item_id": "string",
        "candidate_ids": ["existing id"],
        "label": "string",
        "plain_explanation": "string",
        "reason": "string",
        "role": "primary|attachment|alternative|excluded|unknown",
        "technical_attributes": {},
        "evidence_refs": [],
    },
    "Recommendation": {
        "scenario": "current_device|compatibility|quality|small_size|manual",
        "item_ids": ["existing item_id"],
        "summary": "string",
    },
}

# Compact v1 isolates prompt-size optimization from evidence reduction and output budget.
# It uses the exact same EvidencePack and 1536-token ceiling as fast-v2, but removes
# repeated prose and keeps only the correctness constraints needed by deterministic validation.
_COMPACT_SYSTEM_PROMPT = """你是“迅雷智取”节点A。仅据 EvidencePack 输出简洁 ResourcePlan；不猜意图，不编造事实或 ID。
硬约束：
1. 只能引用已有 candidate id；每个 PlanItem 至少 1 个 candidate_id。
2. 若有匹配 device.os/device.arch 的主资源，selected 必须含匹配项；不能只选其他系统、源码或验证附件。
3. 签名/checksum/GPG/SBOM/Sigstore 是附件；有主资源时不得作为唯一 selected。当前设备有可用安装包/压缩包时，源码放 alternatives。
4. resource_family_hint 仅是提示，ambiguous=true 时结合文件名、上下文、MIME、metadata。
5. selected 通常 1 项最多 2；alternatives 最多 3 组；excluded/uncertainties/recommendations 各最多 1。相同用途用 candidate_ids 聚合。
6. 文字短：overview 1~2句；说明只写“是什么/适合谁”；reason 只写关键依据；避免重复设备、版本、文件名。泛化不确定性写 overview。
7. technical_attributes 为 JSON object；candidate_ids/evidence_refs/item_ids 为数组。只输出 JSON。
resource_type: software|document|video|audio|image|subtitle|model|design|archive|disk_image|mixed|unknown。
role: primary|attachment|alternative|excluded|unknown。scenario: current_device|compatibility|quality|small_size|manual。"""

_COMPACT_OUTPUT_CONTRACT = {
    "resource_type": "enum",
    "resource_title": "s",
    "overview": "s",
    "selected": "items",
    "alternatives": "items",
    "excluded": "items",
    "uncertainties": "items",
    "recommendations": "recs",
    "item_fields": "item_id,candidate_ids,label,plain_explanation,reason,role,technical_attributes,evidence_refs",
    "rec_fields": "scenario,item_ids,summary",
}


def create_provider(settings: Settings) -> ModelProviderAdapter:
    if settings.model_provider == "fixture":
        if not settings.enable_fixture_provider:
            raise ValueError(
                "FixtureProvider is development-only; set ENABLE_FIXTURE_PROVIDER=true explicitly"
            )
        return FixtureProvider()
    if settings.model_provider == "openai_compatible":
        key = settings.model_api_key.get_secret_value() if settings.model_api_key else ""

        if settings.node_a_profile == "fast":
            openai_compatible.SYSTEM_PROMPT = _FAST_SYSTEM_PROMPT
            openai_compatible.OUTPUT_CONTRACT = _FAST_OUTPUT_CONTRACT
            openai_compatible.PROMPT_VERSION = "stage-d6-fast-v2"
            max_completion_tokens = min(settings.model_max_completion_tokens, 1536)
        elif settings.node_a_profile == "compact":
            openai_compatible.SYSTEM_PROMPT = _COMPACT_SYSTEM_PROMPT
            openai_compatible.OUTPUT_CONTRACT = _COMPACT_OUTPUT_CONTRACT
            openai_compatible.PROMPT_VERSION = "stage-d6-compact-v1"
            # Same ceiling as fast-v2 so this A/B isolates prompt-size changes.
            max_completion_tokens = min(settings.model_max_completion_tokens, 1536)
        else:
            # Preserve the proven quality baseline byte-for-byte.
            openai_compatible.SYSTEM_PROMPT = _BASE_SYSTEM_PROMPT
            openai_compatible.OUTPUT_CONTRACT = _BASE_OUTPUT_CONTRACT
            openai_compatible.PROMPT_VERSION = _BASE_PROMPT_VERSION
            max_completion_tokens = settings.model_max_completion_tokens

        logger.info(
            "node_a_profile profile=%s prompt_version=%s max_completion_tokens=%d",
            settings.node_a_profile,
            openai_compatible.PROMPT_VERSION,
            max_completion_tokens,
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
