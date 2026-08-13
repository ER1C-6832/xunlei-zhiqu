import type {
  CaptureBatch,
  CloudAnalysisCandidate,
  CloudAnalysisRequest
} from '@xunlei-zhiqu/contracts';

const SAFE_METADATA_KEYS = new Set([
  'attachment_kind',
  'content_length',
  'content_type',
  'extension',
  'filename',
  'image_source',
  'media_kind',
  'natural_height',
  'natural_width',
  'network_observed',
  'possible_original',
  'rendered_height',
  'rendered_width',
  'resource_family_hint'
]);

const URL_PATTERN = /(?:\b(?:https?:\/\/|magnet:\?|www\.)|\/\/)[^\s<>'"`]+/gi;
const AUTHORIZATION_PATTERN = /\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi;
const BEARER_PATTERN = /\bbearer\s+[^\s,;]+/gi;
const SECRET_PATTERN = /\b(?:cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|session|password|signature|sig)\s*[:=]\s*[^\s,;]+/gi;
const QUERY_SECRET_PATTERN = /([?&](?:token|access_token|auth|authorization|signature|sig|key|session|expires)\s*=)[^&#\s]+/gi;
const FORBIDDEN_FIELD_PATTERN = /"(?:value|page_url|url|cookie|authorization|credential|local_path|html)"\s*:/i;
const LEAKED_SECRET_PATTERN = /(?:\bbearer\s+[^\s,;]+|\b(?:cookie|token|session|password|signature|sig|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+)/i;

export function buildCloudAnalysisRequest(batch: CaptureBatch): CloudAnalysisRequest {
  return {
    schema_version: '0.1',
    source_batch_id: batch.batch_id,
    trigger: batch.trigger,
    page: {
      title: sanitizeContextText(batch.page.title, 180) || '未命名页面'
    },
    selection: batch.selection
      ? {
          type: batch.selection.type,
          candidate_ids: batch.selection.candidate_ids?.filter(Boolean)
        }
      : null,
    device: batch.device ? { ...batch.device } : null,
    candidates: batch.candidates.map(sanitizeCandidate)
  };
}

export function assertCloudAnalysisRequestPrivacy(request: CloudAnalysisRequest): void {
  const serialized = JSON.stringify(request);
  const leakedField = serialized.match(FORBIDDEN_FIELD_PATTERN)?.[0];
  if (leakedField) throw new Error(`CloudAnalysisRequest contains forbidden field ${leakedField}`);
  if (/(?:https?:\/\/|magnet:\?|\bwww\.|\/\/[^\s"]+)/i.test(serialized)) {
    throw new Error('CloudAnalysisRequest contains a raw resource URL');
  }
  if (LEAKED_SECRET_PATTERN.test(serialized)) {
    throw new Error('CloudAnalysisRequest contains credential-like material');
  }
}

function sanitizeCandidate(candidate: CaptureBatch['candidates'][number]): CloudAnalysisCandidate {
  const metadata = candidate.metadata || {};
  const technicalMetadata = sanitizeMetadata(metadata);
  const filename = stringMetadata(metadata.filename);
  const extension = stringMetadata(metadata.extension);
  const resourceFamilyHint = stringMetadata(metadata.resource_family_hint);

  return compactObject({
    candidate_id: candidate.candidate_id,
    candidate_type: candidate.candidate_type,
    capture_channel: candidate.capture_channel,
    display_name: sanitizeContextText(candidate.display_name, 180),
    filename: sanitizeContextText(filename, 180),
    extension: sanitizeContextText(extension, 24),
    anchor_text: sanitizeContextText(candidate.anchor_text, 220),
    nearby_text: sanitizeContextText(candidate.nearby_text, 420),
    section_heading: sanitizeContextText(candidate.section_heading, 180),
    resource_family_hint: sanitizeContextText(resourceFamilyHint, 80),
    technical_metadata: Object.keys(technicalMetadata).length ? technicalMetadata : undefined
  }) as CloudAnalysisCandidate;
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean' || value === null) result[key] = value;
    else if (typeof value === 'string') {
      const cleaned = sanitizeContextText(value, key === 'filename' ? 180 : 100);
      if (cleaned) result[key] = cleaned;
    }
  }
  return result;
}

function sanitizeContextText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(URL_PATTERN, '[link]')
    .replace(QUERY_SECRET_PATTERN, '$1[redacted]')
    .replace(AUTHORIZATION_PATTERN, '[redacted]')
    .replace(BEARER_PATTERN, '[redacted]')
    .replace(SECRET_PATTERN, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as T;
}
