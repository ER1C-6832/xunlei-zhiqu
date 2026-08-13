from __future__ import annotations

from collections.abc import Callable
import json
import logging
import time
from uuid import uuid4

import httpx
from pydantic import ValidationError

from xunlei_zhiqu_runtime.models import EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.adapters.base import ProviderApiAdapter
from xunlei_zhiqu_runtime.providers.base import (
    ModelAnalysisResult,
    ModelCallMetrics,
    ModelProviderAdapter,
    ModelProviderRequestError,
    ModelProviderResponseError,
    ModelProviderTimeoutError,
)
from xunlei_zhiqu_runtime.providers.http_trace import HttpTraceRecorder


logger = logging.getLogger("uvicorn.error")
RequestBuilder = Callable[[EvidencePack], object]
PlanNormalizer = Callable[[dict[str, object]], dict[str, int]]


class StructuredChatProvider(ModelProviderAdapter):
    """Provider-neutral structured chat transport used by Node A.

    Runtime supplies a sanitized EvidencePack and a Node-A protocol profile. The
    ProviderApiAdapter owns supplier/model dialect differences. This class owns
    only the common OpenAI-compatible HTTP transport and ResourcePlan decoding.
    """

    def __init__(
        self,
        *,
        api_adapter: ProviderApiAdapter,
        base_url: str,
        api_key: str,
        model: str,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        write_timeout_seconds: float,
        max_completion_tokens: int,
        system_prompt: str,
        output_contract: dict[str, object],
        prompt_version: str,
        normalizer: PlanNormalizer,
        request_builder: RequestBuilder | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("MODEL_API_KEY is required for a remote model provider")
        self._api_adapter = api_adapter
        self.name = api_adapter.name
        self._model = model
        self._read_timeout_seconds = read_timeout_seconds
        self._max_completion_tokens = max_completion_tokens
        self._system_prompt = system_prompt
        self._output_contract = output_contract
        self._prompt_version = prompt_version
        self._normalizer = normalizer
        self._request_builder = request_builder
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
        return (
            f"{self.name}:{self._model}:{self._prompt_version}:"
            f"max{self._max_completion_tokens}"
        )

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
        payload.update(self._api_adapter.request_overrides(model=self._model))
        build_ms = _elapsed_ms(build_started)

        logger.info(
            "node_a_request api_provider=%s model=%s prompt_version=%s ai_evidence_count=%d "
            "prompt_chars=%d max_completion_tokens=%d",
            self._api_adapter.name,
            self._model,
            self._prompt_version,
            len(evidence_pack.candidates),
            len(user_content),
            self._max_completion_tokens,
        )

        trace = HttpTraceRecorder()
        http_started = time.perf_counter()
        try:
            request = self._client.build_request(
                "POST",
                "chat/completions",
                json=payload,
                extensions={"trace": trace.__call__},
            )
            request_bytes = len(request.content)
            response = await self._client.send(request, stream=False)
        except httpx.ReadTimeout as exc:
            raise ModelProviderTimeoutError(
                f"模型服务在 {self._read_timeout_seconds:.0f} 秒内没有返回响应；"
                f"本次 EvidencePack 含 {len(evidence_pack.candidates)} 个 AI evidence group。"
            ) from exc
        except httpx.TimeoutException as exc:
            raise ModelProviderTimeoutError("连接模型服务超时，请检查网络、代理和模型服务地址。") from exc
        except httpx.RequestError as exc:
            raise ModelProviderRequestError(
                f"无法完成模型服务请求：{exc.__class__.__name__}。请检查模型服务地址、网络和系统代理。"
            ) from exc
        http_ms = _elapsed_ms(http_started)
        trace_result = trace.finish(response, http_total_ms=http_ms)
        logger.info(
            "node_a_http_trace api_provider=%s model=%s http_version=%s connection_reused=%s "
            "dispatch_ms=%d tcp_connect_ms=%d tls_handshake_ms=%d request_headers_ms=%d "
            "request_body_ms=%d upstream_wait_ms=%d response_body_ms=%d response_close_ms=%d "
            "transport_unattributed_ms=%d client_transport_ms=%d provider_reported_ms=%s "
            "request_bytes=%d response_bytes=%d",
            self._api_adapter.name,
            self._model,
            trace_result.http_version,
            str(trace_result.connection_reused).lower(),
            trace_result.dispatch_ms,
            trace_result.tcp_connect_ms,
            trace_result.tls_handshake_ms,
            trace_result.request_headers_ms,
            trace_result.request_body_ms,
            trace_result.upstream_wait_ms,
            trace_result.response_body_ms,
            trace_result.response_close_ms,
            trace_result.transport_unattributed_ms,
            trace_result.client_transport_ms,
            trace_result.provider_reported_ms if trace_result.provider_reported_ms is not None else "n/a",
            request_bytes,
            trace_result.response_bytes,
        )
        if trace_result.server_timing:
            logger.info("node_a_server_timing raw=%s", trace_result.server_timing[:1000])

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            error_body: object = None
            try:
                error_body = exc.response.json()
            except ValueError:
                pass
            detail = self._api_adapter.provider_error_detail(error_body)
            suffix = f"：{detail}" if detail else ""
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
        content, reasoning_content = self._api_adapter.response_content(message)
        content_chars = len(content) if isinstance(content, str) else 0
        reasoning_chars = len(reasoning_content) if isinstance(reasoning_content, str) else 0
        logger.info(
            "node_a_response api_provider=%s finish_reason=%s content_chars=%d reasoning_chars=%d",
            self._api_adapter.name,
            finish_reason,
            content_chars,
            reasoning_chars,
        )

        if finish_reason == "length":
            raise ModelProviderResponseError(
                f"模型输出达到长度上限，ResourcePlan 被截断。当前 max_completion_tokens="
                f"{self._max_completion_tokens}。"
            )
        if not isinstance(content, str) or not content.strip():
            hint = self._api_adapter.empty_content_hint(
                model=self._model,
                reasoning_chars=reasoning_chars,
            )
            raise ModelProviderResponseError(hint or "模型返回了空的最终 content，无法生成 ResourcePlan。")

        output_json_started = time.perf_counter()
        try:
            parsed = json.loads(_strip_fences(content))
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
                "node_a_normalized_output %s",
                " ".join(f"{key}={value}" for key, value in normalization.items()),
            )

        parsed["schema_version"] = "0.1"
        parsed["batch_id"] = evidence_pack.batch_id
        parsed["provider"] = self._api_adapter.name
        parsed.setdefault("plan_id", f"plan_{uuid4().hex[:12]}")
        validate_started = time.perf_counter()
        try:
            plan = ResourcePlan.model_validate(parsed)
        except ValidationError as exc:
            summary = _validation_summary(exc)
            logger.warning(
                "node_a_resource_plan_validation_failed api_provider=%s model=%s errors=%s",
                self._api_adapter.name,
                self._model,
                summary,
            )
            raise ModelProviderResponseError(
                f"模型返回了 JSON，但不符合 ResourcePlan：{summary}"
            ) from exc
        validate_ms = _elapsed_ms(validate_started)

        local_provider_ms = build_ms + response_json_ms + output_json_ms + normalize_ms + validate_ms
        logger.info(
            "node_a_provider_timing api_provider=%s build_ms=%d http_roundtrip_ms=%d response_json_ms=%d "
            "output_json_ms=%d normalize_ms=%d validate_ms=%d provider_local_ms=%d total_ms=%d",
            self._api_adapter.name,
            build_ms,
            http_ms,
            response_json_ms,
            output_json_ms,
            normalize_ms,
            validate_ms,
            local_provider_ms,
            _elapsed_ms(started),
        )

        usage = self._api_adapter.usage(body)
        return ModelAnalysisResult(
            plan=plan,
            metrics=ModelCallMetrics(
                model=self._model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cached_tokens=usage.cached_tokens,
                latency_ms=_elapsed_ms(started),
            ),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def _strip_fences(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        lines = lines[1:-1] if len(lines) >= 3 else lines
        return "\n".join(lines).strip()
    return stripped


def _validation_summary(exc: ValidationError) -> str:
    parts: list[str] = []
    for error in exc.errors()[:8]:
        location = ".".join(str(part) for part in error.get("loc", ())) or "root"
        message = str(error.get("msg") or "invalid value")
        parts.append(f"{location}: {message}")
    return "; ".join(parts)


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
