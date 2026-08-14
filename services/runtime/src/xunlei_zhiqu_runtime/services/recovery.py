from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import json
import logging
from pathlib import Path
import time
from typing import Any, Literal
from urllib.parse import unquote, urlsplit
from uuid import uuid4

import httpx
from pydantic import BaseModel, Field

from xunlei_zhiqu_runtime.models import CaptureBatch, ResourceJobSnapshot
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter
from xunlei_zhiqu_runtime.services import job_store as job_store_module
from xunlei_zhiqu_runtime.services.diagnosis import DiagnosisDecision, DiagnosisService
from xunlei_zhiqu_runtime.services.download_executor import DownloadExecutionAsset, DownloadExecutionStatus
from xunlei_zhiqu_runtime.services.download_state_store import DownloadStateStore
from xunlei_zhiqu_runtime.services.recovery_http_executor import RecoverableHttpDownloadExecutor, SourceVerificationResult

logger = logging.getLogger("uvicorn.error")
RecoveryPhase = Literal["opening_source_page", "matching_candidates", "verifying_candidate", "manual_selection", "switching_source", "completed", "failed"]


class RecoveryCandidateView(BaseModel):
    candidate_id: str
    label: str
    match: Literal["high", "possible", "reject", "unknown"] = "unknown"
    reason: str | None = None
    verification: Literal["pending", "sample_match", "size_and_range", "mismatch", "range_unsupported", "unavailable"] = "pending"
    message: str | None = None


class PendingRecoveryView(BaseModel):
    recovery_id: str
    job_id: str
    asset_id: str
    resource_title: str
    resource_type: str
    variant_summary: str
    downloaded_bytes: int = Field(ge=0)
    total_bytes: int = Field(ge=0)
    progress: float = Field(ge=0, le=100)
    phase: RecoveryPhase
    message: str
    original_page_url: str | None = None
    candidates: list[RecoveryCandidateView] = Field(default_factory=list)


class RecoveryHandoff(BaseModel):
    resumed: bool
    job_id: str
    recovery_id: str | None = None
    page_url: str | None = None
    message: str


class RecoveryCaptureRequest(BaseModel):
    schema_version: Literal["0.1"] = "0.1"
    capture: CaptureBatch


class RecoveryCaptureResult(BaseModel):
    resumed: bool
    recovery: PendingRecoveryView
    message: str


class RecoveryCandidateChoiceResult(BaseModel):
    resumed: bool
    recovery: PendingRecoveryView
    message: str


@dataclass(frozen=True, slots=True)
class _NodeBCandidate:
    candidate_id: str
    confidence: str
    reason: str


@dataclass(frozen=True, slots=True)
class _NodeBResult:
    ranked: tuple[_NodeBCandidate, ...]
    rejected: tuple[_NodeBCandidate, ...]


class RecoveryService:
    def __init__(self, *, provider: ModelProviderAdapter, executor: RecoverableHttpDownloadExecutor, state_store: DownloadStateStore, diagnosis: DiagnosisService | None = None) -> None:
        self.provider = provider
        self.executor = executor
        self.state_store = state_store
        self.diagnosis = diagnosis or DiagnosisService()
        self._contexts: dict[str, dict[str, Any]] = {}
        self._retry_counts: dict[str, int] = {}
        self._load_persisted_recovery_state()

    def diagnosis_for(self, job_id: str, status: DownloadExecutionStatus, asset: DownloadExecutionAsset | None) -> DiagnosisDecision:
        return self.diagnosis.decide(status, asset, same_source_retry_count=self._retry_counts.get(job_id, 0))

    def mark_waiting_for_source(self, job_id: str, decision: DiagnosisDecision) -> ResourceJobSnapshot | None:
        job = job_store_module.get_job(job_id)
        if job is None or job.status == "completed":
            return job
        issue = {
            "source_unavailable": "原下载来源已不可用，已有进度已保留",
            "auth_or_link_expired": "原下载链接已失效，已有进度已保留",
            "source_changed": "原来源内容已变化，不能直接拼接已有进度",
            "range_unavailable": "原来源无法继续断点续传，已有进度已保留",
        }.get(decision.reason, "当前来源不可继续，已有进度已保留")
        return self._update_public_job(job_id, status="waiting_for_source", stage_label="来源不可用", issue=issue, next_action="continue_acquisition", speed_bytes_per_second=0, eta_seconds=None)

    def note_same_source_retry(self, job_id: str, status: DownloadExecutionStatus) -> None:
        if status.failure_kind != "http_error" or status.http_status_code not in {500, 502, 503, 504}:
            return
        count = self._retry_counts.get(job_id, 0) + 1
        self._retry_counts[job_id] = count
        self.state_store.patch_job(job_id, {"same_source_retry_count": count})

    async def continue_acquisition(self, job_id: str) -> RecoveryHandoff:
        job = job_store_module.get_job(job_id)
        if job is None:
            raise ValueError("下载任务不存在")
        request = await self.executor.execution_request(job_id)
        status = await self.executor.status(job_id)
        if request is None or status is None:
            raise ValueError("下载执行状态不存在")
        asset = _active_asset(request.assets, status.current_asset_id)
        if asset is None:
            raise ValueError("没有可恢复的下载文件")
        self._update_public_job(job_id, stage_label="正在检查来源…", issue=None, next_action=None)

        current_check = await self.executor.verify_source(job_id, asset.asset_id, asset.primary_source)
        if current_check.verified:
            await self.executor.switch_source(job_id, asset.asset_id, asset.primary_source, current_check)
            await self.executor.resume(job_id)
            self._append_history(job_id, "same_source_recovered", current_check.method, asset.downloaded_bytes)
            return RecoveryHandoff(resumed=True, job_id=job_id, message="原来源已经恢复，正在继续下载")

        for source in asset.alternate_sources:
            verification = await self.executor.verify_source(job_id, asset.asset_id, source)
            if not verification.verified:
                continue
            await self.executor.switch_source(job_id, asset.asset_id, source, verification)
            await self.executor.resume(job_id)
            self._append_history(job_id, "alternate_source_selected", verification.method, asset.downloaded_bytes)
            return RecoveryHandoff(resumed=True, job_id=job_id, message="已验证备用来源，正在继续下载")

        context = self._context_for(job, asset, status)
        self._contexts[context["recovery_id"]] = context
        self._persist_context(context)
        self._update_public_job(job_id, stage_label="正在寻找新的下载地址…", issue="已有进度已保留，请在打开的资源页继续智取", next_action=None)
        return RecoveryHandoff(resumed=False, job_id=job_id, recovery_id=context["recovery_id"], page_url=context.get("original_page_url"), message="已准备重新智取，请在浏览器资源页继续")

    def pending(self) -> list[PendingRecoveryView]:
        contexts = [value for value in self._contexts.values() if value.get("phase") not in {"completed", "failed"}]
        contexts.sort(key=lambda value: value.get("created_at", ""), reverse=True)
        return [self._public_context(value) for value in contexts]

    async def submit_capture(self, recovery_id: str, capture: CaptureBatch) -> RecoveryCaptureResult:
        context = self._require_context(recovery_id)
        if context.get("phase") == "completed":
            return RecoveryCaptureResult(resumed=True, recovery=self._public_context(context), message="原任务已经恢复")
        candidates = _capture_candidates(capture)
        if not candidates:
            context.update(phase="manual_selection", message="当前页面没有发现可验证的 HTTP 下载项", candidates=[], candidate_sources={})
            self._persist_context(context)
            return RecoveryCaptureResult(resumed=False, recovery=self._public_context(context), message=context["message"])

        context["phase"] = "matching_candidates"
        context["message"] = f"当前页面发现 {len(candidates)} 个可用下载项，正在匹配…"
        context["candidate_sources"] = {item["candidate_id"]: item["source"] for item in candidates}
        context["candidate_summaries"] = [{key: value for key, value in item.items() if key != "source"} for item in candidates]
        self._persist_context(context)

        try:
            node_b = await _match_with_node_b(self.provider, context, candidates)
        except Exception as exc:
            logger.warning("node_b_failed recovery_id=%s job_id=%s error=%s", recovery_id, context["job_id"], exc.__class__.__name__)
            context["phase"] = "manual_selection"
            context["message"] = f"找到 {len(candidates)} 项下载内容，可手动选择后验证"
            context["candidates"] = [_candidate_view(item, "unknown", None).model_dump(mode="json") for item in candidates]
            self._persist_context(context)
            return RecoveryCaptureResult(resumed=False, recovery=self._public_context(context), message=context["message"])

        by_id = {item["candidate_id"]: item for item in candidates}
        views: dict[str, RecoveryCandidateView] = {}
        for item in node_b.ranked:
            source_item = by_id.get(item.candidate_id)
            if source_item is None:
                continue
            views[item.candidate_id] = _candidate_view(source_item, "high" if item.confidence == "high" else "possible", item.reason)
        for item in node_b.rejected:
            source_item = by_id.get(item.candidate_id)
            if source_item is not None:
                views[item.candidate_id] = _candidate_view(source_item, "reject", item.reason)
        for source_item in candidates:
            views.setdefault(source_item["candidate_id"], _candidate_view(source_item, "unknown", None))

        context["phase"] = "verifying_candidate"
        context["message"] = "正在验证新来源…"
        context["candidates"] = [view.model_dump(mode="json") for view in views.values()]
        self._persist_context(context)

        verified_choice: tuple[str, SourceVerificationResult] | None = None
        for item in node_b.ranked[:6]:
            source = context["candidate_sources"].get(item.candidate_id)
            if not isinstance(source, str):
                continue
            verification = await self.executor.verify_source(context["job_id"], context["asset_id"], source)
            views[item.candidate_id] = _with_verification(views[item.candidate_id], verification)
            if verified_choice is None and verification.verified:
                verified_choice = (item.candidate_id, verification)

        context["candidates"] = [view.model_dump(mode="json") for view in views.values()]
        self._persist_context(context)
        if verified_choice is not None:
            candidate_id, verification = verified_choice
            await self._switch_and_resume(context, candidate_id, verification)
            return RecoveryCaptureResult(resumed=True, recovery=self._public_context(context), message="已找到可用来源，正在继续下载")

        context["phase"] = "manual_selection"
        context["message"] = "没有找到可安全接续已有进度的来源，可继续寻找或手动选择验证"
        self._persist_context(context)
        return RecoveryCaptureResult(resumed=False, recovery=self._public_context(context), message=context["message"])

    async def choose_candidate(self, recovery_id: str, candidate_id: str) -> RecoveryCandidateChoiceResult:
        context = self._require_context(recovery_id)
        source = context.get("candidate_sources", {}).get(candidate_id)
        if not isinstance(source, str):
            raise ValueError("恢复候选不存在")
        context["phase"] = "verifying_candidate"
        context["message"] = "正在验证新来源…"
        self._persist_context(context)
        verification = await self.executor.verify_source(context["job_id"], context["asset_id"], source)
        views = {item["candidate_id"]: RecoveryCandidateView.model_validate(item) for item in context.get("candidates", []) if isinstance(item, dict) and isinstance(item.get("candidate_id"), str)}
        current = views.get(candidate_id) or RecoveryCandidateView(candidate_id=candidate_id, label=candidate_id)
        views[candidate_id] = _with_verification(current, verification)
        context["candidates"] = [value.model_dump(mode="json") for value in views.values()]
        if verification.verified:
            await self._switch_and_resume(context, candidate_id, verification)
            return RecoveryCandidateChoiceResult(resumed=True, recovery=self._public_context(context), message="来源验证通过，正在继续原任务")
        context["phase"] = "manual_selection"
        context["message"] = verification.detail or "此来源不能安全接续已有进度"
        self._persist_context(context)
        return RecoveryCandidateChoiceResult(resumed=False, recovery=self._public_context(context), message=context["message"])

    async def _switch_and_resume(self, context: dict[str, Any], candidate_id: str, verification: SourceVerificationResult) -> None:
        source = context["candidate_sources"][candidate_id]
        context["phase"] = "switching_source"
        context["message"] = "已找到可用来源，正在继续下载"
        self._persist_context(context)
        await self.executor.switch_source(context["job_id"], context["asset_id"], source, verification)
        request = await self.executor.execution_request(context["job_id"])
        asset = _active_asset(request.assets, context["asset_id"]) if request else None
        offset = asset.downloaded_bytes if asset else context.get("downloaded_bytes", 0)
        self._append_history(context["job_id"], "source_switched", verification.method, int(offset or 0))
        await self.executor.resume(context["job_id"])
        context["phase"] = "completed"
        context["message"] = "已找到可用来源，继续下载"
        context["completed_at"] = datetime.now(UTC).isoformat()
        context["selected_candidate_id"] = candidate_id
        self._persist_context(context)
        self._append_history(context["job_id"], "recovery_completed", verification.method, int(offset or 0))

    def _context_for(self, job: ResourceJobSnapshot, asset: DownloadExecutionAsset, status: DownloadExecutionStatus) -> dict[str, Any]:
        private = job_store_module.get_private_job_context(job.job_id)
        page_url = job.source_page
        page_title = None
        target_attributes: dict[str, Any] = {}
        confirmed_summary = list(job.selected_items)
        if private and private[0] == "resource":
            payload = private[1]
            if payload.capture:
                page_url = payload.capture.page.url
                page_title = payload.capture.page.title
            confirmed = set(payload.confirmed_item_ids)
            for group in (payload.plan.selected, payload.plan.alternatives, payload.plan.uncertainties):
                for item in group:
                    if item.item_id in confirmed:
                        target_attributes.update(item.technical_attributes)
        variant_summary = " · ".join(confirmed_summary[:3]) or asset.label
        total = asset.expected_bytes or status.total_bytes or job.total_bytes
        return {
            "recovery_id": f"recovery_{uuid4().hex[:12]}", "job_id": job.job_id, "asset_id": asset.asset_id,
            "resource_title": job.title, "resource_type": job.resource_type, "variant_summary": variant_summary,
            "target_attributes": _safe_target_attributes(target_attributes), "original_page_url": page_url,
            "original_page_title": page_title, "original_source": asset.primary_source, "expected_total": int(total or 0),
            "downloaded_bytes": int(asset.downloaded_bytes), "failure_reason": status.failure_kind or "unknown",
            "confirmed_summary": confirmed_summary[:5], "phase": "opening_source_page",
            "message": "正在当前页面寻找可用下载地址…", "candidate_sources": {}, "candidate_summaries": [],
            "candidates": [], "created_at": datetime.now(UTC).isoformat(),
        }

    def _public_context(self, context: dict[str, Any]) -> PendingRecoveryView:
        total = int(context.get("expected_total") or 0); downloaded = int(context.get("downloaded_bytes") or 0)
        progress = min(100.0, downloaded / total * 100) if total > 0 else 0.0
        return PendingRecoveryView(recovery_id=context["recovery_id"], job_id=context["job_id"], asset_id=context["asset_id"], resource_title=context.get("resource_title") or "下载任务", resource_type=context.get("resource_type") or "unknown", variant_summary=context.get("variant_summary") or "已确认资源", downloaded_bytes=downloaded, total_bytes=total, progress=round(progress, 1), phase=context.get("phase") or "opening_source_page", message=context.get("message") or "正在寻找可用来源", original_page_url=context.get("original_page_url"), candidates=[RecoveryCandidateView.model_validate(item) for item in context.get("candidates", []) if isinstance(item, dict)])

    def _persist_context(self, context: dict[str, Any]) -> None:
        self.state_store.patch_job(context["job_id"], {"recovery_context": context})

    def _append_history(self, job_id: str, event: str, verification_method: str | None, resume_offset: int) -> None:
        record = self.state_store.get_job(job_id) or {}; history = record.get("recovery_history")
        if not isinstance(history, list): history = []
        history.append({"at": datetime.now(UTC).isoformat(), "event": event, "verification_method": verification_method, "resume_offset": resume_offset})
        self.state_store.patch_job(job_id, {"recovery_history": history[-20:]})

    def _load_persisted_recovery_state(self) -> None:
        for record in self.state_store.load_jobs():
            snapshot = record.get("snapshot")
            if not isinstance(snapshot, dict) or not isinstance(snapshot.get("job_id"), str): continue
            job_id = snapshot["job_id"]; context = record.get("recovery_context")
            if isinstance(context, dict) and isinstance(context.get("recovery_id"), str): self._contexts[context["recovery_id"]] = context
            count = record.get("same_source_retry_count")
            if isinstance(count, int) and count >= 0: self._retry_counts[job_id] = count

    def _require_context(self, recovery_id: str) -> dict[str, Any]:
        context = self._contexts.get(recovery_id)
        if context is None: raise ValueError("续取上下文不存在或已失效")
        return context

    def _update_public_job(self, job_id: str, **updates: Any) -> ResourceJobSnapshot | None:
        index = job_store_module._find_index(job_id)
        if index is None: return None
        updated = job_store_module._jobs[index].model_copy(update=updates)
        job_store_module._jobs[index] = updated
        job_store_module._persist_job(job_id)
        return updated


def _active_asset(assets: tuple[DownloadExecutionAsset, ...], current_asset_id: str | None) -> DownloadExecutionAsset | None:
    if current_asset_id:
        for asset in assets:
            if asset.asset_id == current_asset_id: return asset
    return next((asset for asset in assets if not asset.completed), assets[0] if assets else None)


def _capture_candidates(capture: CaptureBatch) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for candidate in capture.candidates:
        value = candidate.value.strip(); parts = urlsplit(value)
        if parts.scheme.lower() not in {"http", "https"}: continue
        probe = candidate.probe_facts; filename = unquote(parts.path.rstrip("/").rsplit("/", 1)[-1]) if parts.path else None
        label = candidate.display_name or candidate.anchor_text or filename or f"下载项 {len(result) + 1}"
        result.append({"candidate_id": candidate.candidate_id, "source": value, "label": _short(label, 120), "filename": _short(filename, 120) if filename else None, "content_type": probe.content_type if probe else None, "size": probe.content_length if probe else None, "nearby": _short(candidate.nearby_text, 140), "section": _short(candidate.section_heading, 100)})
    return result[:24]


def _candidate_view(item: dict[str, Any], match: Literal["high", "possible", "reject", "unknown"], reason: str | None) -> RecoveryCandidateView:
    return RecoveryCandidateView(candidate_id=item["candidate_id"], label=item.get("label") or item["candidate_id"], match=match, reason=_short(reason, 120))


def _with_verification(view: RecoveryCandidateView, result: SourceVerificationResult) -> RecoveryCandidateView:
    verification = {"verified": result.method or "sample_match", "mismatch": "mismatch", "range_unsupported": "range_unsupported", "unavailable": "unavailable", "local_error": "unavailable"}.get(result.status, "unavailable")
    return view.model_copy(update={"verification": verification, "message": result.detail})


async def _match_with_node_b(provider: ModelProviderAdapter, context: dict[str, Any], candidates: list[dict[str, Any]]) -> _NodeBResult:
    core = getattr(provider, "_inner", provider)
    client = getattr(core, "_client", None); api_adapter = getattr(core, "_api_adapter", None); model = getattr(core, "_model", None)
    if client is None or api_adapter is None or not isinstance(model, str): raise RuntimeError("当前模型 Provider 不支持 Node B 结构化匹配")
    request_document = {"target": {"title": context.get("resource_title"), "type": context.get("resource_type"), "variant": context.get("variant_summary"), "attributes": context.get("target_attributes") or {}, "expected_size": context.get("expected_total") or None}, "original": {"failure": context.get("failure_reason"), "downloaded_bytes": context.get("downloaded_bytes")}, "candidates": [{key: value for key, value in item.items() if key != "source" and value not in (None, "")} for item in candidates]}
    system_prompt = "你是迅雷智取的节点 B，只负责判断新页面候选与原已确认资源的语义身份是否匹配。不要决定下载执行、不要决定是否拼接旧字节、不要生成 URL。只依据 target/original/candidates 中的事实。输出 JSON：matches 为高概率匹配对象数组，possible 为可能匹配对象数组，reject 为明显不匹配对象数组；每个对象只含 candidate_id、reason，matches 可额外 confidence=high。理由保持一句话。"
    user_content = json.dumps(request_document, ensure_ascii=False, separators=(",", ":"))
    payload: dict[str, object] = {"model": model, "temperature": 0.1, "max_completion_tokens": 512, "response_format": {"type": "json_object"}, "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_content}]}
    payload.update(api_adapter.request_overrides(model=model))
    started = time.perf_counter(); logger.info("node_b_request model=%s candidates=%s prompt_chars=%s max_completion_tokens=512", model, len(candidates), len(user_content))
    try: response = await client.post("chat/completions", json=payload)
    except httpx.RequestError as exc: raise RuntimeError("Node B 模型请求失败") from exc
    total_ms = int((time.perf_counter() - started) * 1000); response.raise_for_status(); body = response.json(); choice = body["choices"][0]
    content, _ = api_adapter.response_content(choice.get("message"))
    if not content: raise RuntimeError("Node B 返回空结果")
    parsed = json.loads(_strip_fences(content))
    if not isinstance(parsed, dict): raise RuntimeError("Node B 结果不是 JSON object")
    usage = api_adapter.usage(body); logger.info("node_b_metrics model=%s input_tokens=%s output_tokens=%s ttft_ms=na generation_ms=na total_ms=%s", model, usage.input_tokens, usage.output_tokens, total_ms)
    valid_ids = {item["candidate_id"] for item in candidates}; ranked: list[_NodeBCandidate] = []; rejected: list[_NodeBCandidate] = []; seen: set[str] = set()
    for group_name, confidence, target in (("matches", "high", ranked), ("possible", "possible", ranked), ("reject", "reject", rejected)):
        raw_items = parsed.get(group_name, [])
        if not isinstance(raw_items, list): continue
        for raw in raw_items:
            candidate_id: str | None = None; reason = ""
            if isinstance(raw, str): candidate_id = raw
            elif isinstance(raw, dict):
                value = raw.get("candidate_id"); candidate_id = value if isinstance(value, str) else None
                if isinstance(raw.get("reason"), str): reason = raw["reason"]
            if candidate_id not in valid_ids or candidate_id in seen: continue
            seen.add(candidate_id); target.append(_NodeBCandidate(candidate_id, confidence, _short(reason, 120) or "语义匹配"))
    return _NodeBResult(tuple(ranked), tuple(rejected))


def _safe_target_attributes(value: dict[str, Any]) -> dict[str, Any]:
    allowed = {"version", "platform", "os", "architecture", "arch", "package", "package_type", "format", "media_type", "resolution", "quality", "language"}; result: dict[str, Any] = {}
    for key, item in value.items():
        if str(key).lower() in allowed and (isinstance(item, (str, int, float, bool)) or item is None): result[str(key)] = item
    return result


def _strip_fences(value: str) -> str:
    text = value.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3: return "\n".join(lines[1:-1]).strip()
    return text


def _short(value: object, limit: int) -> str | None:
    if not isinstance(value, str): return None
    compact = " ".join(value.split())
    if not compact: return None
    return compact if len(compact) <= limit else f"{compact[: limit - 1]}…"
