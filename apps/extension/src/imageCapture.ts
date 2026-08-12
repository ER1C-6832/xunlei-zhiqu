import type { CaptureBatch, CapturedResourceCandidate, DomRect } from '@xunlei-zhiqu/contracts';
import { extensionFromValue, resourceFamilyMetadata } from './resourceExtensions';

const MAX_IMAGES = 180;
const MAX_STYLE_ELEMENTS = 3200;
const CSS_URL_PATTERN = /url\((?:"|')?([^"')]+)(?:"|')?\)/giu;

type ImageObservation = {
  value: string;
  source: 'img_src' | 'srcset' | 'picture_source' | 'linked_original' | 'css_background';
  element: Element;
  label?: string | null;
  naturalWidth?: number | null;
  naturalHeight?: number | null;
  descriptor?: string | null;
  possibleOriginal?: boolean;
};

export function buildImageCaptureBatch(tabId?: number): CaptureBatch {
  const observations = new Map<string, ImageObservation>();

  for (const image of document.querySelectorAll<HTMLImageElement>('img')) {
    const label = cleanText(image.alt || image.title || image.getAttribute('aria-label'));
    const direct = image.currentSrc || image.getAttribute('src');
    if (direct) register(observations, {
      value: direct,
      source: 'img_src',
      element: image,
      label,
      naturalWidth: image.naturalWidth || null,
      naturalHeight: image.naturalHeight || null
    });

    for (const item of parseSrcset(image.getAttribute('srcset'))) {
      register(observations, {
        value: item.url,
        source: 'srcset',
        element: image,
        label,
        naturalWidth: image.naturalWidth || null,
        naturalHeight: image.naturalHeight || null,
        descriptor: item.descriptor,
        possibleOriginal: item.isLargest
      });
    }

    for (const source of image.parentElement?.querySelectorAll<HTMLSourceElement>('source[srcset]') || []) {
      for (const item of parseSrcset(source.getAttribute('srcset'))) {
        register(observations, {
          value: item.url,
          source: 'picture_source',
          element: image,
          label,
          naturalWidth: image.naturalWidth || null,
          naturalHeight: image.naturalHeight || null,
          descriptor: item.descriptor,
          possibleOriginal: item.isLargest
        });
      }
    }

    const anchor = image.closest<HTMLAnchorElement>('a[href]');
    if (anchor) {
      const href = resolveImageValue(anchor.getAttribute('href'));
      if (href && isLikelyImageUrl(href)) {
        register(observations, {
          value: href,
          source: 'linked_original',
          element: image,
          label: label || cleanText(anchor.textContent),
          naturalWidth: image.naturalWidth || null,
          naturalHeight: image.naturalHeight || null,
          possibleOriginal: true
        });
      }
    }
  }

  let styleCount = 0;
  for (const element of document.querySelectorAll<HTMLElement>('body *')) {
    if (styleCount >= MAX_STYLE_ELEMENTS || observations.size >= MAX_IMAGES) break;
    styleCount += 1;
    const background = getComputedStyle(element).backgroundImage;
    if (!background || background === 'none') continue;
    for (const match of background.matchAll(CSS_URL_PATTERN)) {
      const value = match[1]?.trim();
      if (!value) continue;
      register(observations, {
        value,
        source: 'css_background',
        element,
        label: cleanText(element.getAttribute('aria-label') || element.getAttribute('title'))
      });
    }
  }

  const candidates: CapturedResourceCandidate[] = [];
  let index = 0;
  for (const observation of observations.values()) {
    if (candidates.length >= MAX_IMAGES) break;
    const value = resolveImageValue(observation.value);
    if (!value) continue;
    const rect = rectForElement(observation.element);
    const filename = filenameFromValue(value);
    const renderedWidth = rect?.width ? Math.round(rect.width) : null;
    const renderedHeight = rect?.height ? Math.round(rect.height) : null;
    index += 1;
    candidates.push({
      candidate_id: `img_${index}`,
      value,
      candidate_type: 'image',
      capture_channel: 'image',
      page_url: window.location.href,
      display_name: observation.label || filename || '网页图片',
      anchor_text: observation.label || null,
      nearby_text: nearbyText(observation.element),
      section_heading: nearestHeading(observation.element),
      dom_rect: rect,
      selection_overlap: null,
      normalized_key: value,
      probe_status: value.startsWith('blob:') ? 'skipped' : 'pending',
      probe_facts: null,
      metadata: {
        source_tag: observation.element.tagName.toLowerCase(),
        image_source: observation.source,
        filename,
        extension: extensionFromValue(value),
        natural_width: observation.naturalWidth ?? null,
        natural_height: observation.naturalHeight ?? null,
        rendered_width: renderedWidth,
        rendered_height: renderedHeight,
        srcset_descriptor: observation.descriptor ?? null,
        possible_original: Boolean(observation.possibleOriginal),
        directly_downloadable: !value.startsWith('blob:'),
        ...resourceFamilyMetadata(value),
        capture_provenance: [{
          channel: 'image',
          source_tag: observation.element.tagName.toLowerCase(),
          attribute: observation.source
        }]
      }
    });
  }

  return {
    schema_version: '0.1',
    batch_id: `batch_img_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
    tab_id: tabId ?? null,
    trigger: 'automatic',
    page: {
      url: window.location.href,
      title: document.title,
      relevant_text: collectHeadings()
    },
    selection: {
      type: 'automatic',
      candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      rect: null
    },
    device: {
      os: detectOs(),
      arch: detectArch(),
      locale: navigator.language || 'zh-CN'
    },
    candidates,
    metadata: {
      capture_version: 'stage-d.5',
      capture_scope: 'batch_images',
      image_count: candidates.length,
      style_elements_scanned: styleCount
    }
  };
}

function register(observations: Map<string, ImageObservation>, observation: ImageObservation): void {
  if (observations.size >= MAX_IMAGES) return;
  const value = resolveImageValue(observation.value);
  if (!value || value.startsWith('data:')) return;
  const existing = observations.get(value);
  if (!existing) {
    observations.set(value, { ...observation, value });
    return;
  }
  if (observation.possibleOriginal && !existing.possibleOriginal) existing.possibleOriginal = true;
  if (!existing.label && observation.label) existing.label = observation.label;
  if (!existing.naturalWidth && observation.naturalWidth) existing.naturalWidth = observation.naturalWidth;
  if (!existing.naturalHeight && observation.naturalHeight) existing.naturalHeight = observation.naturalHeight;
}

function parseSrcset(value: string | null): Array<{ url: string; descriptor: string | null; isLargest: boolean }> {
  if (!value?.trim()) return [];
  const parsed = value.split(',').map((part) => {
    const [url, descriptor] = part.trim().split(/\s+/, 2);
    const numeric = descriptor?.endsWith('w') ? Number(descriptor.slice(0, -1))
      : descriptor?.endsWith('x') ? Number(descriptor.slice(0, -1)) * 10000
      : 0;
    return { url: url || '', descriptor: descriptor || null, numeric: Number.isFinite(numeric) ? numeric : 0 };
  }).filter((item) => item.url);
  const max = Math.max(0, ...parsed.map((item) => item.numeric));
  return parsed.map((item) => ({ url: item.url, descriptor: item.descriptor, isLargest: item.numeric > 0 && item.numeric === max }));
}

function resolveImageValue(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('mailto:') || lower.startsWith('tel:') || lower.startsWith('data:')) return null;
  if (lower.startsWith('blob:')) return value;
  try { return new URL(value, window.location.href).toString(); } catch { return null; }
}

function isLikelyImageUrl(value: string): boolean {
  const extension = extensionFromValue(value);
  return Boolean(extension && ['jpg','jpeg','png','gif','webp','bmp','svg','cr2','dcm','dds','eps','exif','fpx','hdri','heic','heif','jxl','jxr','pcd','pcx','psd','raw','tga','tif','tiff','wmf'].includes(extension));
}

function filenameFromValue(value: string): string | null {
  if (value.startsWith('blob:')) return null;
  try {
    const name = new URL(value).pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : null;
  } catch {
    return null;
  }
}

function rectForElement(element: Element): DomRect | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.round(rect.x * 10) / 10,
    y: Math.round(rect.y * 10) / 10,
    width: Math.round(rect.width * 10) / 10,
    height: Math.round(rect.height * 10) / 10
  };
}

function nearbyText(element: Element): string | null {
  const raw = (element.closest('figure,article,section,li,p,div') as HTMLElement | null)?.innerText
    || element.parentElement?.textContent
    || '';
  return cleanText(raw)?.slice(0, 180) || null;
}

function nearestHeading(element: Element): string | null {
  let cursor: Element | null = element;
  for (let depth = 0; cursor && depth < 10; depth += 1) {
    let sibling = cursor.previousElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName)) return cleanText(sibling.textContent)?.slice(0, 140) || null;
      const nested = sibling.querySelector?.('h1,h2,h3,h4,h5,h6');
      if (nested?.textContent) return cleanText(nested.textContent)?.slice(0, 140) || null;
      sibling = sibling.previousElementSibling;
    }
    cursor = cursor.parentElement;
  }
  return null;
}

function collectHeadings(): string[] {
  const result: string[] = [];
  for (const heading of document.querySelectorAll<HTMLElement>('h1,h2,h3,h4')) {
    const value = cleanText(heading.innerText || heading.textContent);
    if (!value || result.includes(value)) continue;
    result.push(value.slice(0, 180));
    if (result.length >= 24) break;
  }
  return result;
}

function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

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
