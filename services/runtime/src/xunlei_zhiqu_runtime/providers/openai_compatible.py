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


logger = logging.getLogger("uvicorn.error")
PLAN_ITEM_GROUPS = ("selected", "alternatives", "excluded", "uncertainties")

SYSTEM_PROMPT = """你是“迅雷智取”的节点 A：资源理解与选型节点。

硬性规则：
1. 不猜用户隐藏意图。当前设备信息只是客观兼容证据，不等于用户唯一目标。
2. 只能依据 EvidencePack 中已有事实；不得编造 URL、版本、平台、架构、语言、字幕、清晰度、大小、哈希或兼容性。
3. 只能引用 EvidencePack 中已经存在的 candidate id，绝不能生成新的 candidate id。
4. ResourcePlan 是 AI 分析与推荐，不代表用户最终决定；措辞必须允许用户修改。
5. candidate_type=page 不是自动排除理由。只有证据显示它是导航、无关入口或不适合作为资源时才可在语义层标为 excluded/unknown。
6. 对专业文件名和技术缩写给出普通用户能理解的解释；比较版本、平台、架构、包类型、媒体规格和附件关系时说明证据来源。
7. technical_metadata.resource_family_hint 只是扩展名 Registry 给出的本地提示，不是最终语义。resource_family_ambiguous=true 时尤其必须结合文件名、页面上下文、MIME 和其他技术元数据判断，不可只凭扩展名下结论。
8. 存在合理分歧或证据不足时放入 uncertainties，不要硬猜。uncertainties 中的每个 PlanItem 也必须至少引用 1 个真实 candidate_id；如果只是对整批资源的泛化不确定说明、无法锚定任何候选，请把它写进 overview，不要创建空 candidate_ids 的 PlanItem。
9. recommendations 必须是场景化建议，例如当前设备兼容、质量优先、体积优先或手动选择，并引用至少 1 个已有 item_id；没有可引用 item 时不要输出该 recommendation。
10. selected、alternatives、excluded、uncertainties 中的每个 PlanItem 都必须至少引用 1 个 EvidencePack 中已有 candidate id；绝不能输出 candidate_ids=[]、null 或缺失 candidate_ids。
11. 尽量覆盖 EvidencePack 中所有有意义候选。用途和证据完全相同的附件可在一个 PlanItem 中引用多个 candidate_id；不得因为文件名相似就把不同候选当成同一资源。
12. 输出要通俗且紧凑，避免对重复的签名、SBOM、校验附件逐项复述相同长文。
13. 必须只输出一个合法 JSON 对象，不要输出 Markdown、代码围栏或 JSON 之外的解释文字。
14. 每个 PlanItem.technical_attributes 必须始终是 JSON object；没有技术属性时必须输出 {}，绝不能输出 null、[]、字符串或其他类型。candidate_ids、evidence_refs、recommendations[*].item_ids 必须始终是 JSON array。

输出单个 JSON 对象，只包含输出契约要求的业务字段。"""

OUTPUT_CONTRACT = {
    "resource_type": "software|document|video|audio|image|subtitle|model|design|archive|disk_image|mixed|unknown",
    "resource_title": "string",
    "overview": "string",
    "selected": "PlanItem[]",
    "alternatives": "PlanItem[]",
    "excluded": "PlanItem[]",
    "uncertainties": "PlanItem[]",
    "recommendations": "ScenarioRecommendation[]",
    "PlanItem": {
        "item_id": "unique string",
        "candidate_ids": ["one or more existing candidate ids; never empty"],
        "label": "plain-language label",
        "plain_explanation": "plain-language explanation",
        "reason": "evidence-based reason",
        "role": "primary|attachment|alternative|excluded|unknown",
        "technical_attributes": "JSON object<string, string|number|boolean|null>; use {} when empty; never array/null/string",
        "evidence_refs": ["optional evidence reference"],
    },
    "ScenarioRecommendation": {
        "scenario": "current_device|compatibility|quality|small_size|manual",
        "item_ids": ["one or more existing PlanItem item ids; omit recommendation when none"],
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
        max_completion_tokens: int,
    ) -> None:
        if not api_key:
            raise ValueError("MODEL_API_KEY is required for openai_compatible provider")
        self._model = model
        self._read_timeout_seconds = read_timeout_seconds
        self._max_completion_tokens = max_completion_tokens
        self._dashscope_deepseek_v4 = (
            "aliyuncs.com" in base_url.lower()
            and model.lower().startswith("deepseek-v4")
        )
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
            "task": "解释资源是什么，翻译技术名称，比较版本/规格，给出可修改的场景化推荐，并标出不确定项。请严格按照 JSON 输出契约返回。",
            "evidence_pack": evidence_pack.model_dump(mode="json", exclude_none=True),
            "output_contract": OUTPUT_CONTRACT,
        }
        user_content = json.dumps(
            request_document,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        payload: dict[str, object] = {
            "model": self._model,
            "temperature": 0.1,
            "max_completion_tokens": self._max_completion_tokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
        }
        if self._dashscope_deepseek_v4:
            payload["enable_thinking"] = False

        logger.info(
            "node_a_request model=%s candidates=%d prompt_chars=%d read_timeout_seconds=%.0f "
            "max_completion_tokens=%d dashscope_non_thinking_json=%s",
            self._model,
            len(evidence_pack.candidates),
            len(user_content),
            self._read_timeout_seconds,
            self._max_completion_tokens,
            self._dashscope_deepseek_v4,
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
            provider_detail = _provider_error_detail(exc.response)
            suffix = f"：{provider_detail}" if provider_detail else ""
            raise ModelProviderRequestError(
                f"模型服务返回 HTTP {exc.response.status_code}{suffix}。"
                "请检查模型名、API Key、额度或兼容接口配置。"
            ) from exc

        try:
            body = response.json()
        except ValueError as exc:
            raise ModelProviderResponseError("模型服务返回了成功 HTTP 状态，但响应体不是 JSON。") from exc

        try:
            choice = body["choices"][0]
            message = choice["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelProviderResponseError("模型服务响应缺少 OpenAI Chat Completions 的 choices/message 结构。") from exc

        finish_reason = choice.get("finish_reason") if isinstance(choice, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        reasoning_content = message.get("reasoning_content") if isinstance(message, dict) else None
        content_chars = len(content) if isinstance(content, str) else 0
        reasoning_chars = len(reasoning_content) if isinstance(reasoning_content, str) else 0
        logger.info(
            "node_a_response finish_reason=%s content_chars=%d reasoning_chars=%d",
            finish_reason,
            content_chars,
            reasoning_chars,
        )

        if finish_reason == "length":
            raise ModelProviderResponseError(
                f"模型输出达到长度上限，ResourcePlan 被截断。当前 max_completion_tokens="
                f"{self._max_completion_tokens}；请提高 MODEL_MAX_COMPLETION_TOKENS 后重试。"
            )
        if not isinstance(content, str) or not content.strip():
            hint = ""
            if reasoning_chars:
                hint = "模型产生了 reasoning_content，但没有可用的最终 content；DashScope JSON Mode 应关闭思考模式。"
            raise ModelProviderResponseError(
                hint or "模型返回了空的最终 content，无法生成 ResourcePlan。"
            )

        try:
            parsed = json.loads(self._strip_fences(content))
        except json.JSONDecodeError as exc:
            raise ModelProviderResponseError(
                f"模型最终 content 不是合法 JSON（finish_reason={finish_reason or 'unknown'}，"
                f"content_chars={content_chars}）。"
            ) from exc

        if not isinstance(parsed, dict):
            raise ModelProviderResponseError("模型 JSON 顶层必须是对象，不能是数组或纯文本。")

        normalization = _normalize_model_resource_plan(parsed)
        if any(normalization.values()):
            logger.info(
                "node_a_normalized_output empty_groups=%d empty_attributes=%d scalar_candidate_ids=%d "
                "deduped_candidate_ids=%d dropped_unanchored_items=%d normalized_evidence_refs=%d "
                "dropped_empty_recommendations=%d normalized_recommendation_item_ids=%d",
                normalization["empty_groups"],
                normalization["empty_attributes"],
                normalization["scalar_candidate_ids"],
                normalization["deduped_candidate_ids"],
                normalization["dropped_unanchored_items"],
                normalization["normalized_evidence_refs"],
                normalization["dropped_empty_recommendations"],
                normalization["normalized_recommendation_item_ids"],
            )

        parsed["schema_version"] = "0.1"
        parsed["batch_id"] = evidence_pack.batch_id
        parsed["provider"] = self.name
        parsed.setdefault("plan_id", f"plan_{uuid4().hex[:12]}")
        try:
            return ResourcePlan.model_validate(parsed)
        except ValidationError as exc:
            summary = _validation_summary(exc)
            logger.warning(
                "node_a_resource_plan_validation_failed model=%s errors=%s",
                self._model,
                summary,
            )
            raise ModelProviderResponseError(
                f"模型返回了 JSON，但不符合 ResourcePlan：{summary}"
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


def _normalize_model_resource_plan(parsed: dict[str, object]) -> dict[str, int]:
    """Normalize only semantically equivalent model shape variants.

    Candidate-less PlanItems are dropped because they cannot be grounded, located,
    selected, or executed. Unknown candidate IDs are intentionally preserved here
    so the deterministic analyzer can still reject hallucinated references.
    """
    stats = {
        "empty_groups": 0,
        "empty_attributes": 0,
        "scalar_candidate_ids": 0,
        "deduped_candidate_ids": 0,
        "dropped_unanchored_items": 0,
        "normalized_evidence_refs": 0,
        "dropped_empty_recommendations": 0,
        "normalized_recommendation_item_ids": 0,
    }

    for group_name in PLAN_ITEM_GROUPS:
        items = parsed.get(group_name)
        if items is None:
            parsed[group_name] = []
            stats["empty_groups"] += 1
            continue
        if not isinstance(items, list):
            continue

        normalized_items: list[object] = []
        for item in items:
            if not isinstance(item, dict):
                normalized_items.append(item)
                continue

            value = item.get("technical_attributes")
            if value is None or value == []:
                item["technical_attributes"] = {}
                stats["empty_attributes"] += 1

            candidate_ids = item.get("candidate_ids")
            if isinstance(candidate_ids, str):
                item["candidate_ids"] = [candidate_ids.strip()] if candidate_ids.strip() else []
                stats["scalar_candidate_ids"] += 1
            elif candidate_ids is None:
                item["candidate_ids"] = []
            elif isinstance(candidate_ids, list):
                normalized_ids, removed = _dedupe_string_list(candidate_ids)
                item["candidate_ids"] = normalized_ids
                stats["deduped_candidate_ids"] += removed

            if isinstance(item.get("candidate_ids"), list) and not item["candidate_ids"]:
                stats["dropped_unanchored_items"] += 1
                continue

            evidence_refs = item.get("evidence_refs")
            if evidence_refs is None:
                item["evidence_refs"] = []
                stats["normalized_evidence_refs"] += 1
            elif isinstance(evidence_refs, str):
                item["evidence_refs"] = [evidence_refs.strip()] if evidence_refs.strip() else []
                stats["normalized_evidence_refs"] += 1
            elif isinstance(evidence_refs, list):
                normalized_refs, removed = _dedupe_string_list(evidence_refs)
                if removed or normalized_refs != evidence_refs:
                    item["evidence_refs"] = normalized_refs
                    stats["normalized_evidence_refs"] += 1

            normalized_items.append(item)
        parsed[group_name] = normalized_items

    recommendations = parsed.get("recommendations")
    if recommendations is None:
        parsed["recommendations"] = []
        stats["empty_groups"] += 1
    elif isinstance(recommendations, list):
        normalized_recommendations: list[object] = []
        for recommendation in recommendations:
            if not isinstance(recommendation, dict):
                normalized_recommendations.append(recommendation)
                continue
            item_ids = recommendation.get("item_ids")
            if isinstance(item_ids, str):
                recommendation["item_ids"] = [item_ids.strip()] if item_ids.strip() else []
                stats["normalized_recommendation_item_ids"] += 1
            elif item_ids is None:
                recommendation["item_ids"] = []
                stats["normalized_recommendation_item_ids"] += 1
            elif isinstance(item_ids, list):
                normalized_item_ids, removed = _dedupe_string_list(item_ids)
                if removed or normalized_item_ids != item_ids:
                    recommendation["item_ids"] = normalized_item_ids
                    stats["normalized_recommendation_item_ids"] += 1

            if isinstance(recommendation.get("item_ids"), list) and not recommendation["item_ids"]:
                stats["dropped_empty_recommendations"] += 1
                continue
            normalized_recommendations.append(recommendation)
        parsed["recommendations"] = normalized_recommendations

    return stats


def _dedupe_string_list(values: list[object]) -> tuple[list[object], int]:
    result: list[object] = []
    seen: set[str] = set()
    removed = 0
    for value in values:
        if not isinstance(value, str):
            result.append(value)
            continue
        cleaned = value.strip()
        if not cleaned:
            removed += 1
            continue
        if cleaned in seen:
            removed += 1
            continue
        seen.add(cleaned)
        result.append(cleaned)
    return result, removed


def _validation_summary(exc: ValidationError) -> str:
    parts: list[str] = []
    errors = exc.errors()
    for error in errors[:6]:
        location = ".".join(str(part) for part in error.get("loc", ())) or "root"
        message = str(error.get("msg", "validation error"))
        parts.append(f"{location}: {message}")
    remaining = len(errors) - len(parts)
    if remaining > 0:
        parts.append(f"另有 {remaining} 个字段错误")
    return "; ".join(parts)


def _provider_error_detail(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    error = body.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return error["message"][:300]
    if isinstance(body.get("message"), str):
        return body["message"][:300]
    return None
