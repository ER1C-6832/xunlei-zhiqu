from xunlei_zhiqu_runtime.models import CaptureBatch, EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter
from xunlei_zhiqu_runtime.services.evidence import build_evidence_pack


class CaptureAnalyzer:
    def __init__(self, provider: ModelProviderAdapter) -> None:
        self._provider = provider

    async def analyze(self, batch: CaptureBatch) -> ResourcePlan:
        evidence_pack = build_evidence_pack(batch)
        plan = await self._provider.analyze(evidence_pack)
        _validate_plan_references(plan, evidence_pack)
        return plan


def _validate_plan_references(plan: ResourcePlan, evidence_pack: EvidencePack) -> None:
    if plan.batch_id != evidence_pack.batch_id:
        raise ValueError("ResourcePlan batch_id does not match the analyzed EvidencePack")

    candidate_ids = {candidate.id for candidate in evidence_pack.candidates}
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
