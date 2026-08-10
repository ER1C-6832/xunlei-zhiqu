import re
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

from xunlei_zhiqu_runtime.models import (
    CaptureBatch,
    CapturedResourceCandidate,
    PlanItem,
    ResourcePlan,
    ScenarioRecommendation,
)
from xunlei_zhiqu_runtime.providers.base import ModelProviderAdapter


NOISE_NAMES = {
    "index.html",
    "index.htm",
    "home.html",
    "javascript:void(0)",
    "#",
}
ATTACHMENT_TERMS = ("language", "lang", "语言", "subtitle", "字幕", "checksum", "sha256", "校验")
PATCH_TERMS = ("patch", "update", "补丁", "增量")


class FixtureProvider(ModelProviderAdapter):
    name = "fixture"

    async def analyze(
        self,
        batch: CaptureBatch,
        evidence_pack: dict[str, Any],
    ) -> ResourcePlan:
        del evidence_pack
        device_os = batch.device.os if batch.device else "unknown"
        device_arch = batch.device.arch if batch.device else "unknown"

        selected: list[PlanItem] = []
        alternatives: list[PlanItem] = []
        excluded: list[PlanItem] = []
        uncertainties: list[PlanItem] = []

        scored: list[tuple[int, CapturedResourceCandidate]] = []
        for candidate in batch.candidates:
            text = self._candidate_text(candidate)
            lower = text.lower()
            path_name = self._display_name(candidate).lower()
            content_length = candidate.probe_facts.content_length if candidate.probe_facts else None

            if (
                candidate.value.lower().startswith("javascript:")
                or path_name in NOISE_NAMES
                or content_length == 0
                or candidate.candidate_type == "page"
            ):
                excluded.append(
                    self._item(
                        candidate,
                        role="excluded",
                        label=self._display_name(candidate),
                        explanation="这是页面导航或无有效内容的候选，不作为下载资源。",
                        reason="确定性 Selection Hygiene：导航页、脚本地址或 0 B 候选。",
                    )
                )
                continue

            if any(term in lower for term in PATCH_TERMS):
                uncertainties.append(
                    self._item(
                        candidate,
                        role="unknown",
                        label=self._display_name(candidate),
                        explanation="看起来是补丁或增量包，不一定是完整资源。",
                        reason="需要确认已有版本和补丁适用范围。",
                    )
                )
                continue

            if any(term in lower for term in ATTACHMENT_TERMS):
                selected.append(
                    self._item(
                        candidate,
                        role="attachment",
                        label=self._display_name(candidate),
                        explanation="这是与主资源配套的语言、字幕或校验附件。",
                        reason="文件名或页面说明表明它属于辅助资源。",
                    )
                )
                continue

            score = 0
            if device_os != "unknown" and device_os in lower:
                score += 4
            if device_os == "windows" and ("win" in lower or "windows" in lower):
                score += 4
            if device_arch != "unknown" and device_arch in lower:
                score += 3
            if "portable" in lower or "便携" in lower or "免安装" in lower:
                score += 2
            if candidate.candidate_type in {"file", "magnet", "media", "image"}:
                score += 1
            if candidate.probe_facts and candidate.probe_facts.reachable is True:
                score += 1
            scored.append((score, candidate))

        scored.sort(key=lambda pair: pair[0], reverse=True)
        if scored:
            top_score, top_candidate = scored[0]
            selected.insert(
                0,
                self._item(
                    top_candidate,
                    role="primary",
                    label=self._friendly_label(top_candidate),
                    explanation=self._explain_primary(top_candidate, device_os, device_arch),
                    reason="与当前设备的客观兼容信息和页面证据匹配度最高。",
                ),
            )
            for score, candidate in scored[1:]:
                role = "alternative" if score >= max(1, top_score - 3) else "unknown"
                target = alternatives if role == "alternative" else uncertainties
                target.append(
                    self._item(
                        candidate,
                        role=role,
                        label=self._friendly_label(candidate),
                        explanation="这是同一页面中的其他版本或备用入口。",
                        reason=(
                            "保留为可切换方案，用户可修改最终选择。"
                            if role == "alternative"
                            else "现有证据不足以确定其与主资源的关系。"
                        ),
                    )
                )

        resource_type = self._resource_type(batch)
        title = self._resource_title(batch, selected)
        overview = (
            f"本次采集到 {len(batch.candidates)} 项候选；建议 {len(selected)} 项，"
            f"保留 {len(alternatives)} 项备用，排除 {len(excluded)} 项明显噪声，"
            f"另有 {len(uncertainties)} 项需要确认。"
        )
        recommendations = []
        primary_ids = [item.item_id for item in selected if item.role == "primary"]
        attachment_ids = [item.item_id for item in selected if item.role == "attachment"]
        if primary_ids:
            recommendations.append(
                ScenarioRecommendation(
                    scenario="current_device",
                    item_ids=primary_ids + attachment_ids,
                    summary="优先选择与当前设备兼容的主资源，并附带已识别的必要附件。",
                )
            )
        if alternatives:
            recommendations.append(
                ScenarioRecommendation(
                    scenario="manual",
                    item_ids=[item.item_id for item in alternatives],
                    summary="其他版本或来源保持可修改，不替用户猜测隐藏意图。",
                )
            )

        return ResourcePlan(
            plan_id=f"plan_{uuid4().hex[:12]}",
            batch_id=batch.batch_id,
            provider=self.name,
            resource_type=resource_type,
            resource_title=title,
            overview=overview,
            selected=selected,
            alternatives=alternatives,
            excluded=excluded,
            uncertainties=uncertainties,
            recommendations=recommendations,
        )

    def _item(
        self,
        candidate: CapturedResourceCandidate,
        *,
        role: str,
        label: str,
        explanation: str,
        reason: str,
    ) -> PlanItem:
        return PlanItem(
            item_id=f"item_{candidate.candidate_id}",
            candidate_ids=[candidate.candidate_id],
            label=label,
            plain_explanation=explanation,
            reason=reason,
            role=role,
            technical_attributes=self._technical_attributes(candidate),
            evidence_refs=[
                f"candidate:{candidate.candidate_id}:display_name",
                f"candidate:{candidate.candidate_id}:nearby_text",
            ],
        )

    @staticmethod
    def _candidate_text(candidate: CapturedResourceCandidate) -> str:
        return " ".join(
            value
            for value in [
                candidate.display_name,
                candidate.anchor_text,
                candidate.nearby_text,
                candidate.section_heading,
                candidate.value,
            ]
            if value
        )

    @staticmethod
    def _display_name(candidate: CapturedResourceCandidate) -> str:
        if candidate.display_name:
            return candidate.display_name
        parsed = urlparse(candidate.value)
        path_name = PurePosixPath(parsed.path).name
        return path_name or candidate.anchor_text or candidate.candidate_id

    def _friendly_label(self, candidate: CapturedResourceCandidate) -> str:
        text = self._candidate_text(candidate).lower()
        labels: list[str] = []
        if "windows" in text or re.search(r"(^|[_\-.])win([_\-.]|$)", text):
            labels.append("Windows")
        elif "macos" in text or "mac" in text or "darwin" in text:
            labels.append("macOS")
        elif "linux" in text:
            labels.append("Linux")
        if "arm64" in text or "aarch64" in text:
            labels.append("ARM64")
        elif "x64" in text or "amd64" in text or "64-bit" in text or "64 位" in text:
            labels.append("x64")
        elif "x86" in text or "32-bit" in text or "32 位" in text:
            labels.append("x86")
        if "portable" in text or "便携" in text or "免安装" in text:
            labels.append("便携版")
        elif "setup" in text or "installer" in text or "安装版" in text:
            labels.append("安装版")
        return " ".join(labels) or self._display_name(candidate)

    def _explain_primary(self, candidate: CapturedResourceCandidate, os_name: str, arch: str) -> str:
        label = self._friendly_label(candidate)
        if os_name != "unknown" or arch != "unknown":
            return f"{label}；依据文件名、页面说明和当前设备兼容信息选出，可在确认卡中修改。"
        return f"{label}；依据页面说明与技术元数据选出，未推断用户隐藏意图。"

    def _technical_attributes(self, candidate: CapturedResourceCandidate) -> dict[str, Any]:
        text = self._candidate_text(candidate).lower()
        attributes: dict[str, Any] = {"candidate_type": candidate.candidate_type}
        for platform in ("windows", "macos", "linux"):
            if platform in text or (platform == "windows" and "win" in text):
                attributes["platform"] = platform
                break
        for architecture in ("arm64", "x64", "x86"):
            if architecture in text:
                attributes["architecture"] = architecture
                break
        if "portable" in text or "便携" in text or "免安装" in text:
            attributes["package_type"] = "portable"
        elif "setup" in text or "installer" in text or "安装版" in text:
            attributes["package_type"] = "installer"
        if candidate.probe_facts:
            attributes["content_length"] = candidate.probe_facts.content_length
            attributes["content_type"] = candidate.probe_facts.content_type
            attributes["reachable"] = candidate.probe_facts.reachable
        return attributes

    def _resource_type(self, batch: CaptureBatch) -> str:
        types = {candidate.candidate_type for candidate in batch.candidates}
        joined = " ".join(self._candidate_text(candidate).lower() for candidate in batch.candidates)
        if "media" in types or any(ext in joined for ext in (".mp4", ".m3u8", ".mkv")):
            return "video"
        if "image" in types:
            return "image"
        if any(ext in joined for ext in (".mp3", ".flac", ".aac", ".ape")):
            return "audio"
        if any(ext in joined for ext in (".exe", ".msi", ".dmg", ".appimage")) or any(
            term in joined for term in ("portable", "installer", "setup", "安装版", "便携版")
        ):
            return "software"
        if any(ext in joined for ext in (".zip", ".rar", ".7z", ".tar")):
            return "archive"
        return "mixed" if len(types) > 1 else "unknown"

    @staticmethod
    def _resource_title(batch: CaptureBatch, selected: list[PlanItem]) -> str:
        page_title = re.sub(
            r"\s*(?:[-_|]\s*)?(?:下载|download)(?:中心|页面)?\s*$",
            "",
            batch.page.title,
            flags=re.I,
        )
        if page_title and page_title != batch.page.title:
            return page_title.strip()
        primary = next((item for item in selected if item.role == "primary"), None)
        return primary.label if primary else batch.page.title or "未命名资源"
