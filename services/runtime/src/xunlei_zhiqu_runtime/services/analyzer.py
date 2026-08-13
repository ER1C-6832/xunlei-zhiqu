import json
import logging
import re
import time

from xunlei_zhiqu_runtime.models import CaptureBatch, EvidenceCandidate, EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import ModelCallMetrics, ModelProviderAdapter
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

    async def analyze(self, batch: CaptureBatch, *, force_refresh: bool = False) -> ResourcePlan:
        started = time.perf_counter()

        compile_started = time.perf_counter()
        compiled = compile_evidence_pack(batch)
        evidence_pack = compiled.pack
        evidence_chars = len(
            json.dumps(
                evidence_pack.model_dump(
                    mode="json",
                    exclude_none=True,
                    exclude_defaults=True,
                ),
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        compile_ms = _elapsed_ms(compile_started)

        cache_key = None
        cache_ms = 0
        if self._cache is not None:
            cache_started = time.perf_counter()
            cache_key = self._cache.make_key(
                evidence_pack,
                namespace=self._provider.cache_namespace,
            )
            cached_plan = None if force_refresh else self._cache.get(cache_key, batch_id=evidence_pack.batch_id)
            cache_ms += _elapsed_ms(cache_started)
            if cached_plan is not None:
                guard_started = time.perf_counter()
                _validate_plan_references(cached_plan, evidence_pack)
                _validate_recommendation_quality(cached_plan, evidence_pack)
                guard_ms = _elapsed_ms(guard_started)
                total_ms = _elapsed_ms(started)
                self._log_analysis(
                    compiled=compiled.stats,
                    evidence_chars=evidence_chars,
                    input_tokens=0,
                    output_tokens=0,
                    cached_tokens=0,
                    cache_hit=True,
                    force_refresh=False,
                    latency_ms=total_ms,
                    compile_ms=compile_ms,
                    cache_ms=cache_ms,
                    provider_ms=0,
                    guard_ms=guard_ms,
                )
                self._log_perf(
                    compiled=compiled.stats,
                    metrics=None,
                    cache_hit=True,
                    total_ms=total_ms,
                    compile_ms=compile_ms,
                    guard_ms=guard_ms,
                )
                return cached_plan

        result = await self._provider.analyze_with_metrics(evidence_pack)
        plan = result.plan

        guard_started = time.perf_counter()
        _validate_plan_references(plan, evidence_pack)
        _validate_recommendation_quality(plan, evidence_pack)
        guard_ms = _elapsed_ms(guard_started)

        if self._cache is not None and cache_key is not None:
            cache_started = time.perf_counter()
            self._cache.put(cache_key, plan)
            cache_ms += _elapsed_ms(cache_started)

        total_ms = _elapsed_ms(started)
        self._log_analysis(
            compiled=compiled.stats,
            evidence_chars=evidence_chars,
            input_tokens=result.metrics.input_tokens,
            output_tokens=result.metrics.output_tokens,
            cached_tokens=result.metrics.cached_tokens,
            cache_hit=False,
            force_refresh=force_refresh,
            latency_ms=total_ms,
            compile_ms=compile_ms,
            cache_ms=cache_ms,
            provider_ms=result.metrics.latency_ms,
            guard_ms=guard_ms,
        )
        self._log_perf(
            compiled=compiled.stats,
            metrics=result.metrics,
            cache_hit=False,
            total_ms=total_ms,
            compile_ms=compile_ms,
            guard_ms=guard_ms,
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
        force_refresh: bool,
        latency_ms: int,
        compile_ms: int,
        cache_ms: int,
        provider_ms: int,
        guard_ms: int,
    ) -> None:
        local_overhead_ms = max(0, latency_ms - provider_ms)
        logger.info(
            "node_a_analysis model=%s candidate_raw_count=%d candidate_ai_count=%d evidence_chars=%d "
            "input_tokens=%s output_tokens=%s cached_tokens=%s cache_hit=%s force_refresh=%s latency_ms=%d "
            "compile_ms=%d cache_ms=%d provider_ms=%d guard_ms=%d local_overhead_ms=%d "
            "dropped_navigation=%d grouped_candidates=%d context_count=%d",
            self._provider.model_name,
            compiled.raw_count,
            compiled.ai_count,
            evidence_chars,
            input_tokens if input_tokens is not None else "n/a",
            output_tokens if output_tokens is not None else "n/a",
            cached_tokens if cached_tokens is not None else "n/a",
            str(cache_hit).lower(),
            str(force_refresh).lower(),
            latency_ms,
            compile_ms,
            cache_ms,
            provider_ms,
            guard_ms,
            local_overhead_ms,
            compiled.dropped_navigation,
            compiled.grouped_candidates,
            compiled.context_count,
        )

    def _log_perf(
        self,
        *,
        compiled,
        metrics: ModelCallMetrics | None,
        cache_hit: bool,
        total_ms: int,
        compile_ms: int,
        guard_ms: int,
    ) -> None:
        logger.info(
            "node_a_perf provider=%s model=%s raw_candidates=%d ai_candidates=%d "
            "input_tokens=%s output_tokens=%s cached_tokens=%s ttft_ms=%s generation_ms=%s "
            "total_ms=%d tokens_per_second=%s cache_hit=%s connection_reused=%s http_version=%s "
            "compile_ms=%d validate_ms=%d validated=true",
            self._provider.name,
            self._provider.model_name,
            compiled.raw_count,
            compiled.ai_count,
            _metric(metrics.input_tokens if metrics else 0),
            _metric(metrics.output_tokens if metrics else 0),
            _metric(metrics.cached_tokens if metrics else 0),
            _metric(metrics.time_to_first_content_ms if metrics else None),
            _metric(metrics.generation_ms if metrics else None),
            total_ms,
            (
                f"{metrics.output_tokens_per_second:.1f}"
                if metrics and metrics.output_tokens_per_second is not None
                else "n/a"
            ),
            str(cache_hit).lower(),
            (
                str(metrics.connection_reused).lower()
                if metrics and metrics.connection_reused is not None
                else "n/a"
            ),
            metrics.http_version if metrics and metrics.http_version else "n/a",
            compile_ms,
            guard_ms,
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


def _validate_recommendation_quality(plan: ResourcePlan, evidence_pack: EvidencePack) -> None:
    """Reject obviously unusable default recommendations without inventing a replacement.

    This is intentionally narrow: it only catches attachment-only recommendations
    and explicit current-device incompatibility when matching evidence is present.
    The Runtime never chooses a different candidate on behalf of Node A.
    """
    if not plan.selected:
        return

    id_to_candidate: dict[str, EvidenceCandidate] = {}
    for candidate in evidence_pack.candidates:
        id_to_candidate[candidate.id] = candidate
        for candidate_id in candidate.candidate_ids:
            id_to_candidate[candidate_id] = candidate

    selected_ids = {
        candidate_id
        for item in plan.selected
        for candidate_id in item.candidate_ids
    }
    selected_candidates = [id_to_candidate[candidate_id] for candidate_id in selected_ids if candidate_id in id_to_candidate]

    primary_candidates = [candidate for candidate in evidence_pack.candidates if not _is_verification_attachment(candidate)]
    if primary_candidates and selected_candidates and all(_is_verification_attachment(candidate) for candidate in selected_candidates):
        raise ValueError("ResourcePlan selected only verification/SBOM/checksum attachments while primary resources exist")

    device = evidence_pack.device or {}
    device_os = str(device.get("os") or "").lower()
    device_arch = str(device.get("arch") or "").lower()
    if device_os not in {"windows", "macos", "linux"}:
        return

    matching_os = [candidate for candidate in primary_candidates if _platform_hint(candidate) == device_os]
    if not matching_os:
        return

    selected_os_match = any(_platform_hint(candidate) == device_os for candidate in selected_candidates)
    if not selected_os_match:
        raise ValueError(
            f"ResourcePlan selected no {device_os} resource even though compatible {device_os} candidates exist"
        )

    if device_arch not in {"x64", "arm64", "x86"}:
        return
    matching_os_arch = [
        candidate
        for candidate in matching_os
        if _arch_hint(candidate) == device_arch
    ]
    if not matching_os_arch:
        return
    selected_arch_match = any(
        _platform_hint(candidate) == device_os and _arch_hint(candidate) == device_arch
        for candidate in selected_candidates
    )
    if not selected_arch_match:
        raise ValueError(
            f"ResourcePlan selected no {device_os}/{device_arch} resource even though a matching candidate exists"
        )


def _is_verification_attachment(candidate: EvidenceCandidate) -> bool:
    technical = candidate.technical_metadata
    if str(technical.get("evidence_group_hint") or "").lower() == "signature_or_verification_files":
        return True
    if str(technical.get("attachment_kind") or "").lower() == "verification":
        return True
    extension = (candidate.extension or "").lower().lstrip(".")
    if extension in {"asc", "gpg", "md5", "sha1", "sha256", "sha512", "sig", "sigstore", "spdx"}:
        return True
    return False


def _platform_hint(candidate: EvidenceCandidate) -> str | None:
    technical_hint = candidate.technical_metadata.get("platform_hint")
    if isinstance(technical_hint, str) and technical_hint.lower() in {"windows", "macos", "linux"}:
        return technical_hint.lower()
    text = _identity_text(candidate)
    if re.search(r"\b(?:windows|win32|win64)\b", text):
        return "windows"
    if re.search(r"\b(?:macos|mac\s+os|osx|darwin)\b", text):
        return "macos"
    if re.search(r"\b(?:linux|ubuntu|debian|appimage)\b", text) or re.search(r"\.rpm\b", text):
        return "linux"
    return None


def _arch_hint(candidate: EvidenceCandidate) -> str | None:
    technical_hint = candidate.technical_metadata.get("arch_hint")
    if isinstance(technical_hint, str) and technical_hint.lower() in {"x64", "arm64", "x86"}:
        return technical_hint.lower()
    text = _identity_text(candidate)
    if re.search(r"\b(?:arm64|aarch64)\b", text):
        return "arm64"
    if re.search(r"\b(?:x64|amd64|x86[_-]64|64-bit)\b", text):
        return "x64"
    if re.search(r"\b(?:x86|i386|i686|32-bit)\b", text):
        return "x86"
    return None


def _identity_text(candidate: EvidenceCandidate) -> str:
    return " ".join(
        value.lower()
        for value in (
            candidate.display_name,
            candidate.filename,
            candidate.anchor_text,
            candidate.section_heading,
        )
        if isinstance(value, str) and value
    )


def _metric(value: object | None) -> str:
    return "n/a" if value is None else str(value)


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
