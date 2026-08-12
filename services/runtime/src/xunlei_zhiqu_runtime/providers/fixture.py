from uuid import uuid4

from xunlei_zhiqu_runtime.models import EvidencePack, PlanItem, ResourcePlan, ScenarioRecommendation
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter


class FixtureProvider(ModelProviderAdapter):
    """Explicit development-only provider. It never receives CaptureBatch or raw URLs."""

    name = "fixture"

    async def analyze(self, evidence_pack: EvidencePack) -> ResourcePlan:
        if not evidence_pack.candidates:
            raise ValueError("FixtureProvider requires at least one evidence candidate")

        items = [self._item(candidate, index) for index, candidate in enumerate(evidence_pack.candidates)]
        selected = items[:1]
        alternatives = items[1:4]
        uncertainties = items[4:]
        recommendations = []
        if selected:
            recommendations.append(
                ScenarioRecommendation(
                    scenario="manual",
                    item_ids=[item.item_id for item in selected],
                    summary="开发 Fixture 仅给出第一项作为默认勾选；请在确认界面人工修改。",
                )
            )
        return ResourcePlan(
            plan_id=f"plan_{uuid4().hex[:12]}",
            batch_id=evidence_pack.batch_id,
            provider=self.name,
            resource_type="unknown",
            resource_title=evidence_pack.page.get("title") or "未命名资源",
            overview=f"开发 Fixture 收到 {len(items)} 项脱敏候选，不执行真实语义判断。",
            selected=selected,
            alternatives=alternatives,
            excluded=[],
            uncertainties=uncertainties,
            recommendations=recommendations,
        )

    @staticmethod
    def _item(candidate, index: int) -> PlanItem:
        label = candidate.display_name or candidate.filename or candidate.id
        return PlanItem(
            item_id=f"item_{index + 1}",
            candidate_ids=[candidate.id],
            label=label,
            plain_explanation="Fixture 只验证数据链路，不代表真实 AI 选型。",
            reason=(
                f"capture={','.join(item.get('channel') or '' for item in candidate.capture_provenance)}; "
                f"overlap={candidate.selection_overlap}"
            ),
            role="primary" if index == 0 else "alternative" if index < 4 else "unknown",
            technical_attributes={
                "candidate_type": candidate.candidate_type,
                "extension": candidate.extension,
            },
            evidence_refs=[f"candidate:{candidate.id}"],
        )
