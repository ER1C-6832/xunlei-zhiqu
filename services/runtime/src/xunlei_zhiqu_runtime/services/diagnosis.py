from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from xunlei_zhiqu_runtime.services.download_executor import (
    DownloadExecutionAsset,
    DownloadExecutionStatus,
)

RecoveryAction = Literal[
    "retry_same_source",
    "resume_same_source",
    "fix_local_issue",
    "reacquire_source",
    "stop",
]
DiagnosisReason = Literal[
    "source_unavailable",
    "auth_or_link_expired",
    "source_changed",
    "network_interrupted",
    "disk_full",
    "permission_denied",
    "range_unavailable",
    "local_path_issue",
    "download_stopped",
]


@dataclass(frozen=True, slots=True)
class DiagnosisDecision:
    action: RecoveryAction
    reason: DiagnosisReason


class DiagnosisService:
    """Deterministic failure routing. No model call is allowed here."""

    def decide(
        self,
        status: DownloadExecutionStatus,
        asset: DownloadExecutionAsset | None,
        *,
        same_source_retry_count: int = 0,
    ) -> DiagnosisDecision:
        if status.state != "failed":
            return DiagnosisDecision("stop", "download_stopped")

        if status.failure_kind == "runtime_interrupted":
            return DiagnosisDecision(
                "resume_same_source" if status.resume_available else "retry_same_source",
                "network_interrupted",
            )

        if status.failure_kind == "connection_interrupted":
            if same_source_retry_count < 1:
                return DiagnosisDecision(
                    "resume_same_source" if status.resume_available else "retry_same_source",
                    "network_interrupted",
                )
            return DiagnosisDecision("reacquire_source", "network_interrupted")

        if status.failure_kind == "http_error":
            code = status.http_status_code
            if code in {404, 410}:
                return DiagnosisDecision("reacquire_source", "source_unavailable")
            if code in {401, 403}:
                return DiagnosisDecision("reacquire_source", "auth_or_link_expired")
            if code in {500, 502, 503, 504}:
                if same_source_retry_count < 1:
                    return DiagnosisDecision("retry_same_source", "network_interrupted")
                return DiagnosisDecision("reacquire_source", "source_unavailable")

        if status.failure_kind in {"remote_changed", "range_mismatch"}:
            return DiagnosisDecision("reacquire_source", "source_changed")

        if status.failure_kind == "range_unsupported":
            if asset is not None and asset.downloaded_bytes > 0:
                return DiagnosisDecision("reacquire_source", "range_unavailable")
            return DiagnosisDecision("stop", "range_unavailable")

        if status.failure_kind == "preflight":
            message = (status.error or "").lower()
            if "磁盘空间" in message:
                return DiagnosisDecision("fix_local_issue", "disk_full")
            if "权限" in message or "permission" in message:
                return DiagnosisDecision("fix_local_issue", "permission_denied")
            return DiagnosisDecision("fix_local_issue", "local_path_issue")

        if status.failure_kind == "local_io":
            return DiagnosisDecision("fix_local_issue", "local_path_issue")

        if status.failure_kind == "length_mismatch" and status.resume_available:
            return DiagnosisDecision("resume_same_source", "network_interrupted")

        return DiagnosisDecision("stop", "download_stopped")
