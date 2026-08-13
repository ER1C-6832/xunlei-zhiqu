from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
import re
from typing import Any

from xunlei_zhiqu_runtime.models import EvidenceCandidate


_MAX_NEARBY = 150
_MAX_LABEL = 180
_MAX_HEADING = 120
_MAX_METADATA_TEXT = 180
_VERIFICATION_EXTENSIONS = {
    "asc",
    "gpg",
    "md5",
    "sha1",
    "sha256",
    "sha512",
    "sig",
    "sigstore",
    "spdx",
}
_VERIFICATION_WORDS = re.compile(
    r"\b(?:checksum|checksums|gpg|hash|md5|sbom|sha-?1|sha-?256|sha-?512|signature|sigstore|spdx)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class EvidenceReductionStats:
    raw_count: int
    ai_count: int
    dropped_navigation: int
    grouped_candidates: int
    context_count: int


@dataclass(frozen=True, slots=True)
class ReducedEvidence:
    candidates: list[EvidenceCandidate]
    contexts: list[dict[str, str]]
    stats: EvidenceReductionStats


def reduce_evidence_candidates(
    candidates: list[EvidenceCandidate],
    *,
    automatic: bool,
) -> ReducedEvidence:
    """Compress sanitized candidate evidence without changing the original CaptureBatch.

    The reducer intentionally works *after* URL sanitization. It may omit low-value
    automatic-navigation evidence from the model input, but it never changes raw
    Candidate IDs and never invents a resource URL.
    """
    compacted = [_compact_candidate(candidate) for candidate in candidates]

    dropped_navigation = 0
    filtered: list[EvidenceCandidate] = []
    for candidate in compacted:
        if automatic and _is_low_confidence_navigation(candidate):
            dropped_navigation += 1
            continue
        filtered.append(candidate)

    # An over-aggressive automatic filter must never leave Node A with no evidence.
    if not filtered and compacted:
        filtered = compacted[: min(12, len(compacted))]
        dropped_navigation = max(0, len(compacted) - len(filtered))

    grouped, grouped_candidates = _group_verification_evidence(filtered)
    deduped, contexts = _dedupe_nearby_context(grouped)

    return ReducedEvidence(
        candidates=deduped,
        contexts=contexts,
        stats=EvidenceReductionStats(
            raw_count=len(candidates),
            ai_count=len(deduped),
            dropped_navigation=dropped_navigation,
            grouped_candidates=grouped_candidates,
            context_count=len(contexts),
        ),
    )


def _compact_candidate(candidate: EvidenceCandidate) -> EvidenceCandidate:
    metadata = _compact_metadata(candidate.technical_metadata)
    # A normal EvidenceCandidate already has a unique `id`; repeating the same ID
    # in candidate_ids wastes prompt space. candidate_ids is reserved for reducer
    # groups that represent multiple original candidates.
    candidate_ids = _unique_strings(candidate.candidate_ids)
    if candidate_ids == [candidate.id]:
        candidate_ids = []

    return candidate.model_copy(
        update={
            "candidate_ids": candidate_ids,
            "display_name": _short(candidate.display_name, _MAX_LABEL),
            "filename": _short(candidate.filename, _MAX_LABEL),
            "anchor_text": _short(candidate.anchor_text, _MAX_LABEL),
            "nearby_text": _short(candidate.nearby_text, _MAX_NEARBY),
            "section_heading": _short(candidate.section_heading, _MAX_HEADING),
            "technical_metadata": metadata,
        }
    )


def _compact_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in metadata.items():
        if value is None:
            continue
        if isinstance(value, str):
            result[key] = _short(value, _MAX_METADATA_TEXT)
        elif isinstance(value, (int, float, bool)):
            result[key] = value
        elif isinstance(value, list):
            values = [
                _short(item, 80) if isinstance(item, str) else item
                for item in value[:12]
                if isinstance(item, (str, int, float, bool))
            ]
            if values:
                result[key] = values
        elif isinstance(value, dict):
            nested = {
                str(nested_key): _short(nested_value, 80) if isinstance(nested_value, str) else nested_value
                for nested_key, nested_value in list(value.items())[:12]
                if isinstance(nested_value, (str, int, float, bool)) or nested_value is None
            }
            if nested:
                result[key] = nested
    return result


def _is_low_confidence_navigation(candidate: EvidenceCandidate) -> bool:
    if candidate.candidate_type not in {"page", "unknown"}:
        return False

    technical = candidate.technical_metadata
    strong_keys = (
        "content_disposition",
        "download_attribute",
        "media_kind",
        "mime_type",
        "network_observed",
        "resource_family_hint",
    )
    if any(technical.get(key) not in (None, "", False) for key in strong_keys):
        return False
    if candidate.extension:
        return False

    # Rectangle/click evidence is filtered by the caller through automatic=False.
    # For automatic discovery, plain page/unknown links are useful to the UI but
    # are usually navigation noise for Node A.
    return True


def _group_verification_evidence(
    candidates: list[EvidenceCandidate],
) -> tuple[list[EvidenceCandidate], int]:
    grouped_indexes: dict[str, list[int]] = defaultdict(list)
    for index, candidate in enumerate(candidates):
        if _is_verification_candidate(candidate):
            # Keep separate release sections separate when the page gives us one.
            heading = _normalize_text(candidate.section_heading or "")
            grouped_indexes[heading].append(index)

    replace_at: dict[int, EvidenceCandidate] = {}
    consumed: set[int] = set()
    grouped_candidates = 0
    for indexes in grouped_indexes.values():
        if len(indexes) < 3:
            continue
        members = [candidates[index] for index in indexes]
        merged_ids = _unique_strings(
            candidate_id
            for member in members
            for candidate_id in (member.candidate_ids or [member.id])
        )
        first = members[0]
        merged_metadata = {
            "evidence_group_hint": "signature_or_verification_files",
            "group_count": len(merged_ids),
            "resource_family_hint": "document",
        }
        replace_at[indexes[0]] = EvidenceCandidate(
            id=merged_ids[0],
            candidate_ids=merged_ids,
            candidate_type="file",
            display_name=f"签名、校验与 SBOM 附件（{len(merged_ids)} 项）",
            filename=None,
            extension=None,
            anchor_text="签名 / 校验 / SBOM",
            nearby_text=None,
            section_heading=first.section_heading,
            selection_overlap=max(
                (member.selection_overlap or 0.0 for member in members),
                default=0.0,
            )
            or None,
            capture_provenance=_merge_provenance(members),
            technical_metadata=merged_metadata,
        )
        consumed.update(indexes[1:])
        grouped_candidates += len(indexes) - 1

    result: list[EvidenceCandidate] = []
    for index, candidate in enumerate(candidates):
        if index in consumed:
            continue
        result.append(replace_at.get(index, candidate))
    return result, grouped_candidates


def _is_verification_candidate(candidate: EvidenceCandidate) -> bool:
    extension = (candidate.extension or "").lower().lstrip(".")
    if extension in _VERIFICATION_EXTENSIONS:
        return True
    technical = candidate.technical_metadata
    hint = str(technical.get("resource_family_hint") or "")
    if hint in {"signature", "checksum", "sbom", "verification"}:
        return True
    text = " ".join(
        value
        for value in (
            candidate.display_name,
            candidate.filename,
            candidate.anchor_text,
            candidate.nearby_text,
        )
        if value
    )
    return bool(_VERIFICATION_WORDS.search(text))


def _dedupe_nearby_context(
    candidates: list[EvidenceCandidate],
) -> tuple[list[EvidenceCandidate], list[dict[str, str]]]:
    normalized = [
        _normalize_text(candidate.nearby_text or "")
        for candidate in candidates
    ]
    counts = Counter(value for value in normalized if len(value) >= 24)
    repeated = {value for value, count in counts.items() if count >= 2}
    if not repeated:
        return candidates, []

    context_ids: dict[str, str] = {}
    contexts: list[dict[str, str]] = []
    result: list[EvidenceCandidate] = []
    for candidate, normalized_text in zip(candidates, normalized, strict=True):
        if normalized_text not in repeated or not candidate.nearby_text:
            result.append(candidate)
            continue
        context_id = context_ids.get(normalized_text)
        if context_id is None:
            context_id = f"ctx_{len(context_ids) + 1}"
            context_ids[normalized_text] = context_id
            contexts.append({"id": context_id, "text": candidate.nearby_text})
        result.append(
            candidate.model_copy(
                update={"nearby_text": None, "context_ref": context_id}
            )
        )
    return result, contexts


def _merge_provenance(members: list[EvidenceCandidate]) -> list[dict[str, str | None]]:
    result: list[dict[str, str | None]] = []
    seen: set[tuple[str | None, str | None, str | None]] = set()
    for member in members:
        for item in member.capture_provenance:
            key = (item.get("channel"), item.get("source_tag"), item.get("attribute"))
            if key in seen:
                continue
            seen.add(key)
            result.append(item)
    return result[:8]


def _short(value: str | None, limit: int) -> str | None:
    if not value:
        return None
    compact = " ".join(value.split())
    if len(compact) <= limit:
        return compact
    return f"{compact[: limit - 1].rstrip()}…"


def _normalize_text(value: str) -> str:
    return " ".join(value.lower().split())


def _unique_strings(values) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        clean = value.strip()
        if not clean or clean in seen:
            continue
        seen.add(clean)
        result.append(clean)
    return result
