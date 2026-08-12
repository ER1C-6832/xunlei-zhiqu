import type { CaptureBatch, CapturedResourceCandidate } from '@xunlei-zhiqu/contracts';

type Provenance = { channel: string; source_tag?: string; attribute?: string };

/**
 * Exact-URL fusion may first discover a candidate through <a> and only later
 * through <video>/<audio>/<source>. Preserve the stronger media facts without
 * creating another candidate or using filename similarity.
 */
export function enrichFusedCandidateMetadata(batch: CaptureBatch): CaptureBatch {
  const byValue = new Map(batch.candidates.map((candidate) => [candidate.value, candidate]));

  for (const media of document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>('video, audio')) {
    const kind = media.tagName.toLowerCase();
    const directValues = [media.currentSrc, media.getAttribute('src') || ''].filter(Boolean);
    for (const raw of directValues) {
      const value = resolveValue(raw);
      if (!value) continue;
      const candidate = byValue.get(value);
      if (!candidate) continue;
      mergeMediaFacts(candidate, {
        channel: 'media_element',
        source_tag: kind,
        attribute: 'src'
      }, {
        media_kind: kind,
        controls: media.controls,
        duration_seconds: Number.isFinite(media.duration) ? Math.round(media.duration * 100) / 100 : null,
        video_width: media instanceof HTMLVideoElement ? media.videoWidth || null : null,
        video_height: media instanceof HTMLVideoElement ? media.videoHeight || null : null,
        dynamic_media_signal: value.startsWith('blob:'),
        directly_downloadable: !value.startsWith('blob:')
      });
      if (value.startsWith('blob:')) candidate.probe_status = 'skipped';
    }

    for (const source of media.querySelectorAll<HTMLSourceElement>('source[src]')) {
      const raw = source.getAttribute('src');
      if (!raw) continue;
      const value = resolveValue(raw);
      if (!value) continue;
      const candidate = byValue.get(value);
      if (!candidate) continue;
      mergeMediaFacts(candidate, {
        channel: 'media_element',
        source_tag: 'source',
        attribute: 'src'
      }, {
        media_kind: kind,
        mime_type: source.type || null,
        controls: media.controls,
        duration_seconds: Number.isFinite(media.duration) ? Math.round(media.duration * 100) / 100 : null,
        video_width: media instanceof HTMLVideoElement ? media.videoWidth || null : null,
        video_height: media instanceof HTMLVideoElement ? media.videoHeight || null : null,
        dynamic_media_signal: value.startsWith('blob:'),
        directly_downloadable: !value.startsWith('blob:')
      });
      if (value.startsWith('blob:')) candidate.probe_status = 'skipped';
    }
  }

  return batch;
}

function mergeMediaFacts(
  candidate: CapturedResourceCandidate,
  provenance: Provenance,
  facts: Record<string, string | number | boolean | null>
): void {
  candidate.candidate_type = 'media';
  const metadata = candidate.metadata ?? {};
  candidate.metadata = metadata;

  const currentProvenance = Array.isArray(metadata.capture_provenance)
    ? metadata.capture_provenance as Provenance[]
    : [];
  if (!currentProvenance.some((item) =>
    item.channel === provenance.channel
    && item.source_tag === provenance.source_tag
    && item.attribute === provenance.attribute
  )) currentProvenance.push(provenance);
  metadata.capture_provenance = currentProvenance;

  for (const [key, value] of Object.entries(facts)) {
    const current = metadata[key];
    if (current === undefined || current === null || current === '') metadata[key] = value;
  }
}

function resolveValue(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try { return new URL(value, window.location.href).toString(); }
  catch { return null; }
}
