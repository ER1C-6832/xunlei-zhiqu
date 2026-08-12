import type { CaptureBatch, DomRect } from '@xunlei-zhiqu/contracts';
import { buildCaptureBatchFromRect } from './capture';
import { isKnownResourceExtension } from './resourceExtensions';

const OBVIOUS_TEXT = /(?:download|installer|install|source|tarball|archive|package|binary|binaries|rpm|debian|dmg|msi|jdk|jre|下载|安装|源码|压缩包|磁力|magnet)/i;

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
      capture_version: 'stage-d.3',
      automatic_scan: 'visible_obvious_resources',
      capture_scope: 'viewport'
    }
  };
}

export function buildFullPageCaptureBatch(tabId?: number): CaptureBatch {
  const documentRect = fullDocumentRect();
  const batch = buildCaptureBatchFromRect(documentRect, tabId);
  const candidates = batch.candidates.filter((candidate) => isObviousCandidate(candidate));
  const pageHeadings = collectPageHeadings();
  const relevantText = [...pageHeadings, ...(batch.page.relevant_text || [])]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .slice(0, 56);

  return {
    ...batch,
    trigger: 'automatic',
    page: {
      ...batch.page,
      relevant_text: relevantText
    },
    selection: {
      type: 'automatic',
      candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      rect: documentRect
    },
    candidates,
    metadata: {
      ...(batch.metadata || {}),
      capture_version: 'stage-d.3',
      automatic_scan: 'full_page_obvious_resources',
      capture_scope: 'full_page',
      document_size: {
        width: Math.round(documentRect.width),
        height: Math.round(documentRect.height)
      }
    }
  };
}

function isObviousCandidate(candidate: CaptureBatch['candidates'][number]): boolean {
  if (['media', 'magnet'].includes(candidate.candidate_type)) return true;
  if (isKnownResourceExtension(candidate.value)) return true;
  if (typeof candidate.metadata?.download_attribute === 'string' && candidate.metadata.download_attribute) return true;
  const evidence = [
    candidate.display_name,
    candidate.anchor_text,
    candidate.nearby_text,
    candidate.section_heading
  ].filter(Boolean).join(' ');
  return OBVIOUS_TEXT.test(evidence);
}

function fullDocumentRect(): DomRect {
  const root = document.documentElement;
  const body = document.body;
  const width = Math.max(
    window.innerWidth,
    root?.scrollWidth || 0,
    root?.clientWidth || 0,
    body?.scrollWidth || 0,
    body?.clientWidth || 0
  );
  const height = Math.max(
    window.innerHeight,
    root?.scrollHeight || 0,
    root?.clientHeight || 0,
    body?.scrollHeight || 0,
    body?.clientHeight || 0
  );
  return {
    x: -window.scrollX,
    y: -window.scrollY,
    width,
    height
  };
}

function collectPageHeadings(): string[] {
  const headings: string[] = [];
  for (const heading of document.querySelectorAll<HTMLElement>('h1,h2,h3,h4')) {
    const value = (heading.innerText || heading.textContent || '').replace(/\s+/g, ' ').trim();
    if (!value || headings.includes(value)) continue;
    headings.push(value.slice(0, 220));
    if (headings.length >= 36) break;
  }
  return headings;
}
