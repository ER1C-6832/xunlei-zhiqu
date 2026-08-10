import type {
  CaptureBatch,
  CapturedResourceCandidate,
  CandidateType
} from '@xunlei-zhiqu/contracts';

const MAX_CANDIDATES = 80;

function candidateType(value: string): CandidateType {
  const lower = value.toLowerCase();
  if (lower.startsWith('magnet:')) return 'magnet';
  if (/\.(mp4|m3u8|mkv|webm)(\?|#|$)/i.test(lower)) return 'media';
  if (/\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(lower)) return 'image';
  if (/\.(html?|php|aspx?)(\?|#|$)/i.test(lower) || lower.endsWith('/')) return 'page';
  if (/\.(zip|rar|7z|exe|msi|dmg|pkg|appimage|tar|gz|flac|mp3|aac|torrent)(\?|#|$)/i.test(lower)) {
    return 'file';
  }
  return 'unknown';
}

function normalizeUrl(value: string): string {
  if (value.startsWith('magnet:')) return value;
  try {
    const url = new URL(value, window.location.href);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function nearbyText(element: Element): string {
  const raw = element.parentElement?.innerText || element.textContent || '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function rectFor(element: Element) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function buildBatch(tabId?: number): CaptureBatch {
  const values = new Map<string, CapturedResourceCandidate>();
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));

  for (const anchor of anchors) {
    const value = normalizeUrl(anchor.href);
    if (!value || values.has(value)) continue;
    const type = candidateType(value);
    const label = anchor.textContent?.replace(/\s+/g, ' ').trim() || null;
    values.set(value, {
      candidate_id: `c_${values.size + 1}`,
      value,
      candidate_type: type,
      capture_channel: 'dom_link',
      page_url: window.location.href,
      display_name: decodeURIComponent(value.split('/').pop()?.split('?')[0] || '') || label,
      anchor_text: label,
      nearby_text: nearbyText(anchor),
      dom_rect: rectFor(anchor),
      normalized_key: value,
      probe_status: 'pending'
    });
    if (values.size >= MAX_CANDIDATES) break;
  }

  const pageText = document.body.innerText.slice(0, 20_000);
  const magnetMatches = pageText.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s"'<>]*/g) || [];
  for (const magnet of magnetMatches) {
    const value = normalizeUrl(magnet);
    if (values.has(value) || values.size >= MAX_CANDIDATES) continue;
    values.set(value, {
      candidate_id: `c_${values.size + 1}`,
      value,
      candidate_type: 'magnet',
      capture_channel: 'selected_text',
      page_url: window.location.href,
      display_name: 'Magnet 资源',
      nearby_text: '从页面纯文本中发现的 Magnet。',
      normalized_key: value,
      probe_status: 'skipped'
    });
  }

  const candidates = Array.from(values.values());
  return {
    schema_version: '0.1',
    batch_id: `batch_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
    tab_id: tabId ?? null,
    trigger: 'manual',
    page: {
      url: window.location.href,
      title: document.title,
      relevant_text: Array.from(document.querySelectorAll('h1, h2, h3'))
        .map((heading) => heading.textContent?.replace(/\s+/g, ' ').trim())
        .filter((value): value is string => Boolean(value))
        .slice(0, 20)
    },
    selection: {
      type: 'manual',
      candidate_ids: candidates.map((candidate) => candidate.candidate_id)
    },
    device: {
      os: /Win/i.test(navigator.platform) ? 'windows' : /Mac/i.test(navigator.platform) ? 'macos' : 'unknown',
      arch: 'unknown',
      locale: navigator.language || 'zh-CN'
    },
    candidates
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'XUNLEI_ZHIQU_CAPTURE') return false;
  sendResponse({ ok: true, batch: buildBatch(message.tabId) });
  return false;
});
