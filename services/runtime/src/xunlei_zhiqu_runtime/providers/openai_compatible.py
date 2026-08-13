from __future__ import annotations

from collections.abc import Callable
import json
import logging
import time
from uuid import uuid4

import httpx
from pydantic import ValidationError

from xunlei_zhiqu_runtime.models import EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import (
    ModelAnalysisResult,
    ModelCallMetrics,
    ModelProviderAdapter,
    ModelProviderRequestError,
    ModelProviderResponseError,
    ModelProviderTimeoutError,
)


logger = logging.getLogger("uvicorn.error")
PROMPT_VERSION = "stage-d6-v2"
PLAN_ITEM_GROUPS = ("selected", "alternatives", "excluded", "uncertainties")
RECOMMENDATION_SCENARIOS = {"current_device", "compatibility", "quality", "small_size", "manual"}
_ROLE_BY_GROUP = {
    "selected": "primary",
    "alternatives": "alternative",
    "excluded": "excluded",
    "uncertainties": "unknown",
}

SYSTEM_PROMPT = """你是“迅雷智取”的节点 A：资源理解与选型节点。目标不是逐文件写报告，而是把几十个技术候选压缩成普通用户能快速选择的少量资源组。

工作顺序：
1. 先判断这一批资源整体是什么。
2. 找主资源，识别版本、平台、架构、安装形式、清晰度、格式等真正影响选择的差异。
3. 识别字幕、语言包、签名、校验、SBOM、配置、Tokenizer 等附件；同用途附件尽量合并。
4. 把专业文件名翻译成普通用户语言。
5. 根据明确事实给少量、可修改的推荐；证据不足才放 uncertainty。

安全与证据规则：
- 不猜隐藏意图。设备信息是明确提供的兼容证据，可以用于“当前设备”的默认推荐，但不代表用户最终只能选择该平台。
- 只能用 EvidencePack 事实，不得编造 URL、版本、平台、架构、语言、清晰度、大小、哈希或兼容性。
- 只能引用 EvidencePack 中已有 candidate id。一个 evidence entry 的 candidate_ids 可能包含多个原始候选，这些 ID 都可被 PlanItem 引用；绝不能生成新 ID。
- ResourcePlan 是建议，不是用户最终决定。
- resource_family_hint 只是本地 hint；ambiguous=true 时必须结合文件名、上下文、MIME 与技术元数据。
- candidate_type=page 不是自动排除理由。

默认推荐约束：
- selected 必须优先代表用户真正要获取的主资源。若存在安装包、媒体文件、文档、模型权重等主资源，不得把签名、校验、SBOM、GPG、checksum 等验证附件作为唯一 selected。
- evidence_group_hint=signature_or_verification_files 或 attachment_kind=verification 的条目只能作为附件组；除非整批证据本身就没有任何主资源，否则不要放入 selected。
- 当 device.os / device.arch 已知，且 EvidencePack 中存在明确匹配当前系统/架构的主资源时，selected 至少包含一个匹配当前设备的主资源。不得只推荐其他操作系统、源码包或验证附件。
- 对普通终端用户的软件发布页，如果存在当前设备可直接使用的安装包/压缩包，源码包应放 alternatives，而不是作为唯一默认推荐。
- 其他平台仍应保留在 alternatives，用户可以自行修改最终选择。

压缩原则：
- 不要为每个候选生成一张卡片。用途相同、差异不影响决策时，用一个 PlanItem.candidate_ids[] 聚合多个候选。
- selected 通常只放 1~3 个真正建议组；alternatives 按“其他平台/版本/格式/清晰度/安装方式”聚合。
- 签名、校验、SBOM 等重复辅助文件尽量合成一个 attachment PlanItem。
- excluded 不要求覆盖所有低价值项；仅在有助于用户理解时保留少量逻辑组。
- uncertainties 只写真正影响选择、且能锚定至少一个 candidate 的问题；泛化不确定说明写进 overview。
- recommendations 只保留少量有价值场景，没有 item 可引用就不要输出。

关注差异：软件看平台/架构/版本/安装版/便携版/源码/补丁/语言包；视频看分辨率/编码/HDR/音轨/字幕/单集全集；音频看格式/码率/采样率/位深；图片看原图/缩略图/分辨率/格式；文档看格式/版本/语言/源文件；模型看格式/量化/精度/框架/硬件需求及权重与配置关系。

结构规则：所有 PlanItem 至少引用 1 个真实 candidate_id；technical_attributes 必须是 JSON object；candidate_ids/evidence_refs/recommendation.item_ids 必须是数组。只输出一个 JSON 对象，不要 Markdown。"""

OUTPUT_CONTRACT = {
    "resource_type": "software|document|video|audio|image|subtitle|model|design|archive|disk_image|mixed|unknown",
    "resource_title": "string",
    "overview": "brief plain-language summary",
    "selected": "PlanItem[]",
    "alternatives": "PlanItem[]",
    "excluded": "PlanItem[]",
    "uncertainties": "PlanItem[]",
    "recommendations": "ScenarioRecommendation[]",
    "PlanItem": {
        "item_id": "unique string",
        "candidate_ids": ["one or more existing candidate ids"],
        "label": "short user-facing label",
        "plain_explanation": "brief explanation",
        "reason": "brief evidence-based reason",
        "role": "primary|attachment|alternative|excluded|unknown",
        "technical_attributes": {},
        "evidence_refs": [],
    },
    "ScenarioRecommendation": {
        "scenario": "current_device|compatibility|quality|small_size|manual",
        "item_ids": ["existing PlanItem item ids"],
        "summary": "brief summary",
    },
}

RequestBuilder = Callable[[EvidencePack], object]
PlanNormalizer = Callable[[dict[str, object]], dict[str, int]]


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
        system_prompt: str | None = None,
        output_contract: dict[str, object] | None = None,
        prompt_version: str | None = None,
        normalizer: PlanNormalizer | None = None,
        request_builder: RequestBuilder | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("MODEL_API_KEY is required for openai_compatible provider")
        self._model = model
        self._read_timeout_seconds = read_timeout_seconds
        self._max_completion_tokens = max_completion_tokens
        self._system_prompt = system_prompt if system_prompt is not None else SYSTEM_PROMPT
        self._output_contract = output_contract if output_contract is not None else OUTPUT_CONTRACT
        self._prompt_version = prompt_version or PROMPT_VERSION
        self._normalizer = normalizer or _normalize_model_resource_plan
        self._request_builder = request_builder
        self._dashscope_deepseek_v4 = (
            "aliyuncs.com" in base_url.lower()
            and model.lower().startswith("deepseek-v4")
        )
        # httpx already pools connections, but its default keep-alive expiry is
        # short for an interactive agent where users often wait >5s between
        # analyses. Keep a small pool warm so repeat analyses avoid needless
        # TCP/TLS setup without opening many idle sockets.
        self._client = httpx.AsyncClient(
            base_url=f"{base_url.rstrip('/')}/",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=httpx.Timeout(
                connect=connect_timeout_seconds,
                read=read_timeout_seconds,
                write=write_timeout_seconds,
                pool=10.0,
            ),
            limits=httpx.Limits(
                max_connections=8,
                max_keepalive_connections=4,
                keepalive_expiry=120.0,
            ),
        )

    @property
    def model_name(self) -> str:
        return self._model

    @property
    def cache_namespace(self) -> str:
        return f"{self.name}:{self._model}:{self._prompt_version}:max{self._max_completion_tokens}"

    async def analyze(self, evidence_pack: EvidencePack) -> ResourcePlan:
        return (await self.analyze_with_metrics(evidence_pack)).plan

    async def analyze_with_metrics(self, evidence_pack: EvidencePack) -> ModelAnalysisResult:
        started = time.perf_counter()
        build_started = started
        if self._request_builder is not None:
            request_document = self._request_builder(evidence_pack)
        else:
            request_document = {
                "task": "把这批候选整理成少量用户可选择的资源组，优先给出与当前设备兼容的主资源，解释关键差异并给出可修改推荐。",
                "evidence_pack": evidence_pack.model_dump(
                    mode="json",
                    exclude_none=True,
                    exclude_defaults=True,
                ),
                "output_contract": self._output_contract,
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
                {"role": "system", "content": self._system_prompt},
                {"role": "user", "content": user_content},
            ],
        }
        if self._dashscope_deepseek_v4:
            payload["enable_thinking"] = False
        build_ms = _elapsed_ms(build_started)

        logger.info(
            "node_a_request model=%s prompt_version=%s ai_evidence_count=%d prompt_chars=%d max_completion_tokens=%d "
            "dashscope_non_thinking_json=%s",
            self._model,
            self._prompt_version,
            len(evidence_pack.candidates),
            len(user_content),
            self._max_completion_tokens,
            self._dashscope_deepseek_v4,
        )

        http_started = time.perf_counter()
        try:
            response = await self._client.post("chat/completions", json=payload)
        except httpx.ReadTimeout as exc:
            raise ModelProviderTimeoutError(
                f"模型服务在 {self._read_timeout_seconds:.0f} 秒内没有返回响应；"
                f"本次精简 EvidencePack 含 {len(evidence_pack.candidates)} 个 AI evidence group。"
                "可以直接重试；若连续发生，请检查 MODEL_BASE_URL、系统代理或模型服务状态。"
            ) from exc
        except httpx.TimeoutException as exc:
            raise ModelProviderTimeoutError("连接模型服务超时，请检查网络、代理和模型服务地址。") from exc
        except httpx.RequestError as exc:
            raise ModelProviderRequestError(
                f"无法完成模型服务请求：{exc.__class__.__name__}。请检查 MODEL_BASE_URL、网络和系统代理。"
            ) from exc
        http_ms = _elapsed_ms(http_started)

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            provider_detail = _provider_error_detail(exc.response)
            suffix = f"：{provider_detail}" if provider_detail else ""
            raise ModelProviderRequestError(
                f"模型服务返回 HTTP {exc.response.status_code}{suffix}。"
                "请检查模型名、API Key、额度或兼容接口配置。"
            ) from exc

        response_json_started = time.perf_counter()
        try:
            body = response.json()
        except ValueError as exc:
            raise ModelProviderResponseError("模型服务返回了成功 HTTP 状态，但响应体不是 JSON。") from exc
        response_json_ms = _elapsed_ms(response_json_started)

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
                f"{self._max_completion_tokens}；请先检查是否仍生成了过多 PlanItem，再考虑提高上限。"
            )
        if not isinstance(content, str) or not content.strip():
            hint = ""
            if reasoning_chars:
                hint = "模型产生了 reasoning_content，但没有可用的最终 content；DashScope JSON Mode 应关闭思考模式。"
            raise ModelProviderResponseError(
                hint or "模型返回了空的最终 content，无法生成 ResourcePlan。"
            )

        output_json_started = time.perf_counter()
        try:
            parsed = json.loads(self._strip_fences(content))
        except json.JSONDecodeError as exc:
            raise ModelProviderResponseError(
                f"模型最终 content 不是合法 JSON（finish_reason={finish_reason or 'unknown'}，"
                f"content_chars={content_chars}）。"
            ) from exc
        output_json_ms = _elapsed_ms(output_json_started)

        if not isinstance(parsed, dict):
            raise ModelProviderResponseError("模型 JSON 顶层必须是对象，不能是数组或纯文本。")

        normalize_started = time.perf_counter()
        normalization = self._normalizer(parsed)
        normalize_ms = _elapsed_ms(normalize_started)
        if any(normalization.values()):
            logger.info(
                "node_a_normalized_output wrapped_groups=%d empty_groups=%d normalized_attributes=%d "
                "scalar_candidate_ids=%d cleaned_candidate_ids=%d dropped_unanchored_items=%d "
                "normalized_evidence_refs=%d derived_roles=%d dropped_empty_recommendations=%d "
                "dropped_invalid_recommendations=%d normalized_recommendation_item_ids=%d "
                "removed_dropped_item_references=%d",
                normalization["wrapped_groups"],
                normalization["empty_groups"],
                normalization["normalized_attributes"],
                normalization["scalar_candidate_ids"],
                normalization["cleaned_candidate_ids"],
                normalization["dropped_unanchored_items"],
                normalization["normalized_evidence_refs"],
                normalization["derived_roles"],
                normalization["dropped_empty_recommendations"],
                normalization["dropped_invalid_recommendations"],
                normalization["normalized_recommendation_item_ids"],
                normalization["removed_dropped_item_references"],
            )

        parsed["schema_version"] = "0.1"
        parsed["batch_id"] = evidence_pack.batch_id
        parsed["provider"] = self.name
        parsed.setdefault("plan_id", f"plan_{uuid4().hex[:12]}")
        validate_started = time.perf_counter()
        try:
            plan = ResourcePlan.model_validate(parsed)
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
        validate_ms = _elapsed_ms(validate_started)

        logger.info(
            "node_a_provider_timing build_ms=%d http_ms=%d response_json_ms=%d output_json_ms=%d "
            "normalize_ms=%d validate_ms=%d total_ms=%d",
            build_ms,
            http_ms,
            response_json_ms,
            output_json_ms,
            normalize_ms,
            validate_ms,
            _elapsed_ms(started),
        )

        input_tokens, output_tokens, cached_tokens = _usage_metrics(body)
        return ModelAnalysisResult(
            plan=plan,
            metrics=ModelCallMetrics(
                model=self._model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cached_tokens=cached_tokens,
                latency_ms=_elapsed_ms(started),
            ),
        )

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


def _usage_metrics(body: object) -> tuple[int | None, int | None, int | None]:
    if not isinstance(body, dict):
        return None, None, None
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return None, None, None
    input_tokens = _as_int(usage.get("prompt_tokens"))
    if input_tokens is None:
        input_tokens = _as_int(usage.get("input_tokens"))
    output_tokens = _as_int(usage.get("completion_tokens"))
    if output_tokens is None:
        output_tokens = _as_int(usage.get("output_tokens"))
    cached_tokens = None
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict):
        cached_tokens = _as_int(details.get("cached_tokens"))
    return input_tokens, output_tokens, cached_tokens


def _as_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _normalize_model_resource_plan(parsed: dict[str, object]) -> dict[str, int]:
    """Normalize semantically equivalent model shape variants.

    Candidate-less PlanItems are dropped because they cannot be grounded, located,
    selected, or executed. Unknown string candidate IDs are intentionally preserved
    so the deterministic analyzer can still reject hallucinated references.

    The containing decision bucket owns `role`; when a model omits that redundant
    field Runtime derives it instead of failing an otherwise valid plan.
    """
    stats = {
        "wrapped_groups": 0,
        "empty_groups": 0,
        "normalized_attributes": 0,
        "scalar_candidate_ids": 0,
        "cleaned_candidate_ids": 0,
        "dropped_unanchored_items": 0,
        "normalized_evidence_refs": 0,
        "derived_roles": 0,
        "dropped_empty_recommendations": 0,
        "dropped_invalid_recommendations": 0,
        "normalized_recommendation_item_ids": 0,
        "removed_dropped_item_references": 0,
    }
    dropped_item_ids: set[str] = set()

    for group_name in PLAN_ITEM_GROUPS:
        items = parsed.get(group_name)
        if items is None:
            parsed[group_name] = []
            stats["empty_groups"] += 1
            continue
        if isinstance(items, dict):
            items = [items]
            parsed[group_name] = items
            stats["wrapped_groups"] += 1
        if not isinstance(items, list):
            continue

        normalized_items: list[object] = []
        for item in items:
            if not isinstance(item, dict):
                normalized_items.append(item)
                continue

            role = item.get("role")
            if not isinstance(role, str) or not role.strip():
                item["role"] = _ROLE_BY_GROUP[group_name]
                stats["derived_roles"] += 1

            attributes = item.get("technical_attributes")
            if not isinstance(attributes, dict):
                item["technical_attributes"] = {}
                stats["normalized_attributes"] += 1

            candidate_ids = item.get("candidate_ids")
            if isinstance(candidate_ids, str):
                item["candidate_ids"] = [candidate_ids.strip()] if candidate_ids.strip() else []
                stats["scalar_candidate_ids"] += 1
            elif candidate_ids is None:
                item["candidate_ids"] = []
            elif isinstance(candidate_ids, list):
                normalized_ids, removed = _normalize_string_list(candidate_ids)
                item["candidate_ids"] = normalized_ids
                stats["cleaned_candidate_ids"] += removed

            if isinstance(item.get("candidate_ids"), list) and not item["candidate_ids"]:
                item_id = item.get("item_id")
                if isinstance(item_id, str) and item_id.strip():
                    dropped_item_ids.add(item_id.strip())
                stats["dropped_unanchored_items"] += 1
                continue

            evidence_refs = item.get("evidence_refs")
            if isinstance(evidence_refs, str):
                item["evidence_refs"] = [evidence_refs.strip()] if evidence_refs.strip() else []
                stats["normalized_evidence_refs"] += 1
            elif isinstance(evidence_refs, list):
                normalized_refs, removed = _normalize_string_list(evidence_refs)
                if removed or normalized_refs != evidence_refs:
                    item["evidence_refs"] = normalized_refs
                    stats["normalized_evidence_refs"] += 1
            elif evidence_refs is not None:
                item["evidence_refs"] = []
                stats["normalized_evidence_refs"] += 1
            else:
                item["evidence_refs"] = []

            normalized_items.append(item)
        parsed[group_name] = normalized_items

    recommendations = parsed.get("recommendations")
    if recommendations is None:
        parsed["recommendations"] = []
        stats["empty_groups"] += 1
    else:
        if isinstance(recommendations, dict):
            recommendations = [recommendations]
            parsed["recommendations"] = recommendations
            stats["wrapped_groups"] += 1
        if isinstance(recommendations, list):
            normalized_recommendations: list[object] = []
            for recommendation in recommendations:
                if not isinstance(recommendation, dict):
                    stats["dropped_invalid_recommendations"] += 1
                    continue

                scenario = recommendation.get("scenario")
                summary = recommendation.get("summary")
                if scenario not in RECOMMENDATION_SCENARIOS or not isinstance(summary, str) or not summary.strip():
                    stats["dropped_invalid_recommendations"] += 1
                    continue

                item_ids = recommendation.get("item_ids")
                if isinstance(item_ids, str):
                    normalized_item_ids = [item_ids.strip()] if item_ids.strip() else []
                    stats["normalized_recommendation_item_ids"] += 1
                elif isinstance(item_ids, list):
                    normalized_item_ids, removed = _normalize_string_list(item_ids)
                    stats["normalized_recommendation_item_ids"] += int(removed > 0 or normalized_item_ids != item_ids)
                else:
                    normalized_item_ids = []
                    stats["normalized_recommendation_item_ids"] += 1

                if dropped_item_ids:
                    filtered_item_ids = [item_id for item_id in normalized_item_ids if item_id not in dropped_item_ids]
                    stats["removed_dropped_item_references"] += len(normalized_item_ids) - len(filtered_item_ids)
                    normalized_item_ids = filtered_item_ids
                recommendation["item_ids"] = normalized_item_ids

                if not normalized_item_ids:
                    stats["dropped_empty_recommendations"] += 1
                    continue
                normalized_recommendations.append(recommendation)
            parsed["recommendations"] = normalized_recommendations

    return stats


def _normalize_string_list(values: list[object]) -> tuple[list[str], int]:
    result: list[str] = []
    seen: set[str] = set()
    removed = 0
    for value in values:
        if not isinstance(value, str):
            removed += 1
            continue
        cleaned = value.strip()
        if not cleaned or cleaned in seen:
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


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
