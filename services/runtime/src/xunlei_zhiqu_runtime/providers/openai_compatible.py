import json
from uuid import uuid4

import httpx

from xunlei_zhiqu_runtime.models import EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter


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

输出单个 JSON 对象，符合 ResourcePlan JSON Schema。"""


class OpenAICompatibleProvider(ModelProviderAdapter):
    name = "openai_compatible"

    def __init__(self, *, base_url: str, api_key: str, model: str, timeout_seconds: float) -> None:
        if not api_key:
            raise ValueError("MODEL_API_KEY is required for openai_compatible provider")
        self._model = model
        self._client = httpx.AsyncClient(
            base_url=f"{base_url.rstrip('/')}/",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout_seconds,
        )

    async def analyze(self, evidence_pack: EvidencePack) -> ResourcePlan:
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
                            "task": "解释资源是什么，翻译技术名称，比较版本/规格，给出可修改的场景化推荐，并标出不确定项。",
                            "evidence_pack": evidence_pack.model_dump(mode="json"),
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
        parsed["schema_version"] = "0.1"
        parsed["batch_id"] = evidence_pack.batch_id
        parsed["provider"] = self.name
        parsed.setdefault("plan_id", f"plan_{uuid4().hex[:12]}")
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
