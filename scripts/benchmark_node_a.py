from __future__ import annotations

import argparse
import asyncio
from dataclasses import asdict
import importlib.util
import json
from pathlib import Path
from statistics import median
import time
from typing import Any

from xunlei_zhiqu_runtime.config import Settings
from xunlei_zhiqu_runtime.models import EvidencePack
from xunlei_zhiqu_runtime.providers.factory import create_provider
from xunlei_zhiqu_runtime.services.analyzer import (
    _validate_plan_references,
    _validate_recommendation_quality,
)
from xunlei_zhiqu_runtime.services.plan_cache import ResourcePlanCache


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURES = ROOT / "services" / "runtime" / "benchmarks" / "node_a_fixtures.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run fixed sanitized Node-A Evidence fixtures with streaming diagnostics.",
    )
    parser.add_argument("--fixtures-file", type=Path, default=DEFAULT_FIXTURES)
    parser.add_argument("--fixtures", default="all", help="Comma-separated fixture names, or all.")
    parser.add_argument(
        "--profiles",
        default="pipeline,pipeline_v3",
        help="Comma-separated NODE_A_PROFILE values.",
    )
    parser.add_argument(
        "--models",
        default="",
        help="Comma-separated models. Empty uses MODEL_NAME from .env.",
    )
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument(
        "--http2",
        choices=("off", "on", "both"),
        default="off",
        help="Benchmark HTTP/1.1 only, HTTP/2-enabled client only, or both.",
    )
    parser.add_argument("--provider", default="", help="Optional MODEL_PROVIDER override.")
    parser.add_argument("--base-url", default="", help="Optional MODEL_BASE_URL override.")
    parser.add_argument("--output", type=Path, default=None)
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    if args.runs < 1:
        raise SystemExit("--runs must be >= 1")
    if args.http2 in {"on", "both"} and importlib.util.find_spec("h2") is None:
        raise SystemExit(
            "HTTP/2 benchmark requires the optional h2 dependency. Run with: "
            "uv run --with 'httpx[http2]' --project services/runtime python scripts/benchmark_node_a.py ..."
        )

    base = Settings()
    fixtures = load_fixtures(args.fixtures_file, args.fixtures)
    profiles = csv_values(args.profiles)
    models = csv_values(args.models) or [base.model_name]
    http2_values = [False, True] if args.http2 == "both" else [args.http2 == "on"]

    records: list[dict[str, Any]] = []
    for model in models:
        for profile in profiles:
            for http2_enabled in http2_values:
                records.extend(
                    await run_combination(
                        base=base,
                        model=model,
                        profile=profile,
                        http2_enabled=http2_enabled,
                        fixtures=fixtures,
                        runs=args.runs,
                        provider_override=args.provider or None,
                        base_url_override=args.base_url or None,
                    )
                )

    summaries = summarize(records)
    for summary in summaries:
        print("node_a_benchmark_summary " + json.dumps(summary, ensure_ascii=False, separators=(",", ":")))

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps({"runs": records, "summaries": summaries}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"benchmark_json={args.output}")


async def run_combination(
    *,
    base: Settings,
    model: str,
    profile: str,
    http2_enabled: bool,
    fixtures: list[dict[str, Any]],
    runs: int,
    provider_override: str | None,
    base_url_override: str | None,
) -> list[dict[str, Any]]:
    updates: dict[str, Any] = {
        "model_name": model,
        "node_a_profile": profile,
        "model_stream_diagnostics": True,
        "model_http2_enabled": http2_enabled,
    }
    if provider_override:
        updates["model_provider"] = provider_override
    if base_url_override:
        updates["model_base_url"] = base_url_override
    settings = base.model_copy(update=updates)
    provider = create_provider(settings)
    cache = ResourcePlanCache(ttl_seconds=1200, max_entries=16)
    records: list[dict[str, Any]] = []

    try:
        sequence = 0
        for fixture in fixtures:
            pack = EvidencePack.model_validate(fixture["evidence_pack"])
            for run_index in range(1, runs + 1):
                sequence += 1
                record: dict[str, Any] = {
                    "provider": provider.name,
                    "model": model,
                    "profile": profile,
                    "http2_requested": http2_enabled,
                    "fixture": fixture["name"],
                    "run": run_index,
                    "sequence": sequence,
                    # Provider benchmark calls are deliberately uncached. A
                    # separate zero-provider cache smoke is measured below.
                    "cache_hit": False,
                }
                try:
                    result = await provider.analyze_with_metrics(pack)
                    plan = result.plan
                    _validate_plan_references(plan, pack)
                    _validate_recommendation_quality(plan, pack)
                    expected_ok, expectation_detail = validate_expectations(plan, fixture)
                    selected_ids = sorted({
                        candidate_id
                        for item in plan.selected
                        for candidate_id in item.candidate_ids
                    })
                    metrics = asdict(result.metrics)

                    cache_key = cache.make_key(pack, namespace=provider.cache_namespace)
                    cache.put(cache_key, plan)
                    cache_started = time.perf_counter()
                    cached_plan = cache.get(cache_key, batch_id=pack.batch_id)
                    cache_lookup_ms = max(0, int((time.perf_counter() - cache_started) * 1000))
                    cache_smoke_hit = cached_plan is not None
                    if cached_plan is not None:
                        _validate_plan_references(cached_plan, pack)
                        _validate_recommendation_quality(cached_plan, pack)

                    record.update(
                        {
                            "resource_plan_success": True,
                            "validation_success": True,
                            "expected_selection_success": expected_ok,
                            "expectation_detail": expectation_detail,
                            "selected_count": len(plan.selected),
                            "selected_candidate_ids": selected_ids,
                            "input_tokens": metrics["input_tokens"],
                            "output_tokens": metrics["output_tokens"],
                            "cached_tokens": metrics["cached_tokens"],
                            "ttfb_ms": metrics["time_to_first_byte_ms"],
                            "ttft_ms": metrics["time_to_first_content_ms"],
                            "generation_ms": metrics["generation_ms"],
                            "total_ms": metrics["latency_ms"],
                            "tokens_per_second": metrics["output_tokens_per_second"],
                            "chunk_count": metrics["chunk_count"],
                            "connection_reused": metrics["connection_reused"],
                            "http_version": metrics["http_version"],
                            "cache_smoke_hit": cache_smoke_hit,
                            "cache_lookup_ms": cache_lookup_ms,
                        }
                    )
                except Exception as exc:  # benchmark should continue across cases
                    record.update(
                        {
                            "resource_plan_success": False,
                            "validation_success": False,
                            "expected_selection_success": False,
                            "error": f"{exc.__class__.__name__}: {exc}",
                        }
                    )
                records.append(record)
                print("node_a_benchmark_run " + json.dumps(record, ensure_ascii=False, separators=(",", ":")))
    finally:
        await provider.aclose()
    return records


def load_fixtures(path: Path, requested: str) -> list[dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("fixture file must contain a JSON array")
    fixtures = [item for item in raw if isinstance(item, dict) and isinstance(item.get("name"), str)]
    wanted = csv_values(requested)
    if not wanted or wanted == ["all"]:
        return fixtures
    selected = [fixture for fixture in fixtures if fixture["name"] in wanted]
    missing = sorted(set(wanted) - {fixture["name"] for fixture in selected})
    if missing:
        raise ValueError(f"unknown fixtures: {missing}")
    return selected


def validate_expectations(plan, fixture: dict[str, Any]) -> tuple[bool, str]:
    selected_ids = {
        candidate_id
        for item in plan.selected
        for candidate_id in item.candidate_ids
    }
    expected = {
        value
        for value in fixture.get("expected_selected_any", [])
        if isinstance(value, str)
    }
    forbidden = {
        value
        for value in fixture.get("forbidden_selected", [])
        if isinstance(value, str)
    }
    if expected and not selected_ids.intersection(expected):
        return False, f"selected misses expected candidates: {sorted(expected)}"
    bad = selected_ids.intersection(forbidden)
    if bad:
        return False, f"selected forbidden candidates: {sorted(bad)}"
    return True, "ok"


def summarize(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str, bool], list[dict[str, Any]]] = {}
    for record in records:
        key = (
            str(record.get("provider")),
            str(record.get("model")),
            str(record.get("profile")),
            bool(record.get("http2_requested")),
        )
        groups.setdefault(key, []).append(record)

    summaries: list[dict[str, Any]] = []
    for (provider, model, profile, http2_requested), group in groups.items():
        successful = [item for item in group if item.get("validation_success")]
        quality = [item for item in group if item.get("expected_selection_success")]
        summaries.append(
            {
                "provider": provider,
                "model": model,
                "profile": profile,
                "http2_requested": http2_requested,
                "runs": len(group),
                "validation_success_rate": round(len(successful) / len(group), 3) if group else 0.0,
                "expected_selection_success_rate": round(len(quality) / len(group), 3) if group else 0.0,
                "input_tokens_median": metric_median(successful, "input_tokens"),
                "output_tokens_median": metric_median(successful, "output_tokens"),
                "cached_tokens_median": metric_median(successful, "cached_tokens"),
                "ttfb_ms_median": metric_median(successful, "ttfb_ms"),
                "ttft_ms_median": metric_median(successful, "ttft_ms"),
                "generation_ms_median": metric_median(successful, "generation_ms"),
                "total_ms_median": metric_median(successful, "total_ms"),
                "total_ms_max": metric_max(successful, "total_ms"),
                "tokens_per_second_median": metric_median(successful, "tokens_per_second"),
                "connection_reuse_rate": bool_rate(successful, "connection_reused"),
                "cache_smoke_hit_rate": bool_rate(successful, "cache_smoke_hit"),
                "cache_lookup_ms_median": metric_median(successful, "cache_lookup_ms"),
                "http_versions": sorted({
                    str(item["http_version"])
                    for item in successful
                    if item.get("http_version")
                }),
            }
        )
    return summaries


def metric_median(records: list[dict[str, Any]], key: str) -> int | float | None:
    values = [item[key] for item in records if isinstance(item.get(key), (int, float))]
    if not values:
        return None
    value = median(values)
    return round(value, 2) if isinstance(value, float) else value


def metric_max(records: list[dict[str, Any]], key: str) -> int | float | None:
    values = [item[key] for item in records if isinstance(item.get(key), (int, float))]
    return max(values) if values else None


def bool_rate(records: list[dict[str, Any]], key: str) -> float | None:
    values = [item[key] for item in records if isinstance(item.get(key), bool)]
    if not values:
        return None
    return round(sum(1 for value in values if value) / len(values), 3)


def csv_values(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


if __name__ == "__main__":
    asyncio.run(main())
