import type { CaptureBatch, CapturedResourceCandidate } from '@xunlei-zhiqu/contracts';
import { resourceFamilyMetadata } from './resourceExtensions';

export type NetworkMediaRecord = {
  url: string;
  kind: 'media_file' | 'hls_manifest' | 'dash_manifest';
  mime_type: string | null;
  content_length: number | null;
  content_disposition: string | null;
  request_type: string;
  detected_at: number;
};

export async function readObservedNetworkMedia(): Promise<NetworkMediaRecord[]> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'XUNLEI_ZHIQU_NETWORK_MEDIA_GET' });
    if (!response?.ok || !Array.isArray(response.items)) return [];
    return response.items.filter(isRecord).slice(0, 120);
  } catch {
    return [];
  }
}

export function mergeNetworkMediaIntoBatch(
  batch: CaptureBatch,
  records: NetworkMediaRecord[]
): CaptureBatch {
  if (!records.length) return batch;

  const candidates: CapturedResourceCandidate[] = batch.candidates.map((candidate) => ({
    ...candidate,
    metadata: { ...(candidate.metadata || {}) },
    probe_facts: candidate.probe_facts ? { ...candidate.probe_facts } : candidate.probe_facts
  }));
  const byValue = new Map<string, CapturedResourceCandidate>(
    candidates.map((candidate) => [candidate.value, candidate])
  );
  let appended = 0;

  for (const record of records) {
    if (candidates.length >= 190) break;
    const existing = byValue.get(record.url);
    if (existing) {
      mergeNetworkFacts(existing, record);
      continue;
    }

    const filename = filenameFromUrl(record.url);
    const candidate: CapturedResourceCandidate = {
      candidate_id: `net_${appended + 1}`,
      value: record.url,
      candidate_type: 'media',
      capture_channel: 'media_network',
      page_url: batch.page.url,
      display_name: filename || labelForRecord(record),
      anchor_text: null,
      nearby_text: null,
      section_heading: null,
      dom_rect: null,
      selection_overlap: null,
      normalized_key: record.url,
      probe_status: 'ok',
      probe_facts: {
        content_type: record.mime_type,
        content_length: record.content_length,
        final_url: null,
        reachable: true,
        range_supported: null
      },
      metadata: {
        source_tag: 'network',
        filename,
        mime_type: record.mime_type,
        media_kind: record.kind,
        content_disposition: record.content_disposition,
        request_type: record.request_type,
        network_observed: true,
        ...resourceFamilyMetadata(record.url),
        capture_provenance: [{
          channel: 'media_network',
          source_tag: 'network',
          attribute: 'response'
        }]
      }
    };
    appended += 1;
    candidates.push(candidate);
    byValue.set(record.url, candidate);
  }

  return {
    ...batch,
    candidates,
    selection: batch.selection
      ? {
          ...batch.selection,
          candidate_ids: candidates.map((candidate) => candidate.candidate_id)
        }
      : batch.selection,
    metadata: {
      ...(batch.metadata || {}),
      network_media_count: records.length,
      network_media_fused: true
    }
  };
}

function mergeNetworkFacts(candidate: CapturedResourceCandidate, record: NetworkMediaRecord): void {
  candidate.candidate_type = 'media';
  candidate.metadata = candidate.metadata || {};
  candidate.metadata.network_observed = true;
  candidate.metadata.media_kind ||= record.kind;
  candidate.metadata.mime_type ||= record.mime_type;
  candidate.metadata.content_disposition ||= record.content_disposition;
  candidate.metadata.request_type ||= record.request_type;

  const provenance = Array.isArray(candidate.metadata.capture_provenance)
    ? candidate.metadata.capture_provenance as Array<Record<string, unknown>>
    : [];
  if (!provenance.some((item) => item.channel === 'media_network')) {
    provenance.push({ channel: 'media_network', source_tag: 'network', attribute: 'response' });
  }
  candidate.metadata.capture_provenance = provenance;
  candidate.probe_status = 'ok';
  candidate.probe_facts = {
    ...(candidate.probe_facts || {}),
    content_type: candidate.probe_facts?.content_type || record.mime_type,
    content_length: candidate.probe_facts?.content_length ?? record.content_length,
    reachable: true
  };
}

function isRecord(value: unknown): value is NetworkMediaRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<NetworkMediaRecord>;
  return typeof record.url === 'string'
    && ['media_file', 'hls_manifest', 'dash_manifest'].includes(String(record.kind));
}

function filenameFromUrl(value: string): string | null {
  try {
    const filename = new URL(value).pathname.split('/').filter(Boolean).pop();
    return filename ? decodeURIComponent(filename) : null;
  } catch {
    return null;
  }
}

function labelForRecord(record: NetworkMediaRecord): string {
  if (record.kind === 'hls_manifest') return 'HLS 流媒体清单';
  if (record.kind === 'dash_manifest') return 'DASH 流媒体清单';
  return record.mime_type?.startsWith('audio/') ? '网络音频资源' : '网络视频资源';
}
