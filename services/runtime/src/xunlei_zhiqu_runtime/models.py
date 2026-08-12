from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


ResourceType = Literal[
    "software",
    "document",
    "video",
    "audio",
    "image",
    "subtitle",
    "model",
    "design",
    "archive",
    "disk_image",
    "mixed",
    "unknown",
]
DeliveryTarget = Literal["local", "cloud"]


class DomRect(BaseModel):
    x: float
    y: float
    width: float
    height: float


class ProbeFacts(BaseModel):
    content_type: str | None = None
    content_length: int | None = Field(default=None, ge=0)
    final_url: str | None = None
    reachable: bool | None = None
    range_supported: bool | None = None


class CapturedResourceCandidate(BaseModel):
    model_config = ConfigDict(extra="allow")

    candidate_id: str = Field(min_length=1)
    value: str = Field(min_length=1)
    candidate_type: Literal["file", "magnet", "media", "image", "page", "unknown"]
    capture_channel: Literal[
        "dom_link",
        "selected_text",
        "media_element",
        "media_network",
        "image",
        "manual",
    ]
    page_url: str
    display_name: str | None = None
    anchor_text: str | None = None
    nearby_text: str | None = None
    section_heading: str | None = None
    dom_rect: DomRect | None = None
    selection_overlap: float | None = Field(default=None, ge=0, le=1)
    normalized_key: str | None = None
    probe_status: Literal["pending", "ok", "failed", "skipped"] = "pending"
    probe_facts: ProbeFacts | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CaptureSelection(BaseModel):
    type: Literal["automatic", "click", "rectangle", "manual"]
    candidate_ids: list[str] = Field(default_factory=list)
    rect: DomRect | None = None


class DeviceContext(BaseModel):
    os: Literal["windows", "macos", "linux", "android", "ios", "unknown"] = "unknown"
    arch: Literal["x64", "arm64", "x86", "unknown"] = "unknown"
    locale: str = "zh-CN"


class CapturePage(BaseModel):
    url: str
    title: str
    relevant_text: list[str] = Field(default_factory=list)


class CaptureBatch(BaseModel):
    model_config = ConfigDict(extra="allow")

    schema_version: Literal["0.1"] = "0.1"
    batch_id: str = Field(min_length=1)
    tab_id: int | None = None
    trigger: Literal["automatic", "click", "rectangle", "manual"]
    page: CapturePage
    selection: CaptureSelection | None = None
    device: DeviceContext | None = None
    candidates: list[CapturedResourceCandidate] = Field(min_length=1, max_length=200)
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvidenceCandidate(BaseModel):
    id: str
    candidate_type: Literal["file", "magnet", "media", "image", "page", "unknown"]
    display_name: str | None = None
    filename: str | None = None
    extension: str | None = None
    anchor_text: str | None = None
    nearby_text: str | None = None
    section_heading: str | None = None
    selection_overlap: float | None = Field(default=None, ge=0, le=1)
    capture_provenance: list[dict[str, str | None]] = Field(default_factory=list)
    technical_metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class EvidencePack(BaseModel):
    schema_version: Literal["0.1"] = "0.1"
    batch_id: str
    page: dict[str, Any]
    selection: dict[str, Any] | None = None
    device: dict[str, Any] | None = None
    candidates: list[EvidenceCandidate]


class PlanItem(BaseModel):
    item_id: str
    candidate_ids: list[str] = Field(min_length=1)
    label: str
    plain_explanation: str
    reason: str
    role: Literal["primary", "attachment", "alternative", "excluded", "unknown"]
    technical_attributes: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    evidence_refs: list[str] = Field(default_factory=list)


class ScenarioRecommendation(BaseModel):
    scenario: Literal["current_device", "compatibility", "quality", "small_size", "manual"]
    item_ids: list[str]
    summary: str


class ResourcePlan(BaseModel):
    schema_version: Literal["0.1"] = "0.1"
    plan_id: str
    batch_id: str
    provider: str
    resource_type: ResourceType
    resource_title: str
    overview: str
    selected: list[PlanItem] = Field(default_factory=list)
    alternatives: list[PlanItem] = Field(default_factory=list)
    excluded: list[PlanItem] = Field(default_factory=list)
    uncertainties: list[PlanItem] = Field(default_factory=list)
    recommendations: list[ScenarioRecommendation] = Field(default_factory=list)


class ResourceJobCreateRequest(BaseModel):
    schema_version: Literal["0.1"] = "0.1"
    plan: ResourcePlan
    confirmed_item_ids: list[str] = Field(min_length=1)
    capture: CaptureBatch | None = None
    delivery_target: DeliveryTarget = "local"
    destination: str | None = None


class ManualJobCreateRequest(BaseModel):
    schema_version: Literal["0.1"] = "0.1"
    links: list[str] = Field(min_length=1, max_length=50)
    title: str | None = None
    delivery_target: DeliveryTarget = "local"
    destination: str | None = None


class LinkFavoriteCreateRequest(BaseModel):
    schema_version: Literal["0.1"] = "0.1"
    plan: ResourcePlan
    capture: CaptureBatch | None = None


class LinkFavoriteUpdateRequest(BaseModel):
    favorite: bool


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    provider: str
    version: str = "0.1.0"


class ResourceJobSnapshot(BaseModel):
    job_id: str
    title: str
    subtitle: str
    kind: Literal["zhiqu", "normal"]
    status: Literal[
        "planning", "downloading", "waiting_for_source", "verifying", "completed", "paused"
    ]
    progress: float = Field(ge=0, le=100)
    downloaded_bytes: int = Field(ge=0)
    total_bytes: int = Field(ge=0)
    speed_bytes_per_second: int = Field(ge=0)
    eta_seconds: int | None = Field(default=None, ge=0)
    stage_label: str
    issue: str | None = None
    next_action: Literal["pause", "resume", "continue_acquisition", "open"] | None = None
    source_count: int = Field(ge=0)
    excluded_count: int = Field(ge=0)
    created_at: datetime
    destination: str | None = None
    delivery_target: DeliveryTarget = "local"
    plan_id: str | None = None
    execution_mode: Literal["demo", "download_engine"] = "demo"
    resource_type: ResourceType = "unknown"
    plan_overview: str | None = None
    selected_items: list[str] = Field(default_factory=list)
    alternative_count: int = Field(default=0, ge=0)
    source_page: str | None = None


class LinkHistoryItem(BaseModel):
    history_id: str
    title: str
    link_type: Literal["http", "magnet", "media", "unknown"]
    display_link: str
    size_bytes: int | None = Field(default=None, ge=0)
    added_at: datetime
    job_id: str | None = None
    delivery_target: DeliveryTarget | None = None
    status: Literal["active", "completed", "failed", "saved"]
    source_page: str | None = None
    resource_type: ResourceType | None = None
    favorite: bool = False
    favorite_at: datetime | None = None
