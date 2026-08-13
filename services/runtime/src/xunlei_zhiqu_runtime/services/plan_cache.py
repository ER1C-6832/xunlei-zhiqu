from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import json
import time
from uuid import uuid4

from xunlei_zhiqu_runtime.models import EvidencePack, ResourcePlan


@dataclass(slots=True)
class _CacheEntry:
    expires_at: float
    plan: ResourcePlan


class ResourcePlanCache:
    """Small in-process TTL/LRU cache for repeated Node A analysis.

    The key is built only from sanitized EvidencePack content plus the provider
    cache namespace. Raw CaptureBatch URLs and credentials never enter this cache.
    """

    def __init__(self, *, ttl_seconds: float = 1200.0, max_entries: int = 64) -> None:
        self._ttl_seconds = max(1.0, ttl_seconds)
        self._max_entries = max(1, max_entries)
        self._entries: OrderedDict[str, _CacheEntry] = OrderedDict()

    def make_key(self, evidence_pack: EvidencePack, *, namespace: str) -> str:
        payload = evidence_pack.model_dump(mode="json", exclude_none=True)
        payload.pop("batch_id", None)
        canonical = json.dumps(
            {"namespace": namespace, "evidence": payload},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def get(self, key: str, *, batch_id: str) -> ResourcePlan | None:
        self._prune_expired()
        entry = self._entries.get(key)
        if entry is None:
            return None
        if entry.expires_at <= time.monotonic():
            self._entries.pop(key, None)
            return None
        self._entries.move_to_end(key)
        return entry.plan.model_copy(
            deep=True,
            update={
                "batch_id": batch_id,
                "plan_id": f"plan_{uuid4().hex[:12]}",
            },
        )

    def put(self, key: str, plan: ResourcePlan) -> None:
        self._prune_expired()
        self._entries[key] = _CacheEntry(
            expires_at=time.monotonic() + self._ttl_seconds,
            plan=plan.model_copy(deep=True),
        )
        self._entries.move_to_end(key)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)

    def _prune_expired(self) -> None:
        now = time.monotonic()
        expired = [key for key, entry in self._entries.items() if entry.expires_at <= now]
        for key in expired:
            self._entries.pop(key, None)
