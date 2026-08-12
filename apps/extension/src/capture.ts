import type {
  CaptureBatch,
  CaptureChannel,
  CapturedResourceCandidate,
  CandidateType,
  DomRect
} from '@xunlei-zhiqu/contracts';

const MAX_CANDIDATES = 160;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const MAGNET_PATTERN = /magnet:\?[^\s<>"'`]+/giu;
const HARD_DROP_PROTOCOLS = new Set(['javascript:', 'mailto:', 'tel:']);

type Provenance = {
  channel: CaptureChannel;
  source_tag?: string;
  attribute?: string;
};

type CandidateObservation = {
  value: string;
  candidateType: CandidateType;
  channel: CaptureChannel;
  rect: DomRect;
  displayName?: string | null;
  anchorText?: string | null;
  nearbyText?: string | null;
  sectionHeading?: string | null;
  metadata?: Record<string, unknown>;
  probeStatus?: CapturedResourceCandidate['probe_status'];
};

type MutableCandidate = CapturedResourceCandidate & {
  metadata: Record<string, unknown> & { capture_provenance?: Provenance[] };
};

export function buildCaptureBatchFromRect(selectionRect: DomRect, tabId?: number): CaptureBatch {
  const candidates = new Map<string, MutableCandidate>();
  const btihKeys = new Set<string>();

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a')) {
    const rawHref = anchor.getAttribute('href');
    if (rawHref === null || rawHref.trim() === '') continue;
    const rect = rectForElement(anchor);
    if (!rect || overlapRatio(rect, selectionRect) <= 0) continue;
    const resolved = resolveCandidateValue(rawHref);
    if (!resolved) continue;
    addObservation(candidates, btihKeys, selectionRect, {
      value: resolved,
      candidateType: candidateType(resolved),
      channel: 'dom_link',
      rect,
      displayName: filenameFromValue(resolved) || cleanText(anchor.textContent),
      anchorText: cleanText(anchor.textContent),
      nearbyText: nearbyText(anchor),
      sectionHeading: nearestHeading(anchor),
      metadata: {
        source_tag: 'a',
        href_attribute: rawHref,
        download_attribute: anchor.getAttribute('download') || null,
        rel: anchor.getAttribute('rel') || null,
        target: anchor.getAttribute('target') || null,
        aria_label: anchor.getAttribute('aria-label') || null
      },
      probeStatus: resolved.startsWith('magnet:') ? 'skipped' : 'pending'
    });
  }

  for (const textNode of selectedTextNodes(selectionRect)) {
    const text = textNode.textContent || '';
    const parent = textNode.parentElement;
    if (!parent) continue;
    const rect = rectForTextNode(textNode) || rectForElement(parent);
    if (!rect || overlapRatio(rect, selectionRect) <= 0) continue;

    for (const match of [...text.matchAll(URL_PATTERN), ...text.matchAll(MAGNET_PATTERN)]) {
      const raw = trimTrailingPunctuation(match[0]);
      const resolved = resolveCandidateValue(raw);
      if (!resolved) continue;
      addObservation(candidates, btihKeys, selectionRect, {
        value: resolved,
        candidateType: candidateType(resolved),
        channel: 'selected_text',
        rect,
        displayName: filenameFromValue(resolved) || (resolved.startsWith('magnet:') ? 'Magnet 资源' : null),
        nearbyText: cleanText(parent.innerText || text)?.slice(0, 320) || null,
        sectionHeading: nearestHeading(parent),
        metadata: { source_tag: parent.tagName.toLowerCase(), text_match: true },
        probeStatus: resolved.startsWith('magnet:') ? 'skipped' : 'pending'
      });
    }
  }

  for (const media of document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>('video, audio')) {
    const rect = rectForElement(media);
    if (!rect || overlapRatio(rect, selectionRect) <= 0) continue;
    const values = new Set<string>();
    if (media.currentSrc) values.add(media.currentSrc);
    if (media.getAttribute('src')) values.add(media.getAttribute('src')!);
    for (const source of media.querySelectorAll('source[src]') as NodeListOf<HTMLSourceElement>) {
      if (source.getAttribute('src')) values.add(source.getAttribute('src')!);
    }
    for (const raw of values) {
      const resolved = resolveCandidateValue(raw);
      if (!resolved) continue;
      addObservation(candidates, btihKeys, selectionRect, {
        value: resolved,
        candidateType: 'media',
        channel: 'media_element',
        rect,
        displayName: filenameFromValue(resolved) || `${media.tagName.toLowerCase()} 媒体`,
        nearbyText: nearbyText(media),
        sectionHeading: nearestHeading(media),
        metadata: {
          source_tag: media.tagName.toLowerCase(),
          media_kind: media.tagName.toLowerCase(),
          mime_type: inferMediaMime(media, resolved),
          controls: media.controls,
          duration_seconds: Number.isFinite(media.duration) ? Math.round(media.duration * 100) / 100 : null,
          video_width: media instanceof HTMLVideoElement ? media.videoWidth || null : null,
          video_height: media instanceof HTMLVideoElement ? media.videoHeight || null : null
        },
        probeStatus: 'pending'
      });
    }
  }

  const finalCandidates = Array.from(candidates.values()).slice(0, MAX_CANDIDATES).map((candidate, index) => ({
    ...candidate,
    candidate_id: `c_${index + 1}`
  }));

  return {
    schema_version: '0.1',
    batch_id: `batch_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
    tab_id: tabId ?? null,
    trigger: 'rectangle',
    page: {
      url: window.location.href,
      title: document.title,
      relevant_text: relevantTextForSelection(selectionRect)
    },
    selection: {
      type: 'rectangle',
      candidate_ids: finalCandidates.map((candidate) => candidate.candidate_id),
      rect: selectionRect
    },
    device: {
      os: detectOs(),
      arch: detectArch(),
      locale: navigator.language || 'zh-CN'
    },
    candidates: finalCandidates,
    metadata: {
      capture_version: 'stage-c.1',
      viewport: { width: window.innerWidth, height: window.innerHeight, device_pixel_ratio: window.devicePixelRatio },
      channels: ['dom_link', 'selected_text', 'media_element']
    }
  };
}

function addObservation(
  candidates: Map<string, MutableCandidate>,
  btihKeys: Set<string>,
  selectionRect: DomRect,
  observation: CandidateObservation
): void {
  if (candidates.size >= MAX_CANDIDATES) return;
  const value = observation.value;
  const btih = btihFromMagnet(value);
  const identity = btih ? `btih:${btih}` : `url:${value}`;
  if (btih && btihKeys.has(btih) && !candidates.has(identity)) return;

  const overlap = overlapRatio(observation.rect, selectionRect);
  if (overlap <= 0) return;
  const provenance: Provenance = {
    channel: observation.channel,
    source_tag: typeof observation.metadata?.source_tag === 'string' ? observation.metadata.source_tag : undefined,
    attribute: observation.channel === 'dom_link' ? 'href' : observation.channel === 'media_element' ? 'src' : undefined
  };

  const existing = candidates.get(identity);
  if (existing) {
    const current = existing.metadata.capture_provenance ?? [];
    if (!current.some((item) => item.channel === provenance.channel && item.source_tag === provenance.source_tag)) {
      current.push(provenance);
    }
    existing.metadata.capture_provenance = current;
    existing.selection_overlap = Math.max(existing.selection_overlap ?? 0, overlap);
    if ((existing.selection_overlap ?? 0) <= overlap) existing.dom_rect = observation.rect;
    existing.anchor_text ||= observation.anchorText;
    existing.nearby_text ||= observation.nearbyText;
    existing.section_heading ||= observation.sectionHeading;
    existing.display_name ||= observation.displayName;
    return;
  }

  const filename = filenameFromValue(value) || observation.displayName || null;
  const extension = filename ? extensionFromFilename(filename) : null;
  const candidate: MutableCandidate = {
    candidate_id: '',
    value,
    candidate_type: observation.candidateType,
    capture_channel: observation.channel,
    page_url: window.location.href,
    display_name: observation.displayName ?? filename,
    anchor_text: observation.anchorText ?? null,
    nearby_text: observation.nearbyText ?? null,
    section_heading: observation.sectionHeading ?? null,
    dom_rect: observation.rect,
    selection_overlap: overlap,
    normalized_key: btih ? `btih:${btih}` : value,
    probe_status: observation.probeStatus ?? 'pending',
    metadata: {
      ...(observation.metadata ?? {}),
      filename,
      extension,
      btih: btih || null,
      capture_provenance: [provenance]
    }
  };
  candidates.set(identity, candidate);
  if (btih) btihKeys.add(btih);
}

function resolveCandidateValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const protocolMatch = trimmed.match(/^([a-z][a-z0-9+.-]*:)/i);
  if (protocolMatch && HARD_DROP_PROTOCOLS.has(protocolMatch[1].toLowerCase())) return null;
  if (trimmed.toLowerCase().startsWith('magnet:')) return trimmed;
  try {
    return new URL(trimmed, window.location.href).toString();
  } catch {
    return null;
  }
}

function candidateType(value: string): CandidateType {
  const lower = value.toLowerCase();
  if (lower.startsWith('magnet:')) return 'magnet';
  if (/\.(mp4|m3u8|mkv|webm|avi|mov|mp3|flac|aac|wav|ogg)(?:[?#]|$)/i.test(lower)) return 'media';
  if (/\.(png|jpe?g|gif|webp|svg|bmp)(?:[?#]|$)/i.test(lower)) return 'image';
  if (/\.(zip|rar|7z|exe|msi|dmg|pkg|appimage|deb|rpm|tar|gz|xz|torrent|pdf)(?:[?#]|$)/i.test(lower)) return 'file';
  if (/\.(html?|php|aspx?)(?:[?#]|$)/i.test(lower) || /\/$/.test(new URL(value).pathname)) return 'page';
  return 'unknown';
}

function btihFromMagnet(value: string): string | null {
  if (!value.toLowerCase().startsWith('magnet:')) return null;
  const match = value.match(/[?&]xt=urn:btih:([^&]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]).toLowerCase() : null;
}

function filenameFromValue(value: string): string | null {
  if (value.startsWith('magnet:')) {
    const dn = value.match(/[?&]dn=([^&]+)/i)?.[1];
    return dn ? safeDecode(dn.replace(/\+/g, ' ')) : null;
  }
  try {
    const pathname = new URL(value, window.location.href).pathname;
    const segment = pathname.split('/').filter(Boolean).pop();
    return segment ? safeDecode(segment) : null;
  } catch {
    return null;
  }
}

function extensionFromFilename(filename: string): string | null {
  const match = filename.toLowerCase().match(/\.([a-z0-9]{1,10})$/i);
  return match?.[1] ?? null;
}

function selectedTextNodes(selectionRect: DomRect): Text[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.textContent || '';
      if (!text.match(URL_PATTERN) && !text.match(MAGNET_PATTERN)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
      const rect = rectForTextNode(node as Text) || rectForElement(parent);
      return rect && overlapRatio(rect, selectionRect) > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes: Text[] = [];
  while (walker.nextNode() && nodes.length < 80) nodes.push(walker.currentNode as Text);
  return nodes;
}

function relevantTextForSelection(selectionRect: DomRect): string[] {
  const items: string[] = [];
  for (const element of document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,td,th')) {
    const rect = rectForElement(element);
    if (!rect || overlapRatio(rect, selectionRect) <= 0) continue;
    const text = cleanText(element.innerText || element.textContent);
    if (text && !items.includes(text)) items.push(text.slice(0, 320));
    if (items.length >= 24) break;
  }
  return items;
}

function rectForElement(element: Element): DomRect | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
}

function rectForTextNode(node: Text): DomRect | null {
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  range.detach();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
}

export function overlapRatio(candidate: DomRect, selection: DomRect): number {
  const left = Math.max(candidate.x, selection.x);
  const top = Math.max(candidate.y, selection.y);
  const right = Math.min(candidate.x + candidate.width, selection.x + selection.width);
  const bottom = Math.min(candidate.y + candidate.height, selection.y + selection.height);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const area = Math.max(candidate.width * candidate.height, 1);
  return Math.min(1, Math.max(0, Math.round((intersection / area) * 1000) / 1000));
}

function nearbyText(element: Element): string | null {
  const raw = (element.closest('tr,li,section,article,div,p') as HTMLElement | null)?.innerText
    || (element.parentElement as HTMLElement | null)?.innerText
    || element.textContent
    || '';
  const value = cleanText(raw);
  return value ? value.slice(0, 320) : null;
}

function nearestHeading(element: Element): string | null {
  const container = element.closest('section,article,main,div,li,tr') || element.parentElement;
  const own = container?.querySelector('h1,h2,h3,h4,h5,h6')?.textContent;
  if (own) return cleanText(own)?.slice(0, 160) || null;
  let cursor: Element | null = element;
  for (let i = 0; cursor && i < 12; i += 1) {
    let sibling = cursor.previousElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName)) return cleanText(sibling.textContent)?.slice(0, 160) || null;
      const nested = sibling.querySelector?.('h1,h2,h3,h4,h5,h6');
      if (nested?.textContent) return cleanText(nested.textContent)?.slice(0, 160) || null;
      sibling = sibling.previousElementSibling;
    }
    cursor = cursor.parentElement;
  }
  return null;
}

function inferMediaMime(media: HTMLMediaElement, value: string): string | null {
  const source = Array.from(media.querySelectorAll('source') as NodeListOf<HTMLSourceElement>).find((item) => {
    const raw = item.getAttribute('src');
    return raw && resolveCandidateValue(raw) === value;
  });
  return source?.type || null;
}

function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[),.;!?，。；！？）]+$/u, '');
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function round(value: number): number { return Math.round(value * 10) / 10; }
function detectOs(): 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown' {
  const source = `${navigator.userAgent} ${navigator.platform}`;
  if (/android/i.test(source)) return 'android';
  if (/iphone|ipad|ipod/i.test(source)) return 'ios';
  if (/win/i.test(source)) return 'windows';
  if (/mac/i.test(source)) return 'macos';
  if (/linux/i.test(source)) return 'linux';
  return 'unknown';
}
function detectArch(): 'x64' | 'arm64' | 'x86' | 'unknown' {
  const source = navigator.userAgent.toLowerCase();
  if (/arm64|aarch64/.test(source)) return 'arm64';
  if (/x86_64|win64|x64|amd64/.test(source)) return 'x64';
  if (/i[3-6]86|x86/.test(source)) return 'x86';
  return 'unknown';
}
