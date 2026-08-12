import json
import logging
from uuid import uuid4

import httpx
from pydantic import ValidationError

from xunlei_zhiqu_runtime.models import EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import (
    ModelProviderAdapter,
    ModelProviderRequestError,
    ModelProviderResponseError,
    ModelProviderTimeoutError,
)


logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是“迅雷智取”的节点 A：资源理解与选型节点。

硬性规则：
1. 不猜用户隐藏意图。当前设备信息只是客观兼容证据，不等于用户唯一目标。
2. 只能依据 EvidencePack 中已有事实；不得编造 URL、版本、平台、架构、语言、字幕、清晰度、大小、哈希或兼容性。
3. 只能引用 EvidencePack 中已经存在的 candidate id，绝不能生成新的 candidate id。
4. ResourcePlan 是 AI 分析与推荐，不代表用户最终决定；措辞必须允许用户修改。
5. candidate_type=page 不是自动排除理由。只有证据显示它是导航、无关入口或不适合作为资源时才可在语义层标为 excluded/unknown。
6. 对专业文件名和技术缩写给出普通用户能理解的解释；比较版本、平台、架构、包类型、媒体规格和附件关系时说明证据来源。
7. 存在合理分歧或证据不足时放入 uncertainties，不要硬猜。
8. recommendations 必须是场景化建议，例如当前设备兼容、质量优先、体积优先或手动选择，并引用已有 item_id。
9. 尽量覆盖 EvidencePack 中所有有意义候选。用途和证据完全相同的附件可在一个 PlanItem 中引用多个 candidate_id；不得因为文件名相似就把不同候选当成同一资源。
10. 输出要通俗且紧凑，避免对重复的签名、SBOM、校验附件逐项复述相同长文。

输出单个 JSON 对象，只包含输出契约要求的业务字段。"""

OUTPUT_CONTRACT = {
    "resource_type": "software|video|audio|image|archive|mixed|unknown",
    "resource_title": "string",
    "overview": "string",
    "selected": "PlanItem[]",
    "alternatives": "PlanItem[]",
    "excluded": "PlanItem[]",
    "uncertainties": "PlanItem[]",
    "recommendations": "ScenarioRecommendation[]",
    "PlanItem": {
        "item_id": "unique string",
        "candidate_ids": ["existing candidate id"],
        "label": "plain-language label",
        "plain_explanation": "plain-language explanation",
        "reason": "evidence-based reason",
        "role": "primary|attachment|alternative|excluded|unknown",
        "technical_attributes": {"optional_fact": "primitive value or null"},
        "evidence_refs": ["optional evidence reference"],
    },
    "ScenarioRecommendation": {
        "scenario": "current_device|compatibility|quality|small_size|manual",
        "item_ids": ["existing PlanItem item_id"],
        "summary": "string",
    },
}


class OpenAICompatibleProvider(ModelProviderAdapter):
    name = "openai_compatible"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        write_timeout_seconds: float,
    ) -> None:
        if not api_key:
            raise ValueError("MODEL_API_KEY is required for openai_compatible provider")
        self._model = model
        self._read_timeout_seconds = read_timeout_seconds
        self._client = httpx.AsyncClient(
            base_url=f"{base_url.rstrip('/')}/",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=httpx.Timeout(
                connect=connect_timeout_seconds,
                read=read_timeout_seconds,
                write=write_timeout_seconds,
                pool=10.0,
            ),
        )

    async def analyze(self, evidence_pack: EvidencePack) -> ResourcePlan:
        request_document = {
            "task": "解释资源是什么，翻译技术名称，比较版本/规格，给出可修改的场景化推荐，并标出不确定项。",
            "evidence_pack": evidence_pack.model_dump(mode="json", exclude_none=True),
            "output_contract": OUTPUT_CONTRACT,
        }
        user_content = json.dumps(
            request_document,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        payload = {
            "model": self._model,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
        }
        logger.info(
            "node_a_request model=%s candidates=%d prompt_chars=%d read_timeout_seconds=%.0f",
            self._model,
            len(evidence_pack.candidates),
            len(user_content),
            self._read_timeout_seconds,
        )

        try:
            response = await self._client.post("chat/completions", json=payload)
        except httpx.ReadTimeout as exc:
            raise ModelProviderTimeoutError(
                f"模型服务在 {self._read_timeout_seconds:.0f} 秒内没有返回响应；"
                f"本次 EvidencePack 含 {len(evidence_pack.candidates)} 个候选。"
                "可以直接重试；若连续发生，请检查 MODEL_BASE_URL、系统代理或模型服务状态。"
            ) from exc
        except httpx.TimeoutException as exc:
            raise ModelProviderTimeoutError("连接模型服务超时，请检查网络、代理和模型服务地址。") from exc
        except httpx.RequestError as exc:
            raise ModelProviderRequestError(
                f"无法完成模型服务请求：{exc.__class__.__name__}。请检查 MODEL_BASE_URL、网络和系统代理。"
            ) from exc

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise ModelProviderRequestError(
                f"模型服务返回 HTTP {exc.response.status_code}。请检查模型名、API Key、额度或兼容接口配置。"
            ) from exc

        try:
            body = response.json()
            content = body["choices"][0]["message"]["content"]
            if not isinstance(content, str):
                raise TypeError("response content is not a string")
            parsed = json.loads(self._strip_fences(content))
            parsed["schema_version"] = "0.1"
            parsed["batch_id"] = evidence_pack.batch_id
            parsed["provider"] = self.name
            parsed.setdefault("plan_id", f"plan_{uuid4().hex[:12]}")
            return ResourcePlan.model_validate(parsed)
        except (KeyError, IndexError, TypeError, json.JSONDecodeError, ValidationError) as exc:
            raise ModelProviderResponseError(
                "模型已经返回响应，但结果不是可用的 ResourcePlan；请重试一次，若持续发生再调整节点 A Prompt。"
            ) from exc

    async def aclose(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _strip_fences(value: str) -> str:
        stripped = value.strip()
        if stripped.startswith("```"):
            lines = stripped.splitlines()
            lines = lines[1:-1] if len(lines) >= 3 else lines
            return "\n".join(lines).strip()
        return stripped
