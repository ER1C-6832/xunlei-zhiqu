import json
import logging
import time

from xunlei_zhiqu_runtime.models import CaptureBatch, EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter
from xunlei_zhiqu_runtime.services.evidence import compile_evidence_pack
from xunlei_zhiqu_runtime.services.plan_cache import ResourcePlanCache


logger = logging.getLogger("uvicorn.error")


class CaptureAnalyzer:
    def __init__(
        self,
        provider: ModelProviderAdapter,
        *,
        cache: ResourcePlanCache | None = None,
    ) -> None:
        self._provider = provider
        self._cache = cache

    async def analyze(self, batch: CaptureBatch) -> ResourcePlan:
        started = time.perf_counter()
        compiled = compile_evidence_pack(batch)
        evidence_pack = compiled.pack
        evidence_chars = len(
            json.dumps(
                evidence_pack.model_dump(mode="json", exclude_none=True),
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )

        cache_key = None
        if self._cache is not None:
            cache_key = self._cache.make_key(
                evidence_pack,
                namespace=self._provider.cache_namespace,
            )
            cached_plan = self._cache.get(cache_key, batch_id=evidence_pack.batch_id)
            if cached_plan is not None:
                _validate_plan_references(cached_plan, evidence_pack)
                self._log_analysis(
                    compiled=compiled.stats,
                    evidence_chars=evidence_chars,
                    input_tokens=0,
                    output_tokens=0,
                    cached_tokens=0,
                    cache_hit=True,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                )
                return cached_plan

        result = await self._provider.analyze_with_metrics(evidence_pack)
        plan = result.plan
        _validate_plan_references(plan, evidence_pack)
        if self._cache is not None and cache_key is not None:
            self._cache.put(cache_key, plan)

        self._log_analysis(
            compiled=compiled.stats,
            evidence_chars=evidence_chars,
            input_tokens=result.metrics.input_tokens,
            output_tokens=result.metrics.output_tokens,
            cached_tokens=result.metrics.cached_tokens,
            cache_hit=False,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
        return plan

    def _log_analysis(
        self,
        *,
        compiled,
        evidence_chars: int,
        input_tokens: int | None,
        output_tokens: int | None,
        cached_tokens: int | None,
        cache_hit: bool,
        latency_ms: int,
    ) -> None:
        logger.info(
            "node_a_analysis model=%s candidate_raw_count=%d candidate_ai_count=%d evidence_chars=%d "
            "input_tokens=%s output_tokens=%s cached_tokens=%s cache_hit=%s latency_ms=%d "
            "dropped_navigation=%d grouped_candidates=%d context_count=%d",
            self._provider.model_name,
            compiled.raw_count,
            compiled.ai_count,
            evidence_chars,
            input_tokens if input_tokens is not None else "n/a",
            output_tokens if output_tokens is not None else "n/a",
            cached_tokens if cached_tokens is not None else "n/a",
            str(cache_hit).lower(),
            latency_ms,
            compiled.dropped_navigation,
            compiled.grouped_candidates,
            compiled.context_count,
        )


def _validate_plan_references(plan: ResourcePlan, evidence_pack: EvidencePack) -> None:
    if plan.batch_id != evidence_pack.batch_id:
        raise ValueError("ResourcePlan batch_id does not match the analyzed EvidencePack")

    candidate_ids: set[str] = set()
    for candidate in evidence_pack.candidates:
        candidate_ids.add(candidate.id)
        candidate_ids.update(candidate.candidate_ids)

    groups = {
        "selected": plan.selected,
        "alternatives": plan.alternatives,
        "excluded": plan.excluded,
        "uncertainties": plan.uncertainties,
    }
    item_ids: set[str] = set()
    group_candidate_ids: dict[str, set[str]] = {name: set() for name in groups}

    for group_name, items in groups.items():
        for item in items:
            if item.item_id in item_ids:
                raise ValueError(f"ResourcePlan contains duplicate item_id: {item.item_id}")
            item_ids.add(item.item_id)

            if len(item.candidate_ids) != len(set(item.candidate_ids)):
                raise ValueError(f"ResourcePlan item contains duplicate candidate_id: {item.item_id}")

            unknown = set(item.candidate_ids) - candidate_ids
            if unknown:
                raise ValueError(f"ResourcePlan references unknown candidate_id: {sorted(unknown)}")
            group_candidate_ids[group_name].update(item.candidate_ids)

    # uncertainty may intentionally overlap with a recommended/alternative item to
    # explain a caveat. The three decision buckets themselves must not contradict
    # each other for the same candidate.
    conflicting_pairs = (
        ("selected", "alternatives"),
        ("selected", "excluded"),
        ("alternatives", "excluded"),
    )
    for left, right in conflicting_pairs:
        overlap = group_candidate_ids[left] & group_candidate_ids[right]
        if overlap:
            raise ValueError(
                f"ResourcePlan classifies the same candidate in both {left} and {right}: {sorted(overlap)}"
            )

    for recommendation in plan.recommendations:
        if not recommendation.item_ids:
            raise ValueError("ResourcePlan recommendation must reference at least one item_id")
        if len(recommendation.item_ids) != len(set(recommendation.item_ids)):
            raise ValueError("ResourcePlan recommendation contains duplicate item_id")
        unknown_items = set(recommendation.item_ids) - item_ids
        if unknown_items:
            raise ValueError(f"ResourcePlan recommendation references unknown item_id: {sorted(unknown_items)}")
