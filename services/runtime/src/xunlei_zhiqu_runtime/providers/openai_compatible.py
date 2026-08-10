import json
from typing import Any

import httpx

from xunlei_zhiqu_runtime.models import CaptureBatch, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter


SYSTEM_PROMPT = """你是迅雷智取的节点 A：资源理解与选型节点。
你不猜用户隐藏意图。你只根据候选 ID、页面证据、技术元数据、用户显式操作和客观设备兼容信息，
解释资源差异并输出可修改的 ResourcePlan。不得编造 URL、文件属性、版本、字幕、清晰度或兼容性。
输出必须是单个 JSON 对象，字段与提供的 ResourcePlan JSON Schema 一致。"""


class OpenAICompatibleProvider(ModelProviderAdapter):
    name = "openai_compatible"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
    ) -> None:
        if not api_key:
            raise ValueError("MODEL_API_KEY is required for openai_compatible provider")
        self._model = model
        self._client = httpx.AsyncClient(
            base_url=f"{base_url.rstrip('/')}/",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout_seconds,
        )

    async def analyze(
        self,
        batch: CaptureBatch,
        evidence_pack: dict[str, Any],
    ) -> ResourcePlan:
        payload = {
            "model": self._model,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "batch_id": batch.batch_id,
                            "evidence_pack": evidence_pack,
                            "resource_plan_schema": ResourcePlan.model_json_schema(),
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
        }
        response = await self._client.post("chat/completions", json=payload)
        response.raise_for_status()
        body = response.json()
        content = body["choices"][0]["message"]["content"]
        if not isinstance(content, str):
            raise ValueError("OpenAI-compatible response content must be a JSON string")
        parsed = json.loads(self._strip_fences(content))
        parsed.setdefault("schema_version", "0.1")
        parsed.setdefault("batch_id", batch.batch_id)
        parsed.setdefault("provider", self.name)
        return ResourcePlan.model_validate(parsed)

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
