export type CandidateType = 'file' | 'magnet' | 'media' | 'image' | 'page' | 'unknown';
export type CaptureChannel =
  | 'dom_link'
  | 'selected_text'
  | 'media_element'
  | 'media_network'
  | 'image'
  | 'manual';
export type DeliveryTarget = 'local' | 'cloud';
export type ResourceType = 'software' | 'video' | 'audio' | 'image' | 'archive' | 'mixed' | 'unknown';

export interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProbeFacts {
  content_type?: string | null;
  content_length?: number | null;
  final_url?: string | null;
  reachable?: boolean | null;
  range_supported?: boolean | null;
}

export interface CapturedResourceCandidate {
  candidate_id: string;
  value: string;
  candidate_type: CandidateType;
  capture_channel: CaptureChannel;
  page_url: string;
  display_name?: string | null;
  anchor_text?: string | null;
  nearby_text?: string | null;
  section_heading?: string | null;
  dom_rect?: DomRect | null;
  selection_overlap?: number | null;
  normalized_key?: string | null;
  probe_status?: 'pending' | 'ok' | 'failed' | 'skipped';
  probe_facts?: ProbeFacts | null;
  metadata?: Record<string, unknown>;
}

export interface CaptureSelection {
  type: 'automatic' | 'click' | 'rectangle' | 'manual';
  candidate_ids?: string[];
  rect?: DomRect | null;
}

export interface DeviceContext {
  os?: 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown';
  arch?: 'x64' | 'arm64' | 'x86' | 'unknown';
  locale?: string;
}

export interface CaptureBatch {
  schema_version: '0.1';
  batch_id: string;
  tab_id?: number | null;
  trigger: 'automatic' | 'click' | 'rectangle' | 'manual';
  page: {
    url: string;
    title: string;
    relevant_text?: string[];
  };
  selection?: CaptureSelection | null;
  device?: DeviceContext | null;
  candidates: CapturedResourceCandidate[];
  metadata?: Record<string, unknown>;
}

export interface PlanItem {
  item_id: string;
  candidate_ids: string[];
  label: string;
  plain_explanation: string;
  reason: string;
  role: 'primary' | 'attachment' | 'alternative' | 'excluded' | 'unknown';
  technical_attributes?: Record<string, string | number | boolean | null>;
  evidence_refs?: string[];
}

export interface ScenarioRecommendation {
  scenario: 'current_device' | 'compatibility' | 'quality' | 'small_size' | 'manual';
  item_ids: string[];
  summary: string;
}

export interface ResourcePlan {
  schema_version: '0.1';
  plan_id: string;
  batch_id: string;
  provider: string;
  resource_type: ResourceType;
  resource_title: string;
  overview: string;
  selected: PlanItem[];
  alternatives: PlanItem[];
  excluded: PlanItem[];
  uncertainties: PlanItem[];
  recommendations: ScenarioRecommendation[];
}

export interface ResourceJobCreateRequest {
  schema_version: '0.1';
  plan: ResourcePlan;
  capture?: CaptureBatch | null;
  delivery_target?: DeliveryTarget;
  destination?: string | null;
}

export interface ManualJobCreateRequest {
  schema_version: '0.1';
  links: string[];
  title?: string | null;
  delivery_target?: DeliveryTarget;
  destination?: string | null;
}

export interface ResourceJobSnapshot {
  job_id: string;
  title: string;
  subtitle: string;
  kind: 'zhiqu' | 'normal';
  status: 'planning' | 'downloading' | 'waiting_for_source' | 'verifying' | 'completed' | 'paused';
  progress: number;
  downloaded_bytes: number;
  total_bytes: number;
  speed_bytes_per_second: number;
  eta_seconds?: number | null;
  stage_label: string;
  issue?: string | null;
  next_action?: 'pause' | 'resume' | 'continue_acquisition' | 'open' | null;
  source_count: number;
  excluded_count: number;
  created_at: string;
  destination?: string | null;
  delivery_target?: DeliveryTarget;
  plan_id?: string | null;
  execution_mode?: 'demo' | 'download_engine';
  resource_type?: ResourceType;
  plan_overview?: string | null;
  selected_items?: string[];
  alternative_count?: number;
  source_page?: string | null;
}

export interface LinkHistoryItem {
  history_id: string;
  title: string;
  link_type: 'http' | 'magnet' | 'media' | 'unknown';
  display_link: string;
  size_bytes?: number | null;
  added_at: string;
  job_id?: string | null;
  delivery_target?: DeliveryTarget | null;
  status: 'active' | 'completed' | 'failed' | 'saved';
  source_page?: string | null;
  resource_type?: ResourceType | null;
  favorite?: boolean;
  favorite_at?: string | null;
}

export interface LinkFavoriteCreateRequest {
  schema_version: '0.1';
  plan: ResourcePlan;
  capture?: CaptureBatch | null;
}

export interface LinkFavoriteUpdateRequest {
  favorite: boolean;
}
