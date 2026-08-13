from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import re

from xunlei_zhiqu_runtime.models import EvidenceCandidate, EvidencePack, ResourcePlan
from xunlei_zhiqu_runtime.providers.base import (
    ModelAnalysisResult,
    ModelProgressSink,
    ModelProviderAdapter,
)


logger = logging.getLogger("uvicorn.error")
_URL_PREFIX_RE = re.compile(r"^https?://", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class EvidenceWireStats:
    before_chars: int
    after_chars: int

    @property
    def saved_chars(self) -> int:
        return max(0, self.before_chars - self.after_chars)

    @property
    def saved_percent(self) -> float:
        if self.before_chars <= 0:
            return 0.0
        return (self.saved_chars / self.before_chars) * 100.0


class EvidenceWireProvider(ModelProviderAdapter):
    """A/B wrapper that compacts only redundant model-facing evidence.

    The analyzer, cache key and deterministic validation continue to use the full
    sanitized EvidencePack. Candidate identities and decision-relevant facts are
    never removed. The wrapped provider receives a smaller equivalent pack.
    """

    def __init__(self, inner: ModelProviderAdapter) -> None:
        self._inner = inner
        self.name = inner.name

    @property
    def model_name(self) -> str:
        return self._inner.model_name

    @property
    def cache_namespace(self) -> str:
        return f"{self._inner.cache_namespace}:wire-v1"

    async def analyze(self, evidence_pack: EvidencePack) -> ResourcePlan:
        return (await self.analyze_with_metrics(evidence_pack)).plan

    async def analyze_with_metrics(
        self,
        evidence_pack: EvidencePack,
        *,
        progress: ModelProgressSink | None = None,
    ) -> ModelAnalysisResult:
        compact_pack, stats = compact_evidence_pack(evidence_pack)
        logger.info(
            "node_a_evidence_wire before_chars=%d after_chars=%d saved_chars=%d saved_pct=%.1f",
            stats.before_chars,
            stats.after_chars,
            stats.saved_chars,
            stats.saved_percent,
        )
        return await self._inner.analyze_with_metrics(compact_pack, progress=progress)

    async def aclose(self) -> None:
        await self._inner.aclose()


def compact_evidence_pack(evidence_pack: EvidencePack) -> tuple[EvidencePack, EvidenceWireStats]:
    before_chars = _serialized_chars(evidence_pack)
    selected_ids = _selection_ids(evidence_pack)
    rectangle_selection = bool(
        evidence_pack.selection and evidence_pack.selection.get("type") == "rectangle"
    )

    candidates = [
        _compact_candidate(
            candidate,
            selected_ids=selected_ids,
            rectangle_selection=rectangle_selection,
        )
        for candidate in evidence_pack.candidates
    ]

    selection = evidence_pack.selection
    if selection:
        # Geometry has already been resolved into candidate selection/overlap by
        # the deterministic capture layer. The model only needs scope + IDs.
        selection = {
            key: value
            for key, value in selection.items()
            if key != "rect" and value not in (None, [], {})
        }

    compact_pack = evidence_pack.model_copy(
        deep=True,
        update={
            "selection": selection,
            "candidates": candidates,
        },
    )
    after_chars = _serialized_chars(compact_pack)
    return compact_pack, EvidenceWireStats(before_chars=before_chars, after_chars=after_chars)


def _compact_candidate(
    candidate: EvidenceCandidate,
    *,
    selected_ids: set[str],
    rectangle_selection: bool,
) -> EvidenceCandidate:
    updates: dict[str, object] = {}

    # For a normal candidate `id` already carries the exact identity. Only group
    # evidence needs candidate_ids[] because it represents multiple originals.
    if candidate.candidate_ids == [candidate.id]:
        updates["candidate_ids"] = []

    display_name = _clean(candidate.display_name)
    filename = _clean(candidate.filename)
    anchor_text = _clean(candidate.anchor_text)
    nearby_text = _clean(candidate.nearby_text)

    if display_name and filename and _same(display_name, filename):
        updates["display_name"] = None
        display_name = None
    elif display_name and filename and _URL_PREFIX_RE.match(display_name):
        # A visible raw URL carries far fewer semantics than the already-derived
        # filename. Keep the filename and avoid sending the same path twice.
        updates["display_name"] = None
        display_name = None

    if anchor_text:
        if any(_same(anchor_text, value) for value in (display_name, filename) if value):
            updates["anchor_text"] = None
            anchor_text = None
        elif filename and _URL_PREFIX_RE.match(anchor_text):
            compact_anchor = _compact_url_anchor(anchor_text, filename)
            updates["anchor_text"] = compact_anchor
            anchor_text = compact_anchor

    if nearby_text and any(
        _same(nearby_text, value)
        for value in (display_name, filename, anchor_text, candidate.section_heading)
        if value
    ):
        updates["nearby_text"] = None

    # A 100% overlap is redundant when the deterministic selection already lists
    # the candidate. Partial overlaps remain because they carry useful evidence.
    if (
        rectangle_selection
        and candidate.id in selected_ids
        and candidate.selection_overlap is not None
        and candidate.selection_overlap >= 0.999
    ):
        updates["selection_overlap"] = None

    technical = dict(candidate.technical_metadata)
    for low_value_key in ("rel", "target"):
        technical.pop(low_value_key, None)
    if technical != candidate.technical_metadata:
        updates["technical_metadata"] = technical

    return candidate.model_copy(deep=True, update=updates)


def _compact_url_anchor(anchor_text: str, filename: str) -> str:
    lowered = anchor_text.lower()
    filename_lower = filename.lower()
    position = lowered.find(filename_lower)
    if position < 0:
        return filename
    suffix = anchor_text[position + len(filename) :].strip()
    if not suffix:
        return filename
    # Preserve short visible annotations such as `(sha256)` without resending the URL.
    suffix = " ".join(suffix.split())
    if len(suffix) > 96:
        suffix = f"{suffix[:95].rstrip()}…"
    return f"{filename} {suffix}".strip()


def _selection_ids(evidence_pack: EvidencePack) -> set[str]:
    selection = evidence_pack.selection or {}
    raw_ids = selection.get("candidate_ids")
    if not isinstance(raw_ids, list):
        return set()
    return {value for value in raw_ids if isinstance(value, str)}


def _same(left: str, right: str) -> bool:
    return " ".join(left.split()).casefold() == " ".join(right.split()).casefold()


def _clean(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    compact = " ".join(value.split())
    return compact or None


def _serialized_chars(evidence_pack: EvidencePack) -> int:
    return len(
        json.dumps(
            evidence_pack.model_dump(
                mode="json",
                exclude_none=True,
                exclude_defaults=True,
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )