import json

from fastapi.testclient import TestClient

from xunlei_zhiqu_runtime.config import get_settings
from xunlei_zhiqu_runtime.main import app


SAMPLE = {
    "schema_version": "0.1",
    "batch_id": "batch_progressive_test",
    "trigger": "rectangle",
    "page": {
        "url": "https://example.test/downloads",
        "title": "Example App 下载",
        "relevant_text": ["Windows 版本", "备用地址"],
    },
    "selection": {"type": "rectangle", "candidate_ids": ["c1", "c2"]},
    "device": {"os": "windows", "arch": "x64", "locale": "zh-CN"},
    "candidates": [
        {
            "candidate_id": "c1",
            "value": "https://example.test/ExampleApp_win_x64.zip",
            "candidate_type": "file",
            "capture_channel": "dom_link",
            "page_url": "https://example.test/downloads",
            "display_name": "ExampleApp Windows x64",
            "metadata": {"platform_hint": "windows", "arch_hint": "x64"},
        },
        {
            "candidate_id": "c2",
            "value": "https://example.test/ExampleApp_macos.dmg",
            "candidate_type": "file",
            "capture_channel": "dom_link",
            "page_url": "https://example.test/downloads",
            "display_name": "ExampleApp macOS",
            "metadata": {"platform_hint": "macos", "arch_hint": "arm64"},
        },
    ],
}


def _events(response) -> list[dict[str, object]]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def test_progressive_analysis_emits_phases_then_validated_result(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "fixture")
    monkeypatch.setenv("ENABLE_FIXTURE_PROVIDER", "true")
    monkeypatch.setenv("RUNTIME_AUTH_MODE", "off")
    get_settings.cache_clear()
    try:
        with TestClient(app) as client:
            response = client.post("/v1/capture/analyze-stream", json=SAMPLE)
    finally:
        get_settings.cache_clear()

    assert response.status_code == 200
    events = _events(response)
    phases = [event["phase"] for event in events if event.get("type") == "phase"]
    assert phases == [
        "evidence_ready",
        "model_request_started",
        "model_completed",
        "plan_validated",
        "done",
    ]
    result = next(event for event in events if event.get("type") == "result")
    assert result["cache_hit"] is False
    assert result["plan"]["batch_id"] == SAMPLE["batch_id"]
    assert result["plan"]["provider"] == "fixture"
    assert events.index(result) > max(
        index for index, event in enumerate(events)
        if event.get("type") == "phase" and event.get("phase") == "plan_validated"
    )


def test_progressive_analysis_cache_hit_skips_provider(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "fixture")
    monkeypatch.setenv("ENABLE_FIXTURE_PROVIDER", "true")
    monkeypatch.setenv("RUNTIME_AUTH_MODE", "off")
    get_settings.cache_clear()
    try:
        with TestClient(app) as client:
            first = client.post("/v1/capture/analyze-stream", json=SAMPLE)
            second = client.post("/v1/capture/analyze-stream", json=SAMPLE)
    finally:
        get_settings.cache_clear()

    assert first.status_code == 200
    assert second.status_code == 200
    events = _events(second)
    phases = [event["phase"] for event in events if event.get("type") == "phase"]
    assert phases == ["evidence_ready", "cache_hit", "plan_validated", "done"]
    assert "model_request_started" not in phases
    result = next(event for event in events if event.get("type") == "result")
    assert result["cache_hit"] is True
