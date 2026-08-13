from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import json

from xunlei_zhiqu_runtime.models import EvidencePack
from xunlei_zhiqu_runtime.providers import openai_compatible
from xunlei_zhiqu_runtime.providers.output_wire import (
    WIRE2_OUTPUT_CONTRACT,
    WIRE2_SYSTEM_SUFFIX,
    expand_compact_resource_plan,
)
from xunlei_zhiqu_runtime.providers.pipeline_v3 import (
    PIPELINE_V3_OUTPUT_CONTRACT,
    PIPELINE_V3_SYSTEM_SUFFIX,
    build_pipeline_v3_request,
    expand_pipeline_v3_resource_plan,
)
from xunlei_zhiqu_runtime.providers.pipeline_wire import (
    PIPELINE_OUTPUT_CONTRACT,
    PIPELINE_SYSTEM_SUFFIX,
    build_pipeline_request,
)


PlanNormalizer = Callable[[dict[str, object]], dict[str, int]]
RequestBuilder = Callable[[EvidencePack], object]


@dataclass(frozen=True, slots=True)
class NodeAProfileSpec:
    name: str
    system_prompt: str
    output_contract: dict[str, object]
    prompt_version: str
    normalizer: PlanNormalizer
    request_builder: RequestBuilder | None
    max_completion_tokens: int
    use_evidence_wire: bool


_BASE_SYSTEM_PROMPT = openai_compatible.SYSTEM_PROMPT
_BASE_OUTPUT_CONTRACT = openai_compatible.OUTPUT_CONTRACT
_BASE_PROMPT_VERSION = openai_compatible.PROMPT_VERSION
_BASE_NORMALIZER = openai_compatible._normalize_model_resource_plan

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

_FAST_OUTPUT_CONTRACT: dict[str, object] = {
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


def _wire2_normalizer(parsed: dict[str, object]) -> dict[str, int]:
    expand_compact_resource_plan(parsed)
    return _BASE_NORMALIZER(parsed)


def _pipeline_v3_normalizer(parsed: dict[str, object]) -> dict[str, int]:
    stats = expand_pipeline_v3_resource_plan(parsed)
    base_stats = _BASE_NORMALIZER(parsed)
    for key, value in base_stats.items():
        stats[key] = stats.get(key, 0) + value
    return stats


def build_node_a_profile(*, profile: str, max_completion_tokens: int) -> NodeAProfileSpec:
    """Build our Node-A protocol independently from supplier/model selection."""
    if profile == "quality":
        return NodeAProfileSpec(
            name=profile,
            system_prompt=_BASE_SYSTEM_PROMPT,
            output_contract=_BASE_OUTPUT_CONTRACT,
            prompt_version=_BASE_PROMPT_VERSION,
            normalizer=_BASE_NORMALIZER,
            request_builder=None,
            max_completion_tokens=max_completion_tokens,
            use_evidence_wire=False,
        )

    bounded_tokens = min(max_completion_tokens, 1536)
    if profile == "fast":
        return NodeAProfileSpec(
            name=profile,
            system_prompt=_FAST_SYSTEM_PROMPT,
            output_contract=_FAST_OUTPUT_CONTRACT,
            prompt_version="stage-d6-fast-v2",
            normalizer=_BASE_NORMALIZER,
            request_builder=None,
            max_completion_tokens=bounded_tokens,
            use_evidence_wire=False,
        )
    if profile == "wire":
        return NodeAProfileSpec(
            name=profile,
            system_prompt=_FAST_SYSTEM_PROMPT,
            output_contract=_FAST_OUTPUT_CONTRACT,
            prompt_version="stage-d6-wire-v1",
            normalizer=_BASE_NORMALIZER,
            request_builder=None,
            max_completion_tokens=bounded_tokens,
            use_evidence_wire=True,
        )
    if profile == "wire2":
        return NodeAProfileSpec(
            name=profile,
            system_prompt=f"{_FAST_SYSTEM_PROMPT}{WIRE2_SYSTEM_SUFFIX}",
            output_contract=WIRE2_OUTPUT_CONTRACT,
            prompt_version="stage-d6-wire2-v1",
            normalizer=_wire2_normalizer,
            request_builder=None,
            max_completion_tokens=bounded_tokens,
            use_evidence_wire=True,
        )
    if profile == "pipeline":
        compact_contract = json.dumps(
            PIPELINE_OUTPUT_CONTRACT,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return NodeAProfileSpec(
            name=profile,
            system_prompt=f"{_FAST_SYSTEM_PROMPT}{PIPELINE_SYSTEM_SUFFIX}\noutput_contract={compact_contract}",
            output_contract=PIPELINE_OUTPUT_CONTRACT,
            prompt_version="stage-d6-pipeline-v2",
            normalizer=_wire2_normalizer,
            request_builder=build_pipeline_request,
            max_completion_tokens=bounded_tokens,
            use_evidence_wire=True,
        )
    if profile == "pipeline_v3":
        compact_contract = json.dumps(
            PIPELINE_V3_OUTPUT_CONTRACT,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return NodeAProfileSpec(
            name=profile,
            system_prompt=f"{_FAST_SYSTEM_PROMPT}{PIPELINE_V3_SYSTEM_SUFFIX}\noutput_contract={compact_contract}",
            output_contract=PIPELINE_V3_OUTPUT_CONTRACT,
            prompt_version="stage-e0-pipeline-v3-v1",
            normalizer=_pipeline_v3_normalizer,
            request_builder=build_pipeline_v3_request,
            max_completion_tokens=bounded_tokens,
            use_evidence_wire=True,
        )
    raise ValueError(f"Unsupported NODE_A_PROFILE: {profile}")
