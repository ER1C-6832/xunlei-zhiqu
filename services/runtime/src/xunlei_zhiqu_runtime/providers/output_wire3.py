from __future__ import annotations

import json
import logging


logger = logging.getLogger("uvicorn.error")

PLAN_GROUP_KEYS = {
    "s": "selected",
    "a": "alternatives",
    "x": "excluded",
    "u": "uncertainties",
}


WIRE3_OUTPUT_CONTRACT = {
    "wire3": "h=[resource_type,resource_title,overview]; s/a/x/u=[item...]; item=[item_id,[candidate_id],label,plain_explanation,reason,role,technical_attributes?,evidence_refs?]; r=[rec...]; rec=[scenario,[item_id],summary]. Omit empty groups and trailing empty optional fields."
}

WIRE3_SYSTEM_SUFFIX = """

WIRE3 输出协议：最终 JSON 顶层仍是对象，但只用位置数组：
- h=[resource_type,resource_title,overview]
- s/a/x/u 分别是 selected/alternatives/excluded/uncertainties 的 item 数组
- item=[item_id,[candidate_id],label,plain_explanation,reason,role,technical_attributes?,evidence_refs?]
- r 是 recommendation 数组，rec=[scenario,[item_id],summary]
空组可省略；item 尾部空 technical_attributes/evidence_refs 可省略。语义、候选引用、当前设备推荐和附件约束与上文完全相同。不要输出完整字段名。
"""


def expand_positional_resource_plan(parsed: dict[str, object]) -> int:
    """Expand the wire3 positional JSON format into canonical ResourcePlan fields.

    The transformation is transport-only. The normal ResourcePlan normalizer,
    Pydantic validation and deterministic candidate/device checks still run after
    this function. Full-key and wire2-style output remain valid fallbacks.
    """
    raw_chars = _serialized_chars(parsed)
    expanded_rows = 0

    header = parsed.pop("h", None)
    if isinstance(header, list) and len(header) >= 3:
        parsed.setdefault("resource_type", header[0])
        parsed.setdefault("resource_title", header[1])
        parsed.setdefault("overview", header[2])
        expanded_rows += 1

    for short_key, full_key in PLAN_GROUP_KEYS.items():
        if full_key not in parsed and short_key in parsed:
            parsed[full_key] = parsed[short_key]
        parsed.pop(short_key, None)

        group = parsed.get(full_key)
        if not isinstance(group, list):
            continue
        expanded_group: list[object] = []
        for item in group:
            if isinstance(item, list):
                expanded = _expand_item_row(item)
                if expanded is not None:
                    expanded_group.append(expanded)
                    expanded_rows += 1
                    continue
            expanded_group.append(item)
        parsed[full_key] = expanded_group

    if "recommendations" not in parsed and "r" in parsed:
        parsed["recommendations"] = parsed["r"]
    parsed.pop("r", None)

    recommendations = parsed.get("recommendations")
    if isinstance(recommendations, list):
        expanded_recommendations: list[object] = []
        for recommendation in recommendations:
            if isinstance(recommendation, list):
                expanded = _expand_recommendation_row(recommendation)
                if expanded is not None:
                    expanded_recommendations.append(expanded)
                    expanded_rows += 1
                    continue
            expanded_recommendations.append(recommendation)
        parsed["recommendations"] = expanded_recommendations

    expanded_chars = _serialized_chars(parsed)
    savings = max(0, expanded_chars - raw_chars)
    saved_pct = (savings / expanded_chars * 100.0) if expanded_chars else 0.0
    logger.info(
        "node_a_output_wire3 expanded_rows=%d raw_chars=%d expanded_chars=%d saved_chars=%d saved_pct=%.1f",
        expanded_rows,
        raw_chars,
        expanded_chars,
        savings,
        saved_pct,
    )
    return expanded_rows


def _expand_item_row(row: list[object]) -> dict[str, object] | None:
    if len(row) < 6:
        return None
    item: dict[str, object] = {
        "item_id": row[0],
        "candidate_ids": row[1],
        "label": row[2],
        "plain_explanation": row[3],
        "reason": row[4],
        "role": row[5],
    }
    if len(row) >= 7 and row[6] not in (None, {}):
        item["technical_attributes"] = row[6]
    if len(row) >= 8 and row[7] not in (None, []):
        item["evidence_refs"] = row[7]
    return item


def _expand_recommendation_row(row: list[object]) -> dict[str, object] | None:
    if len(row) < 3:
        return None
    return {
        "scenario": row[0],
        "item_ids": row[1],
        "summary": row[2],
    }


def _serialized_chars(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
