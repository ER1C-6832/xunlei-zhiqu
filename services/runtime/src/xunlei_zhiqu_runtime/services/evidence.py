from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlparse

from xunlei_zhiqu_runtime.models import CaptureBatch, EvidenceCandidate, EvidencePack
from xunlei_zhiqu_runtime.services.evidence_reducer import (
    EvidenceReductionStats,
    reduce_evidence_candidates,
)


_SAFE_METADATA_KEYS = {
    "source_tag",
    "media_kind",
    "mime_type",
    "controls",
    "duration_seconds",
    "video_width",
    "video_height",
    "dynamic_media_signal",
    "directly_downloadable",
    "network_observed",
    "content_disposition",
    "request_type",
    "image_source",
    "natural_width",
    "natural_height",
    "rendered_width",
    "rendered_height",
    "srcset_descriptor",
    "possible_original",
    "download_attribute",
    "rel",
    "target",
    "aria_label",
    "resource_family_hint",
    "resource_family_ambiguous",
    "resource_family_candidates",
}


@dataclass(frozen=True, slots=True)
class CompiledEvidence:
    pack: EvidencePack
    stats: EvidenceReductionStats


def build_evidence_pack(batch: CaptureBatch) -> EvidencePack:
    """Backward-compatible helper for callers that only need the sanitized pack."""
    return compile_evidence_pack(batch).pack


def compile_evidence_pack(batch: CaptureBatch) -> CompiledEvidence:
    raw_candidates = [_candidate_evidence(candidate) for candidate in batch.candidates]
    automatic = batch.trigger == "automatic" and not (
        batch.selection and batch.selection.type in {"rectangle", "click", "manual"}
    )
    reduced = reduce_evidence_candidates(raw_candidates, automatic=automatic)
    relevant_sections = _compact_relevant_sections(batch.page.relevant_text)

    page: dict[str, Any] = {
        "title": batch.page.title,
        "relevant_sections": relevant_sections,
    }
    if reduced.contexts:
        page["contexts"] = reduced.contexts

    return CompiledEvidence(
        pack=EvidencePack(
            batch_id=batch.batch_id,
            page=page,
            selection=(
                {
                    "type": batch.selection.type,
                    "candidate_ids": batch.selection.candidate_ids,
                    "rect": batch.selection.rect.model_dump(mode="json") if batch.selection.rect else None,
                }
                if batch.selection
                else None
            ),
            device=batch.device.model_dump(mode="json") if batch.device else None,
            candidates=reduced.candidates,
        ),
        stats=reduced.stats,
    )


def _candidate_evidence(candidate) -> EvidenceCandidate:
    metadata = candidate.metadata or {}
    filename = _filename(candidate, metadata)
    extension = _extension(filename, metadata)
    provenance = _provenance(candidate.capture_channel, metadata)
    technical: dict[str, Any] = {}

    for key in _SAFE_METADATA_KEYS:
        value = _safe_metadata_value(metadata.get(key))
        if value is not None:
            technical[key] = value

    if candidate.probe_facts:
        probe = {
            "content_type": candidate.probe_facts.content_type,
            "content_length": candidate.probe_facts.content_length,
            "reachable": candidate.probe_facts.reachable,
            "range_supported": candidate.probe_facts.range_supported,
        }
        technical.update({key: value for key, value in probe.items() if value is not None})

    return EvidenceCandidate(
        id=candidate.candidate_id,
        candidate_ids=[candidate.candidate_id],
        candidate_type=candidate.candidate_type,
        display_name=candidate.display_name,
        filename=filename,
        extension=extension,
        anchor_text=candidate.anchor_text,
        nearby_text=candidate.nearby_text,
        section_heading=candidate.section_heading,
        selection_overlap=candidate.selection_overlap,
        capture_provenance=provenance,
        technical_metadata=technical,
    )


def _filename(candidate, metadata: dict[str, Any]) -> str | None:
    if isinstance(metadata.get("filename"), str) and metadata["filename"].strip():
        return metadata["filename"].strip()
    if candidate.display_name and "." in candidate.display_name:
        return candidate.display_name
    if candidate.value.startswith(("http://", "https://")):
        path = urlparse(candidate.value).path
        name = PurePosixPath(path).name
        return unquote(name) if name else None
    return candidate.display_name


def _extension(filename: str | None, metadata: dict[str, Any]) -> str | None:
    if isinstance(metadata.get("extension"), str) and metadata["extension"].strip():
        return metadata["extension"].strip().lower().lstrip(".")
    if not filename or "." not in filename:
        return None
    suffix = filename.rsplit(".", 1)[-1].lower()
    return suffix if 1 <= len(suffix) <= 12 and suffix.isalnum() else None


def _provenance(channel: str, metadata: dict[str, Any]) -> list[dict[str, str | None]]:
    raw = metadata.get("capture_provenance")
    result: list[dict[str, str | None]] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            source_channel = item.get("channel")
            if not isinstance(source_channel, str):
                continue
            result.append(
                {
                    "channel": source_channel,
                    "source_tag": item.get("source_tag") if isinstance(item.get("source_tag"), str) else None,
                    "attribute": item.get("attribute") if isinstance(item.get("attribute"), str) else None,
                }
            )
    return result or [{"channel": channel, "source_tag": None, "attribute": None}]


def _safe_metadata_value(value: Any) -> Any | None:
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        result = [item for item in value[:16] if isinstance(item, (str, int, float, bool))]
        return result or None
    if isinstance(value, dict):
        result = {
            str(key): item
            for key, item in list(value.items())[:16]
            if isinstance(item, (str, int, float, bool)) or item is None
        }
        return result or None
    return None


def _compact_relevant_sections(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        compact = " ".join(value.split())
        if not compact:
            continue
        if len(compact) > 220:
            compact = f"{compact[:219].rstrip()}…"
        key = compact.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(compact)
        if len(result) >= 12:
            break
    return result
