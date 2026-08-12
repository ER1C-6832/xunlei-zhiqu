import type { CaptureBatch } from '@xunlei-zhiqu/contracts';
import { buildCaptureBatchFromRect } from './capture';

const OBVIOUS_TEXT = /(?:download|installer|install|source|tarball|archive|package|下载|安装|源码|压缩包|磁力|magnet)/i;

export function buildAutomaticCaptureBatch(tabId?: number): CaptureBatch {
  const viewportRect = {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight
  };
  const batch = buildCaptureBatchFromRect(viewportRect, tabId);
  const candidates = batch.candidates.filter((candidate) => isObviousCandidate(candidate));

  return {
    ...batch,
    trigger: 'automatic',
    selection: {
      type: 'automatic',
      candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      rect: viewportRect
    },
    candidates,
    metadata: {
      ...(batch.metadata || {}),
      capture_version: 'stage-c.2',
      automatic_scan: 'visible_obvious_resources'
    }
  };
}

function isObviousCandidate(candidate: CaptureBatch['candidates'][number]): boolean {
  if (['file', 'media', 'magnet', 'image'].includes(candidate.candidate_type)) return true;
  if (typeof candidate.metadata?.download_attribute === 'string' && candidate.metadata.download_attribute) return true;
  const evidence = [
    candidate.display_name,
    candidate.anchor_text,
    candidate.nearby_text,
    candidate.section_heading
  ].filter(Boolean).join(' ');
  return OBVIOUS_TEXT.test(evidence);
}
