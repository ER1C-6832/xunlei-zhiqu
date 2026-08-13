import json

import httpx
import pytest

from xunlei_zhiqu_runtime.models import EvidenceCandidate, EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.adapters.base import ProviderApiAdapter
from xunlei_zhiqu_runtime.providers.pipeline_v3 import (
    build_pipeline_v3_request,
    expand_pipeline_v3_resource_plan,
)
from xunlei_zhiqu_runtime.providers.structured_chat import StructuredChatProvider


def test_provider_stream_event_normalizes_delta_finish_and_usage() -> None:
    adapter = ProviderApiAdapter()
    delta = adapter.parse_stream_event(
        {
            "choices": [
                {
                    "delta": {"content": "{\"rt\":\"software\"}"},
                    "finish_reason": "stop",
                }
            ],
            "usage": None,
        }
    )
    assert delta.content_delta == '{"rt":"software"}'
    assert delta.finish_reason == "stop"

    usage = adapter.parse_stream_event(
        {
            "choices": [],
            "usage": {
                "prompt_tokens": 123,
                "completion_tokens": 45,
                "prompt_tokens_details": {"cached_tokens": 12},
            },
        }
    )
    assert usage.usage is not None
    assert usage.usage.input_tokens == 123
    assert usage.usage.output_tokens == 45
    assert usage.usage.cached_tokens == 12


@pytest.mark.asyncio
async def test_streaming_transport_only_returns_complete_validated_resource_plan() -> None:
    plan_payload = {
        "resource_type": "software",
        "resource_title": "Example Tool",
        "overview": "Use the Windows x64 installer on the current device.",
        "selected": [
            {
                "item_id": "plan_item_1",
                "candidate_ids": ["c1"],
                "label": "Windows x64 installer",
                "plain_explanation": "Installer for the current Windows device.",
                "reason": "Matches Windows x64.",
                "role": "primary",
            }
        ],
        "alternatives": [],
        "excluded": [],
        "uncertainties": [],
        "recommendations": [
            {
                "scenario": "current_device",
                "item_ids": ["plan_item_1"],
                "summary": "Use the Windows x64 installer.",
            }
        ],
    }
    content = json.dumps(plan_payload, ensure_ascii=False, separators=(",", ":"))
    midpoint = len(content) // 2
    events = [
        {"choices": [{"delta": {"content": content[:midpoint]}, "finish_reason": None}]},
        {"choices": [{"delta": {"content": content[midpoint:]}, "finish_reason": None}]},
        {
            "choices": [{"delta": {}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 40,
                "prompt_tokens_details": {"cached_tokens": 0},
            },
        },
    ]
    sse = "".join(
        f"data: {json.dumps(event, ensure_ascii=False, separators=(',', ':'))}\n\n"
        for event in events
    ) + "data: [DONE]\n\n"

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["stream"] is True
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=sse.encode("utf-8"),
        )

    provider = StructuredChatProvider(
        api_adapter=ProviderApiAdapter(),
        base_url="https://example.test/v1",
        api_key="test-key",
        model="fixture-stream-model",
        connect_timeout_seconds=1,
        read_timeout_seconds=5,
        write_timeout_seconds=1,
        max_completion_tokens=512,
        system_prompt="Return JSON only.",
        output_contract={},
        prompt_version="test-stream-v1",
        normalizer=lambda parsed: {},
        stream_diagnostics=True,
    )
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url="https://example.test/v1/",
        transport=httpx.MockTransport(handler),
    )
    pack = EvidencePack(
        batch_id="bench_stream",
        page={"title": "Example Tool"},
        device={"os": "windows", "arch": "x64"},
        candidates=[
            EvidenceCandidate(
                id="c1",
                candidate_type="file",
                filename="example-tool-x64.exe",
                extension="exe",
                technical_metadata={"platform_hint": "windows", "arch_hint": "x64"},
            )
        ],
    )
    try:
        result = await provider.analyze_with_metrics(pack)
    finally:
        await provider.aclose()

    assert result.plan.resource_title == "Example Tool"
    assert result.plan.selected[0].candidate_ids == ["c1"]
    assert result.metrics.input_tokens == 100
    assert result.metrics.output_tokens == 40
    assert result.metrics.time_to_first_byte_ms is not None
    assert result.metrics.time_to_first_content_ms is not None
    assert result.metrics.generation_ms is not None
    assert result.metrics.stream_total_ms is not None
    assert result.metrics.chunk_count == 3


def test_pipeline_v3_request_omits_redundant_scope_and_values() -> None:
    pack = EvidencePack(
        batch_id="bench-v3-wire",
        page={"title": "Example downloads"},
        selection={"type": "automatic", "candidate_ids": ["c1", "c2"]},
        device={"os": "windows", "arch": "x64"},
        candidates=[
            EvidenceCandidate(
                id="c1",
                candidate_type="file",
                display_name="tool.exe",
                filename="tool.exe",
                anchor_text="tool.exe",
                section_heading="Windows",
                technical_metadata={
                    "resource_family_hint": "software",
                    "platform_hint": "windows",
                    "content_type": "application/octet-stream",
                },
            ),
            EvidenceCandidate(
                id="c2",
                candidate_type="file",
                display_name="tool.zip",
                filename="tool.zip",
                section_heading="Windows",
                technical_metadata={
                    "resource_family_hint": "archive",
                    "platform_hint": "windows",
                },
            ),
        ],
    )

    request = build_pipeline_v3_request(pack)
    evidence = request["e"]
    assert isinstance(evidence, dict)
    assert evidence["q"] == {"t": "automatic"}
    assert evidence["h"] == [["h1", "Windows"]]
    candidates = evidence["c"]
    assert isinstance(candidates, list)
    first = candidates[0]
    assert "n" not in first
    assert "a" not in first
    assert first["f"] == "tool.exe"
    assert first["h"] == "h1"
    assert first["m"]["rf"] == "software"
    assert first["m"]["ph"] == "windows"
    assert first["m"]["ct"] == "application/octet-stream"


def test_pipeline_v3_restores_canonical_item_ids_roles_and_recommendation() -> None:
    parsed: dict[str, object] = {
        "rt": "software",
        "n": "Example Tool",
        "o": "Windows x64 build is compatible with the current device.",
        "s": [
            {
                "c": ["c1"],
                "l": "Windows x64 installer",
                "p": "Installer for the current Windows device.",
                "w": "Matches Windows x64.",
            }
        ],
        "a": [
            {
                "c": ["c2"],
                "l": "Portable archive",
                "p": "Manual extraction variant.",
                "w": "Same platform, different packaging.",
            }
        ],
    }

    stats = expand_pipeline_v3_resource_plan(parsed)
    assert stats["pipeline_v3_generated_item_ids"] == 2
    assert stats["pipeline_v3_derived_recommendations"] == 1

    parsed.update(
        {
            "schema_version": "0.1",
            "plan_id": "plan_bench_v3",
            "batch_id": "bench_v3",
            "provider": "fixture",
        }
    )
    plan = ResourcePlan.model_validate(parsed)
    assert plan.selected[0].item_id == "plan_item_1"
    assert plan.selected[0].role == "primary"
    assert plan.alternatives[0].item_id == "plan_item_2"
    assert plan.alternatives[0].role == "alternative"
    assert plan.recommendations[0].scenario == "current_device"
    assert plan.recommendations[0].item_ids == ["plan_item_1"]
