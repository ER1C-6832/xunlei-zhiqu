from __future__ import annotations

import json
import logging
from typing import Any

from xunlei_zhiqu_runtime.models import EvidenceCandidate, EvidencePack


logger = logging.getLogger("uvicorn.error")

# Pipeline v1 keeps the proven wire2 semantics but removes transport-only fields
# that Runtime can derive deterministically. `role` comes from the containing
# decision group; empty technical attributes/evidence refs are Pydantic defaults.
PIPELINE_OUTPUT_CONTRACT = {
    "top": "rt=type,n=title,o=overview,s=selected[],a=alternatives[],x=excluded[],u=uncertainties[],r=recommendations[]",
    "item": "{i:item_id,c:[candidate_id],l:label,p:plain_explanation,w:reason,ta?:technical_attributes}",
    "rec": "{sc:scenario,i:[item_id],m:summary}",
    "resource_type": "software|document|video|audio|image|subtitle|model|design|archive|disk_image|mixed|unknown",
    "scenario": "current_device|compatibility|quality|small_size|manual",
    "omit": "empty groups and empty ta may be omitted; do not emit role/evidence_refs",
}

PIPELINE_SYSTEM_SUFFIX = """

PIPELINE 输入/输出协议：
- user JSON 只有 e，e 是压缩 EvidencePack：
  p=page{t:title,s:relevant_sections,c:[[context_id,text]]};
  q=selection{t:type,i:[candidate_id]}; d=device{o:os,a:arch,l:locale};
  c=candidates[]，候选短键：i=id,g=group candidate_ids,t=candidate_type,n=display_name,f=filename,e=extension,a=anchor_text,x=nearby_text,r=context_ref,h=section_heading,o=selection_overlap,p=provenance,m=technical_metadata。
  provenance 每项为 [channel,source_tag,attribute]。m 内技术 metadata 键名保持原义。
- 最终 JSON 使用 output_contract 的 wire2 短键。不要输出 role：Runtime 按所在组确定性补齐（s=primary,a=alternative,x=excluded,u=unknown）。不要输出 evidence_refs；空 ta 省略。
- 其余证据、安全、当前设备兼容、主资源与附件规则全部沿用上文。只输出 JSON。
"""


def build_pipeline_request(evidence_pack: EvidencePack) -> dict[str, object]:
    """Build a compact, lossless model-facing request from sanitized evidence.

    This is a transport encoding only. The analyzer/cache/guards continue to use
    the canonical EvidencePack. No candidate or decision-relevant fact is removed.
    """
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
        "node_a_request_wire before_chars=%d after_chars=%d saved_chars=%d saved_pct=%.1f",
        before_chars,
        after_chars,
        saved,
        saved_pct,
    )
    return {"e": encoded}


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

    selection = pack.selection or {}
    compact_selection: dict[str, object] = {}
    selection_type = selection.get("type")
    if isinstance(selection_type, str):
        compact_selection["t"] = selection_type
    selection_ids = selection.get("candidate_ids")
    if isinstance(selection_ids, list) and selection_ids:
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

    result["c"] = [_encode_candidate(candidate) for candidate in pack.candidates]
    return result


def _encode_candidate(candidate: EvidenceCandidate) -> dict[str, object]:
    item: dict[str, object] = {"i": candidate.id, "t": candidate.candidate_type}
    if candidate.candidate_ids:
        item["g"] = candidate.candidate_ids

    values = (
        ("n", candidate.display_name),
        ("f", candidate.filename),
        ("e", candidate.extension),
        ("a", candidate.anchor_text),
        ("x", candidate.nearby_text),
        ("r", candidate.context_ref),
        ("h", candidate.section_heading),
    )
    for key, value in values:
        if isinstance(value, str) and value:
            item[key] = value

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
        item["m"] = _clean_json(candidate.technical_metadata)
    return item


def _clean_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _clean_json(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_clean_json(item) for item in value]
    return value


def _serialized_chars(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
