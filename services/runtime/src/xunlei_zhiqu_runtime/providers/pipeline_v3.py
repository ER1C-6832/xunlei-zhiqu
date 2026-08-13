from __future__ import annotations

from collections import Counter
import json
import logging
from typing import Any

from xunlei_zhiqu_runtime.models import EvidenceCandidate, EvidencePack
from xunlei_zhiqu_runtime.providers.output_wire import (
    PLAN_GROUPS,
    expand_compact_resource_plan,
)


logger = logging.getLogger("uvicorn.error")

PIPELINE_V3_OUTPUT_CONTRACT = {
    "top": "required rt=type,n=title,o=overview; optional s/a/x/u=item[]",
    "item": "{c:[candidate_id],l:label,p:plain_explanation,w:reason,ta?:technical_attributes}",
    "resource_type": "software|document|video|audio|image|subtitle|model|design|archive|disk_image|mixed|unknown",
    "omit": "no item_id/role/evidence_refs/recommendations; omit empty groups/ta",
}

_METADATA_ALIASES = {
    "resource_family_hint": "rf",
    "content_type": "ct",
    "content_length": "cl",
    "network_observed": "net",
    "media_kind": "mk",
    "attachment_kind": "ak",
    "platform_hint": "ph",
    "arch_hint": "ah",
}

PIPELINE_V3_SYSTEM_SUFFIX = """

P3 wire（仅传输，语义/安全规则不变）：
输入 user={e:{p,q,d,h,c}}。p=page{t:title,s:sections,c:[[context_id,text]]}; q=selection{t:type,i:[candidate_id]}; d=device{o:os,a:arch,l:locale}; h=[[heading_ref,heading]]; c=candidate[]。
candidate={i:id,g:[group candidate_id],t:type,n:display_name,f:filename,e:extension,a:anchor,x:nearby,r:context_ref,h:heading或heading_ref,o:overlap,p:provenance,m:metadata}。同义 n/f/a 缺项表示已去重；automatic q.i 缺项表示全部候选。
m aliases: rf=resource_family_hint,ct=content_type,cl=content_length,net=network_observed,mk=media_kind,ak=attachment_kind,ph=platform_hint,ah=arch_hint；其他键原名。
输出只用 rt,n,o,s,a,x,u；item 只用 c,l,p,w,ta。不要输出 item_id/role/evidence_refs/recommendations，Runtime 确定性生成。只输出 JSON。
"""


def build_pipeline_v3_request(evidence_pack: EvidencePack) -> dict[str, object]:
    canonical = evidence_pack.model_dump(
        mode="json",
        exclude_none=True,
        exclude_defaults=True,
    )
    before_chars = _serialized_chars(canonical)
    encoded = _encode_evidence(evidence_pack)
    after_chars = _serialized_chars(encoded)
    saved = max(0, before_chars - after_chars)
    saved_pct = (saved / before_chars * 100.0) if before_chars else 0.0
    logger.info(
        "node_a_request_wire_v3 before_chars=%d after_chars=%d saved_chars=%d saved_pct=%.1f",
        before_chars,
        after_chars,
        saved,
        saved_pct,
    )
    return {"e": encoded}


def expand_pipeline_v3_resource_plan(parsed: dict[str, object]) -> dict[str, int]:
    """Expand v3 wire and deterministically restore Runtime-owned fields."""
    compact_or_derived = expand_compact_resource_plan(parsed)
    generated_item_ids = _ensure_item_ids(parsed)
    derived_recommendations = _ensure_current_device_recommendation(parsed)
    logger.info(
        "node_a_output_wire_v3 compact_or_derived_keys=%d generated_item_ids=%d derived_recommendations=%d",
        compact_or_derived,
        generated_item_ids,
        derived_recommendations,
    )
    return {
        "pipeline_v3_compact_or_derived": compact_or_derived,
        "pipeline_v3_generated_item_ids": generated_item_ids,
        "pipeline_v3_derived_recommendations": derived_recommendations,
    }


def _encode_evidence(pack: EvidencePack) -> dict[str, object]:
    result: dict[str, object] = {}

    page = pack.page or {}
    compact_page: dict[str, object] = {}
    title = page.get("title")
    if isinstance(title, str) and title:
        compact_page["t"] = title
    sections = page.get("relevant_sections")
    if isinstance(sections, list) and sections:
        compact_page["s"] = sections
    contexts = page.get("contexts")
    if isinstance(contexts, list):
        compact_contexts: list[list[str]] = []
        for context in contexts:
            if not isinstance(context, dict):
                continue
            context_id = context.get("id")
            text = context.get("text")
            if isinstance(context_id, str) and isinstance(text, str):
                compact_contexts.append([context_id, text])
        if compact_contexts:
            compact_page["c"] = compact_contexts
    if compact_page:
        result["p"] = compact_page

    represented_ids = _represented_candidate_ids(pack.candidates)
    selection = pack.selection or {}
    compact_selection: dict[str, object] = {}
    selection_type = selection.get("type")
    if isinstance(selection_type, str):
        compact_selection["t"] = selection_type
    selection_ids = _string_list(selection.get("candidate_ids"))
    omit_full_automatic_scope = (
        selection_type == "automatic"
        and bool(selection_ids)
        and set(selection_ids) == represented_ids
    )
    if selection_ids and not omit_full_automatic_scope:
        compact_selection["i"] = selection_ids
    if compact_selection:
        result["q"] = compact_selection

    device = pack.device or {}
    compact_device: dict[str, object] = {}
    for source, target in (("os", "o"), ("arch", "a"), ("locale", "l")):
        value = device.get(source)
        if isinstance(value, str) and value:
            compact_device[target] = value
    if compact_device:
        result["d"] = compact_device

    heading_refs = _shared_heading_refs(pack.candidates)
    if heading_refs:
        result["h"] = [[ref, heading] for heading, ref in heading_refs.items()]

    result["c"] = [
        _encode_candidate(candidate, heading_refs=heading_refs)
        for candidate in pack.candidates
    ]
    return result


def _encode_candidate(
    candidate: EvidenceCandidate,
    *,
    heading_refs: dict[str, str],
) -> dict[str, object]:
    item: dict[str, object] = {"i": candidate.id, "t": candidate.candidate_type}
    if candidate.candidate_ids:
        item["g"] = candidate.candidate_ids

    display_name = _clean_text(candidate.display_name)
    filename = _clean_text(candidate.filename)
    anchor_text = _clean_text(candidate.anchor_text)
    if display_name and filename and _same(display_name, filename):
        display_name = None
    if anchor_text and any(
        _same(anchor_text, value)
        for value in (display_name, filename)
        if value
    ):
        anchor_text = None

    for key, value in (
        ("n", display_name),
        ("f", filename),
        ("e", candidate.extension),
        ("a", anchor_text),
        ("x", candidate.nearby_text),
        ("r", candidate.context_ref),
    ):
        if isinstance(value, str) and value:
            item[key] = value

    heading = _clean_text(candidate.section_heading)
    if heading:
        item["h"] = heading_refs.get(heading, heading)

    if candidate.selection_overlap is not None:
        item["o"] = candidate.selection_overlap

    provenance: list[list[str | None]] = []
    for source in candidate.capture_provenance:
        channel = source.get("channel")
        if not isinstance(channel, str) or not channel:
            continue
        provenance.append([
            channel,
            source.get("source_tag") if isinstance(source.get("source_tag"), str) else None,
            source.get("attribute") if isinstance(source.get("attribute"), str) else None,
        ])
    if provenance:
        item["p"] = provenance

    if candidate.technical_metadata:
        item["m"] = _encode_metadata(candidate.technical_metadata)
    return item


def _encode_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    encoded: dict[str, Any] = {}
    raw_keys = {str(key) for key in metadata}
    for key, value in metadata.items():
        if value is None:
            continue
        key = str(key)
        target = _METADATA_ALIASES.get(key, key)
        # If source metadata already contains a key equal to our proposed alias,
        # retain the canonical full key instead. Compression must be lossless.
        if target != key and target in raw_keys:
            target = key
        if target in encoded:
            target = key
        encoded[target] = _clean_json(value)
    return encoded


def _shared_heading_refs(candidates: list[EvidenceCandidate]) -> dict[str, str]:
    headings = [_clean_text(candidate.section_heading) for candidate in candidates]
    counts = Counter(heading for heading in headings if heading)
    shared = [heading for heading, count in counts.items() if count >= 2]
    return {heading: f"h{index}" for index, heading in enumerate(shared, start=1)}


def _represented_candidate_ids(candidates: list[EvidenceCandidate]) -> set[str]:
    result: set[str] = set()
    for candidate in candidates:
        if candidate.candidate_ids:
            result.update(candidate.candidate_ids)
        else:
            result.add(candidate.id)
    return result


def _ensure_item_ids(parsed: dict[str, object]) -> int:
    existing: set[str] = set()
    ordered_items: list[dict[str, object]] = []
    for group_name in PLAN_GROUPS:
        group = parsed.get(group_name)
        items = [group] if isinstance(group, dict) else group if isinstance(group, list) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            ordered_items.append(item)
            current = item.get("item_id")
            if isinstance(current, str) and current.strip():
                existing.add(current.strip())

    generated = 0
    sequence = 1
    for item in ordered_items:
        current = item.get("item_id")
        if isinstance(current, str) and current.strip():
            continue
        while f"plan_item_{sequence}" in existing:
            sequence += 1
        item_id = f"plan_item_{sequence}"
        item["item_id"] = item_id
        existing.add(item_id)
        generated += 1
        sequence += 1
    return generated


def _ensure_current_device_recommendation(parsed: dict[str, object]) -> int:
    existing = parsed.get("recommendations")
    if isinstance(existing, list) and existing:
        return 0
    selected = parsed.get("selected")
    items = [selected] if isinstance(selected, dict) else selected if isinstance(selected, list) else []
    selected_items = [item for item in items if isinstance(item, dict)]
    item_ids = [
        item_id
        for item in selected_items
        if isinstance((item_id := item.get("item_id")), str) and item_id
    ]
    if not item_ids:
        parsed.setdefault("recommendations", [])
        return 0

    first = selected_items[0]
    label = first.get("label") if isinstance(first.get("label"), str) else "已选主资源"
    reason = first.get("reason") if isinstance(first.get("reason"), str) else ""
    summary = label.strip()
    if reason.strip() and not _same(summary, reason):
        summary = f"{summary}：{reason.strip()}"
    parsed["recommendations"] = [
        {
            "scenario": "current_device",
            "item_ids": item_ids,
            "summary": summary[:320],
        }
    ]
    return 1


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _clean_text(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split())
    return cleaned or None


def _same(left: str, right: str) -> bool:
    return " ".join(left.split()).casefold() == " ".join(right.split()).casefold()


def _clean_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _clean_json(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_clean_json(item) for item in value]
    return value


def _serialized_chars(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
