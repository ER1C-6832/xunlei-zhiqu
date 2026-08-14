from __future__ import annotations

import json
import time

import httpx

from xunlei_zhiqu_runtime.providers.base import (
    ModelCallMetrics,
    ModelProviderRequestError,
    ModelProviderResponseError,
    ModelProviderTimeoutError,
    StructuredModelResult,
)
from xunlei_zhiqu_runtime.providers.structured_chat import StructuredChatProvider


class RuntimeStructuredChatProvider(StructuredChatProvider):
    """StructuredChatProvider with a public provider-neutral JSON capability.

    RecoveryService talks only to ModelProviderAdapter.generate_structured(). Supplier
    request overrides and response decoding stay behind ProviderApiAdapter here.
    """

    async def generate_structured(
        self,
        *,
        system_prompt: str,
        document: object,
        max_completion_tokens: int = 512,
        temperature: float = 0.1,
    ) -> StructuredModelResult:
        user_content = json.dumps(
            document,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        payload: dict[str, object] = {
            "model": self._model,
            "temperature": temperature,
            "max_completion_tokens": max_completion_tokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
        }
        payload.update(self._api_adapter.request_overrides(model=self._model))

        started = time.perf_counter()
        try:
            response = await self._client.post("chat/completions", json=payload)
        except httpx.ReadTimeout as exc:
            raise ModelProviderTimeoutError(
                f"模型服务在 {self._read_timeout_seconds:.0f} 秒内没有返回结构化响应。"
            ) from exc
        except httpx.TimeoutException as exc:
            raise ModelProviderTimeoutError(
                "连接模型服务超时，请检查网络、代理和模型服务地址。"
            ) from exc
        except httpx.RequestError as exc:
            raise ModelProviderRequestError(
                f"无法完成模型服务请求：{exc.__class__.__name__}。请检查模型服务地址、网络和系统代理。"
            ) from exc

        self._raise_for_status_buffered(response)
        try:
            body = response.json()
        except ValueError as exc:
            raise ModelProviderResponseError(
                "模型服务返回了成功 HTTP 状态，但响应体不是 JSON。"
            ) from exc

        try:
            choice = body["choices"][0]
            message = choice["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelProviderResponseError(
                "模型服务响应缺少 OpenAI Chat Completions 的 choices/message 结构。"
            ) from exc

        finish_reason = choice.get("finish_reason") if isinstance(choice, dict) else None
        content, reasoning_content = self._api_adapter.response_content(message)
        if finish_reason == "length":
            raise ModelProviderResponseError("模型结构化输出达到长度上限。")
        if not isinstance(content, str) or not content.strip():
            hint = self._api_adapter.empty_content_hint(
                model=self._model,
                reasoning_chars=len(reasoning_content) if isinstance(reasoning_content, str) else 0,
            )
            raise ModelProviderResponseError(hint or "模型返回了空的结构化 content。")

        try:
            parsed = json.loads(_strip_fences(content))
        except json.JSONDecodeError as exc:
            raise ModelProviderResponseError("模型结构化 content 不是合法 JSON。") from exc
        if not isinstance(parsed, dict):
            raise ModelProviderResponseError("模型结构化 JSON 顶层必须是对象。")

        usage = self._api_adapter.usage(body)
        return StructuredModelResult(
            value=parsed,
            metrics=ModelCallMetrics(
                model=self._model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cached_tokens=usage.cached_tokens,
                latency_ms=int((time.perf_counter() - started) * 1000),
            ),
        )


def _strip_fences(value: str) -> str:
    text = value.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3:
            return "\n".join(lines[1:-1]).strip()
    return text
