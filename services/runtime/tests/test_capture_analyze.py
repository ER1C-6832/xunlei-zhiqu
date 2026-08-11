from fastapi.testclient import TestClient

from xunlei_zhiqu_runtime.main import app


SAMPLE = {
    "schema_version": "0.1",
    "batch_id": "batch_test",
    "trigger": "rectangle",
    "page": {
        "url": "https://example.test/downloads",
        "title": "Example App 下载",
        "relevant_text": ["Windows 版本", "备用地址"],
    },
    "selection": {"type": "rectangle", "candidate_ids": ["c1", "c2", "c3"]},
    "device": {"os": "windows", "arch": "x64", "locale": "zh-CN"},
    "candidates": [
        {
            "candidate_id": "c1",
            "value": "https://example.test/ExampleApp_win_x64_portable.zip",
            "candidate_type": "file",
            "capture_channel": "dom_link",
            "page_url": "https://example.test/downloads",
            "display_name": "ExampleApp_win_x64_portable.zip",
            "nearby_text": "Windows 64 位免安装版",
            "probe_status": "ok",
            "probe_facts": {"content_length": 100, "reachable": True},
        },
        {
            "candidate_id": "c2",
            "value": "https://example.test/ExampleApp_macos_arm64.dmg",
            "candidate_type": "file",
            "capture_channel": "dom_link",
            "page_url": "https://example.test/downloads",
            "display_name": "ExampleApp_macos_arm64.dmg",
            "probe_status": "pending",
        },
        {
            "candidate_id": "c3",
            "value": "https://example.test/index.html",
            "candidate_type": "page",
            "capture_channel": "dom_link",
            "page_url": "https://example.test/downloads",
            "display_name": "index.html",
            "probe_status": "skipped",
        },
    ],
}


def test_analyze_endpoint_returns_resource_plan(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "fixture")
    with TestClient(app) as client:
        response = client.post("/v1/capture/analyze", json=SAMPLE)

    assert response.status_code == 200
    body = response.json()
    assert body["batch_id"] == "batch_test"
    assert body["provider"] == "fixture"
    assert body["selected"][0]["candidate_ids"] == ["c1"]
    assert body["excluded"][0]["candidate_ids"] == ["c3"]
