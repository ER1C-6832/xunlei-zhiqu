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
    all_items = plan.selected + plan.alternatives + plan.excluded + plan.uncertainties
    item_ids: set[str] = set()
    for item in all_items:
        if item.item_id in item_ids:
            raise ValueError(f"ResourcePlan contains duplicate item_id: {item.item_id}")
        item_ids.add(item.item_id)
        unknown = set(item.candidate_ids) - candidate_ids
        if unknown:
            raise ValueError(f"ResourcePlan references unknown candidate_id: {sorted(unknown)}")

    for recommendation in plan.recommendations:
        unknown_items = set(recommendation.item_ids) - item_ids
        if unknown_items:
            raise ValueError(f"ResourcePlan recommendation references unknown item_id: {sorted(unknown_items)}")
