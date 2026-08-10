from typing import Any

from xunlei_zhiqu_runtime.models import CaptureBatch


def build_evidence_pack(batch: CaptureBatch) -> dict[str, Any]:
    return {
        "page": {
            "title": batch.page.title,
            "relevant_sections": batch.page.relevant_text[:20],
        },
        "selection": batch.selection.model_dump(mode="json") if batch.selection else None,
        "device": batch.device.model_dump(mode="json") if batch.device else None,
        "candidates": [
            {
                "id": candidate.candidate_id,
                "candidate_type": candidate.candidate_type,
                "display_name": candidate.display_name,
                "anchor_text": candidate.anchor_text,
                "nearby_text": candidate.nearby_text,
                "section_heading": candidate.section_heading,
                "probe_facts": candidate.probe_facts.model_dump(mode="json")
                if candidate.probe_facts
                else None,
            }
            for candidate in batch.candidates
        ],
    }
