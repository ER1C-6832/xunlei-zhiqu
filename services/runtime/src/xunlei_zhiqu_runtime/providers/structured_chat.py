from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import json
import logging
import time
from uuid import uuid4

import httpx
from pydantic import ValidationError

from xunlei_zhiqu_runtime.models import EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.adapters.base import ProviderApiAdapter, ProviderUsage
from xunlei_zhiqu_runtime.providers.base import (
    ModelAnalysisResult,
    ModelCallMetrics,
    ModelProgressSink,
    ModelProviderAdapter,
    ModelProviderRequestError,
    ModelProviderResponseError,
    ModelProviderTimeoutError,
    emit_model_progress,
)
from xunlei_zhiqu_runtime.providers.http_trace import HttpTimingBreakdown, HttpTraceRecorder


logger = logging.getLogger("uvicorn.error")
RequestBuilder = Callable[[EvidencePack], object]
PlanNormalizer = Callable[[dict[str, object]], dict[str, int]]


@dataclass(frozen=True, slots=True)
class _TransportResult:
    content: str | None
    reasoning_content: str | None
    finish_reason: str | None
    usage: ProviderUsage
    http_ms: int
    response_json_ms: int
    trace: HttpTimingBreakdown
    time_to_first_byte_ms: int | None = None
    time_to_first_content_ms: int | None = None
    generation_ms: int | None = None
    stream_total_ms: int | None = None
    chunk_count: int | None = None


class StructuredChatProvider(ModelProviderAdapter):
    """Provider-neutral structured chat transport used by Node A.

    Runtime supplies a sanitized EvidencePack and a Node-A protocol profile. The
    ProviderApiAdapter owns supplier/model dialect differences. This class owns
    only the common OpenAI-compatible HTTP transport, optional streaming timing,
    and ResourcePlan decoding.
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
        stream_diagnostics: bool = False,
        http2_enabled: bool = False,
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
        self._stream_diagnostics = stream_diagnostics
        self._http2_enabled = http2_enabled
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
            http2=http2_enabled,
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

    async def analyze_with_metrics(
        self,
        evidence_pack: EvidencePack,
        *,
        progress: ModelProgressSink | None = None,
    ) -> ModelAnalysisResult:
        started = time.perf_counter()
        build_started = started
        request_document = self._build_request_document(evidence_pack)
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
        streaming_enabled = self._stream_diagnostics or progress is not None
        if streaming_enabled:
            payload["stream"] = True
            payload.update(self._api_adapter.stream_request_overrides(model=self._model))
        build_ms = _elapsed_ms(build_started)

        logger.info(
            "node_a_request api_provider=%s model=%s prompt_version=%s ai_evidence_count=%d "
            "prompt_chars=%d max_completion_tokens=%d streaming_enabled=%s stream_diagnostics=%s http2_requested=%s",
            self._api_adapter.name,
            self._model,
            self._prompt_version,
            len(evidence_pack.candidates),
            len(user_content),
            self._max_completion_tokens,
            str(streaming_enabled).lower(),
            str(self._stream_diagnostics).lower(),
            str(self._http2_enabled).lower(),
        )

        await emit_model_progress(progress, "model_request_started")
        transport = (
            await self._send_streaming(payload, evidence_pack, progress=progress)
            if streaming_enabled
            else await self._send_buffered(payload, evidence_pack)
        )
        await emit_model_progress(progress, "model_completed")
        self._log_http_trace(transport.trace)

        content = transport.content
        reasoning_content = transport.reasoning_content
        content_chars = len(content) if isinstance(content, str) else 0
        reasoning_chars = len(reasoning_content) if isinstance(reasoning_content, str) else 0
        logger.info(
            "node_a_response api_provider=%s finish_reason=%s content_chars=%d reasoning_chars=%d",
            self._api_adapter.name,
            transport.finish_reason,
            content_chars,
            reasoning_chars,
        )

        if transport.finish_reason == "length":
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
                f"模型最终 content 不是合法 JSON（finish_reason={transport.finish_reason or 'unknown'}，"
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

        local_provider_ms = (
            build_ms
            + transport.response_json_ms
            + output_json_ms
            + normalize_ms
            + validate_ms
        )
        total_ms = _elapsed_ms(started)
        logger.info(
            "node_a_provider_timing api_provider=%s build_ms=%d http_roundtrip_ms=%d response_json_ms=%d "
            "output_json_ms=%d normalize_ms=%d validate_ms=%d provider_local_ms=%d total_ms=%d",
            self._api_adapter.name,
            build_ms,
            transport.http_ms,
            transport.response_json_ms,
            output_json_ms,
            normalize_ms,
            validate_ms,
            local_provider_ms,
            total_ms,
        )

        output_tokens_per_second = _tokens_per_second(
            transport.usage.output_tokens,
            transport.generation_ms,
        )
        if streaming_enabled:
            logger.info(
                "node_a_stream_trace api_provider=%s model=%s time_to_first_byte_ms=%s "
                "time_to_first_content_ms=%s generation_ms=%s stream_total_ms=%s "
                "input_tokens=%s output_tokens=%s output_tokens_per_second=%s chunk_count=%s "
                "finish_reason=%s",
                self._api_adapter.name,
                self._model,
                _fmt(transport.time_to_first_byte_ms),
                _fmt(transport.time_to_first_content_ms),
                _fmt(transport.generation_ms),
                _fmt(transport.stream_total_ms),
                _fmt(transport.usage.input_tokens),
                _fmt(transport.usage.output_tokens),
                f"{output_tokens_per_second:.1f}" if output_tokens_per_second is not None else "n/a",
                _fmt(transport.chunk_count),
                transport.finish_reason or "unknown",
            )

        return ModelAnalysisResult(
            plan=plan,
            metrics=ModelCallMetrics(
                model=self._model,
                input_tokens=transport.usage.input_tokens,
                output_tokens=transport.usage.output_tokens,
                cached_tokens=transport.usage.cached_tokens,
                latency_ms=total_ms,
                time_to_first_byte_ms=transport.time_to_first_byte_ms,
                time_to_first_content_ms=transport.time_to_first_content_ms,
                generation_ms=transport.generation_ms,
                stream_total_ms=transport.stream_total_ms,
                output_tokens_per_second=output_tokens_per_second,
                chunk_count=transport.chunk_count,
                connection_reused=transport.trace.connection_reused,
                http_version=transport.trace.http_version,
            ),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _build_request_document(self, evidence_pack: EvidencePack) -> object:
        if self._request_builder is not None:
            return self._request_builder(evidence_pack)
        return {
            "task": "把这批候选整理成少量用户可选择的资源组，优先给出与当前设备兼容的主资源，解释关键差异并给出可修改推荐。",
            "evidence_pack": evidence_pack.model_dump(
                mode="json",
                exclude_none=True,
                exclude_defaults=True,
            ),
            "output_contract": self._output_contract,
        }

    async def _send_buffered(
        self,
        payload: dict[str, object],
        evidence_pack: EvidencePack,
    ) -> _TransportResult:
        trace = HttpTraceRecorder()
        http_started = time.perf_counter()
        request = self._build_http_request(payload, trace)
        request_bytes = len(request.content)
        try:
            response = await self._client.send(request, stream=False)
        except httpx.ReadTimeout as exc:
            raise self._read_timeout_error(evidence_pack) from exc
        except httpx.TimeoutException as exc:
            raise ModelProviderTimeoutError("连接模型服务超时，请检查网络、代理和模型服务地址。") from exc
        except httpx.RequestError as exc:
            raise self._request_error(exc) from exc
        http_ms = _elapsed_ms(http_started)
        trace_result = trace.finish(response, http_total_ms=http_ms)
        self._log_request_sizes(request_bytes, trace_result.response_bytes)
        self._raise_for_status_buffered(response)

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
        return _TransportResult(
            content=content,
            reasoning_content=reasoning_content,
            finish_reason=finish_reason if isinstance(finish_reason, str) else None,
            usage=self._api_adapter.usage(body),
            http_ms=http_ms,
            response_json_ms=response_json_ms,
            trace=trace_result,
        )

    async def _send_streaming(
        self,
        payload: dict[str, object],
        evidence_pack: EvidencePack,
        *,
        progress: ModelProgressSink | None = None,
    ) -> _TransportResult:
        trace = HttpTraceRecorder()
        http_started = time.perf_counter()
        request = self._build_http_request(payload, trace)
        request_bytes = len(request.content)
        try:
            response = await self._client.send(request, stream=True)
        except httpx.ReadTimeout as exc:
            raise self._read_timeout_error(evidence_pack) from exc
        except httpx.TimeoutException as exc:
            raise ModelProviderTimeoutError("连接模型服务超时，请检查网络、代理和模型服务地址。") from exc
        except httpx.RequestError as exc:
            raise self._request_error(exc) from exc

        if response.is_error:
            try:
                raw_error = await response.aread()
            finally:
                await response.aclose()
            self._raise_for_status_stream(response, raw_error)

        first_byte_at: float | None = None
        first_content_at: float | None = None
        last_generation_at: float | None = None
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        finish_reason: str | None = None
        usage = ProviderUsage()
        event_count = 0
        response_bytes = 0
        buffer = b""

        try:
            async for chunk in response.aiter_bytes():
                now = time.perf_counter()
                if first_byte_at is None:
                    first_byte_at = now
                response_bytes += len(chunk)
                buffer += chunk
                while b"\n" in buffer:
                    raw_line, buffer = buffer.split(b"\n", 1)
                    event = self._parse_sse_line(raw_line)
                    if event is None:
                        continue
                    event_count += 1
                    stream_event = self._api_adapter.parse_stream_event(event)
                    if stream_event.usage is not None:
                        usage = _merge_usage(usage, stream_event.usage)
                    if stream_event.content_delta:
                        if first_content_at is None:
                            first_content_at = now
                            await emit_model_progress(progress, "model_first_token")
                        last_generation_at = now
                        content_parts.append(stream_event.content_delta)
                    if stream_event.reasoning_delta:
                        reasoning_parts.append(stream_event.reasoning_delta)
                    if stream_event.finish_reason:
                        finish_reason = stream_event.finish_reason
                        last_generation_at = now
            if buffer.strip():
                event = self._parse_sse_line(buffer)
                if event is not None:
                    event_count += 1
                    stream_event = self._api_adapter.parse_stream_event(event)
                    if stream_event.usage is not None:
                        usage = _merge_usage(usage, stream_event.usage)
                    if stream_event.content_delta:
                        now = time.perf_counter()
                        if first_content_at is None:
                            first_content_at = now
                            await emit_model_progress(progress, "model_first_token")
                        last_generation_at = now
                        content_parts.append(stream_event.content_delta)
                    if stream_event.reasoning_delta:
                        reasoning_parts.append(stream_event.reasoning_delta)
                    if stream_event.finish_reason:
                        finish_reason = stream_event.finish_reason
                        last_generation_at = time.perf_counter()
        except httpx.ReadTimeout as exc:
            raise self._read_timeout_error(evidence_pack) from exc
        except httpx.TimeoutException as exc:
            raise ModelProviderTimeoutError("模型流式响应超时，请检查网络、代理和供应商状态。") from exc
        except httpx.RequestError as exc:
            raise self._request_error(exc) from exc
        finally:
            await response.aclose()

        completed_at = time.perf_counter()
        http_ms = max(0, int((completed_at - http_started) * 1000))
        trace_result = trace.finish(
            response,
            http_total_ms=http_ms,
            response_bytes=response_bytes,
        )
        self._log_request_sizes(request_bytes, response_bytes)
        first_byte_ms = _duration_from(http_started, first_byte_at)
        first_content_ms = _duration_from(http_started, first_content_at)
        generation_ms = _duration_between(first_content_at, last_generation_at or completed_at)
        return _TransportResult(
            content="".join(content_parts),
            reasoning_content="".join(reasoning_parts),
            finish_reason=finish_reason,
            usage=usage,
            http_ms=http_ms,
            response_json_ms=0,
            trace=trace_result,
            time_to_first_byte_ms=first_byte_ms,
            time_to_first_content_ms=first_content_ms,
            generation_ms=generation_ms,
            stream_total_ms=http_ms,
            chunk_count=event_count,
        )

    def _build_http_request(
        self,
        payload: dict[str, object],
        trace: HttpTraceRecorder,
    ) -> httpx.Request:
        return self._client.build_request(
            "POST",
            "chat/completions",
            json=payload,
            extensions={"trace": trace.__call__},
        )

    def _parse_sse_line(self, raw_line: bytes) -> object | None:
        line = raw_line.strip().rstrip(b"\r")
        if not line or line.startswith(b":") or not line.startswith(b"data:"):
            return None
        payload = line[len(b"data:") :].strip()
        if not payload or payload == b"[DONE]":
            return None
        try:
            return json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ModelProviderResponseError("模型流式响应包含无法解析的 SSE JSON 事件。") from exc

    def _log_http_trace(self, trace_result: HttpTimingBreakdown) -> None:
        logger.info(
            "node_a_http_trace api_provider=%s model=%s http_version=%s connection_reused=%s "
            "dispatch_ms=%d tcp_connect_ms=%d tls_handshake_ms=%d request_headers_ms=%d "
            "request_body_ms=%d upstream_wait_ms=%d response_body_ms=%d response_close_ms=%d "
            "transport_unattributed_ms=%d client_transport_ms=%d provider_reported_ms=%s "
            "response_bytes=%d",
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
            trace_result.response_bytes,
        )
        if trace_result.server_timing:
            logger.info("node_a_server_timing raw=%s", trace_result.server_timing[:1000])

    def _log_request_sizes(self, request_bytes: int, response_bytes: int) -> None:
        logger.info(
            "node_a_http_size api_provider=%s model=%s request_bytes=%d response_bytes=%d",
            self._api_adapter.name,
            self._model,
            request_bytes,
            response_bytes,
        )

    def _raise_for_status_buffered(self, response: httpx.Response) -> None:
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            error_body: object = None
            try:
                error_body = exc.response.json()
            except ValueError:
                pass
            self._raise_provider_status(exc.response.status_code, error_body, exc)

    def _raise_for_status_stream(self, response: httpx.Response, raw_error: bytes) -> None:
        error_body: object = None
        try:
            error_body = json.loads(raw_error.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
        self._raise_provider_status(response.status_code, error_body, None)

    def _raise_provider_status(
        self,
        status_code: int,
        error_body: object,
        cause: Exception | None,
    ) -> None:
        detail = self._api_adapter.provider_error_detail(error_body)
        suffix = f"：{detail}" if detail else ""
        error = ModelProviderRequestError(
            f"模型服务返回 HTTP {status_code}{suffix}。"
            "请检查模型名、API Key、额度或兼容接口配置。"
        )
        if cause is not None:
            raise error from cause
        raise error

    def _read_timeout_error(self, evidence_pack: EvidencePack) -> ModelProviderTimeoutError:
        return ModelProviderTimeoutError(
            f"模型服务在 {self._read_timeout_seconds:.0f} 秒内没有返回响应；"
            f"本次 EvidencePack 含 {len(evidence_pack.candidates)} 个 AI evidence group。"
        )

    def _request_error(self, exc: httpx.RequestError) -> ModelProviderRequestError:
        return ModelProviderRequestError(
            f"无法完成模型服务请求：{exc.__class__.__name__}。请检查模型服务地址、网络和系统代理。"
        )


def _merge_usage(current: ProviderUsage, update: ProviderUsage) -> ProviderUsage:
    return ProviderUsage(
        input_tokens=update.input_tokens if update.input_tokens is not None else current.input_tokens,
        output_tokens=update.output_tokens if update.output_tokens is not None else current.output_tokens,
        cached_tokens=update.cached_tokens if update.cached_tokens is not None else current.cached_tokens,
    )


def _tokens_per_second(output_tokens: int | None, generation_ms: int | None) -> float | None:
    if output_tokens is None or generation_ms is None or generation_ms <= 0:
        return None
    return output_tokens / (generation_ms / 1000.0)


def _duration_from(started: float, ended: float | None) -> int | None:
    if ended is None:
        return None
    return max(0, int((ended - started) * 1000))


def _duration_between(started: float | None, ended: float | None) -> int | None:
    if started is None or ended is None:
        return None
    return max(0, int((ended - started) * 1000))


def _fmt(value: object | None) -> str:
    return "n/a" if value is None else str(value)


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
