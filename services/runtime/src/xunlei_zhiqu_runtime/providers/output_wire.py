from __future__ import annotations

import json
import logging


logger = logging.getLogger("uvicorn.error")

TOP_LEVEL_KEYS = {
    "rt": "resource_type",
    "n": "resource_title",
    "o": "overview",
    "s": "selected",
    "a": "alternatives",
    "x": "excluded",
    "u": "uncertainties",
    "r": "recommendations",
}

ITEM_KEYS = {
    "i": "item_id",
    "c": "candidate_ids",
    "l": "label",
    "p": "plain_explanation",
    "w": "reason",
    "ro": "role",
    "ta": "technical_attributes",
    "er": "evidence_refs",
}

RECOMMENDATION_KEYS = {
    "sc": "scenario",
    "i": "item_ids",
    "m": "summary",
}

PLAN_GROUPS = ("selected", "alternatives", "excluded", "uncertainties")
ROLE_BY_GROUP = {
    "selected": "primary",
    "alternatives": "alternative",
    "excluded": "excluded",
    "uncertainties": "unknown",
}


WIRE2_OUTPUT_CONTRACT = {
    "top": "rt=type,n=title,o=overview,s=selected[],a=alternatives[],x=excluded[],u=uncertainties[],r=recommendations[]",
    "item": "{i:item_id,c:[candidate_id],l:label,p:plain_explanation,w:reason,ro:role,ta:technical_attributes,er:evidence_refs}",
    "rec": "{sc:scenario,i:[item_id],m:summary}",
    "resource_type": "software|document|video|audio|image|subtitle|model|design|archive|disk_image|mixed|unknown",
    "role": "primary|attachment|alternative|excluded|unknown",
    "scenario": "current_device|compatibility|quality|small_size|manual",
    "omit": "empty top-level groups and empty ta/er may be omitted",
}

WIRE2_SYSTEM_SUFFIX = """\n\nWIRE2 输出协议：最终 JSON 只使用 output_contract 中的短键，不要输出完整字段名。s/a/x/u 是 item 对象数组，r 是 rec 对象数组；空组和空 ta/er 可省略。语义、候选引用和推荐约束与上文完全相同。"""


def expand_compact_resource_plan(parsed: dict[str, object]) -> int:
    """Expand the optional short-key model wire format in place.

    This is transport-only. The normal ResourcePlan normalizer and Pydantic model
    still run afterwards, so compact output cannot bypass deterministic validation.
    Full-key output is accepted as a compatibility fallback if the model ignores
    the compact contract.

    `role` is deterministic from the decision bucket and is therefore filled by
    Runtime when omitted. A provider should not fail merely because a model did
    not repeat information Runtime already owns.
    """
    raw_chars = _serialized_chars(parsed)
    expanded_keys = 0

    for short_key, full_key in TOP_LEVEL_KEYS.items():
        if full_key not in parsed and short_key in parsed:
            parsed[full_key] = parsed[short_key]
            expanded_keys += 1
        parsed.pop(short_key, None)

    for group_name in PLAN_GROUPS:
        group = parsed.get(group_name)
        if isinstance(group, dict):
            expanded_keys += _expand_item(group, group_name)
        elif isinstance(group, list):
            for item in group:
                if isinstance(item, dict):
                    expanded_keys += _expand_item(item, group_name)

    recommendations = parsed.get("recommendations")
    if isinstance(recommendations, dict):
        expanded_keys += _expand_recommendation(recommendations)
    elif isinstance(recommendations, list):
        for recommendation in recommendations:
            if isinstance(recommendation, dict):
                expanded_keys += _expand_recommendation(recommendation)

    expanded_chars = _serialized_chars(parsed)
    if expanded_keys:
        savings = max(0, expanded_chars - raw_chars)
        saved_pct = (savings / expanded_chars * 100.0) if expanded_chars else 0.0
        logger.info(
            "node_a_output_wire compact_or_derived_keys=%d raw_chars=%d expanded_chars=%d saved_chars=%d saved_pct=%.1f",
            expanded_keys,
            raw_chars,
            expanded_chars,
            savings,
            saved_pct,
        )
    else:
        logger.info(
            "node_a_output_wire compact_or_derived_keys=0 raw_chars=%d expanded_chars=%d saved_chars=0 saved_pct=0.0",
            raw_chars,
            expanded_chars,
        )
    return expanded_keys


def _expand_item(item: dict[str, object], group_name: str) -> int:
    expanded = 0
    for short_key, full_key in ITEM_KEYS.items():
        if full_key not in item and short_key in item:
            item[full_key] = item[short_key]
            expanded += 1
        item.pop(short_key, None)

    if not isinstance(item.get("role"), str) or not str(item.get("role") or "").strip():
        item["role"] = ROLE_BY_GROUP[group_name]
        expanded += 1
    return expanded


def _expand_recommendation(recommendation: dict[str, object]) -> int:
    expanded = 0
    for short_key, full_key in RECOMMENDATION_KEYS.items():
        if full_key not in recommendation and short_key in recommendation:
            recommendation[full_key] = recommendation[short_key]
            expanded += 1
        recommendation.pop(short_key, None)
    return expanded


def _serialized_chars(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
