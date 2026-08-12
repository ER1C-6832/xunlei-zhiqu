from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlparse

from xunlei_zhiqu_runtime.models import CaptureBatch, EvidenceCandidate, EvidencePack


_SAFE_METADATA_KEYS = {
    "source_tag",
    "media_kind",
    "mime_type",
    "controls",
    "duration_seconds",
    "video_width",
    "video_height",
    "download_attribute",
    "rel",
    "target",
    "aria_label",
    "resource_family_hint",
    "resource_family_ambiguous",
    "resource_family_candidates",
}


def build_evidence_pack(batch: CaptureBatch) -> EvidencePack:
    return EvidencePack(
        batch_id=batch.batch_id,
        page={
            "title": batch.page.title,
            "relevant_sections": batch.page.relevant_text[:24],
        },
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
        candidates=[_candidate_evidence(candidate) for candidate in batch.candidates],
    )


def _candidate_evidence(candidate) -> EvidenceCandidate:
    metadata = candidate.metadata or {}
    filename = _filename(candidate, metadata)
    extension = _extension(filename, metadata)
    provenance = _provenance(candidate.capture_channel, metadata)
    technical: dict[str, str | int | float | bool | None] = {}

    for key in _SAFE_METADATA_KEYS:
        value = metadata.get(key)
        if isinstance(value, (str, int, float, bool)) or value is None:
            technical[key] = value

    if candidate.probe_facts:
        technical.update(
            {
                "content_type": candidate.probe_facts.content_type,
                "content_length": candidate.probe_facts.content_length,
                "reachable": candidate.probe_facts.reachable,
                "range_supported": candidate.probe_facts.range_supported,
            }
        )

    return EvidenceCandidate(
        id=candidate.candidate_id,
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
    return suffix if 1 <= len(suffix) <= 16 and suffix.isalnum() else None


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
