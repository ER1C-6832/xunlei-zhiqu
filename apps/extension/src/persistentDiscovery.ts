import { extensionFromValue, resourceExtensionHint } from './resourceExtensions';

type DiscoveryKind = 'file' | 'media' | 'magnet' | 'entry';
type PersistentDiscoveryItem = {
  value: string;
  kind: DiscoveryKind;
  label: string;
  host: string | null;
  extension: string | null;
};
type PersistentDiscoveryState = {
  enabled: boolean;
  count: number;
  fileCount: number;
  mediaCount: number;
  magnetCount: number;
  entryCount: number;
  items: PersistentDiscoveryItem[];
};
type NetworkMediaNotice = {
  url: string;
  kind: 'media_file' | 'hls_manifest' | 'dash_manifest';
  mime_type?: string | null;
};

export const AUTO_DISCOVERY_STORAGE_KEY = 'zhiqu_auto_discovery_enabled';
const BADGE_ID = 'xunlei-zhiqu-discovery-badge';
const COUNT_ID = 'xunlei-zhiqu-discovery-count';
const IMAGE_RESOURCE_TEXT = /(?:download|original|full(?:\s*size)?|high\s*res|原图|下载|高清)/i;

let state = emptyState(false);
let observer: MutationObserver | null = null;
let scanTimer: number | null = null;
const networkMedia = new Map<string, PersistentDiscoveryItem>();

export async function initializePersistentDiscovery(): Promise<void> {
  try {
    const values = await chrome.storage.local.get(AUTO_DISCOVERY_STORAGE_KEY);
    applyPersistentDiscoveryEnabled(values[AUTO_DISCOVERY_STORAGE_KEY] === true);
  } catch {
    applyPersistentDiscoveryEnabled(false);
  }

  await hydrateNetworkMedia();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[AUTO_DISCOVERY_STORAGE_KEY]) {
      applyPersistentDiscoveryEnabled(changes[AUTO_DISCOVERY_STORAGE_KEY].newValue === true);
    }
  });
}

export function applyPersistentDiscoveryEnabled(enabled: boolean): PersistentDiscoveryState {
  if (state.enabled === enabled) {
    if (enabled) refreshPersistentDiscovery();
    return getPersistentDiscoveryState();
  }
  state = { ...state, enabled };
  if (enabled) startPersistentDiscovery(); else stopPersistentDiscovery();
  return getPersistentDiscoveryState();
}

export function getPersistentDiscoveryState(): PersistentDiscoveryState {
  return { ...state, items: state.items.map((item) => ({ ...item })) };
}

export function refreshPersistentDiscovery(): PersistentDiscoveryState {
  if (!state.enabled || document.visibilityState === 'hidden') return getPersistentDiscoveryState();
  state = { ...state, ...discoverDocumentResources() };
  renderDiscoveryBadge(state.count);
  notifyDiscoveryUpdate();
  return getPersistentDiscoveryState();
}

export function ingestNetworkMediaDiscovery(notice: NetworkMediaNotice): void {
  const value = resolveValue(notice.url);
  if (!value || value.startsWith('blob:')) return;
  networkMedia.set(value, {
    value,
    kind: 'media',
    label: networkMediaLabel(notice),
    host: hostFromValue(value),
    extension: extensionFromValue(value)
  });
  if (networkMedia.size > 120) {
    const oldest = networkMedia.keys().next().value as string | undefined;
    if (oldest) networkMedia.delete(oldest);
  }
  if (state.enabled) scheduleDiscovery(120);
}

async function hydrateNetworkMedia(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'XUNLEI_ZHIQU_NETWORK_MEDIA_GET' });
    if (!response?.ok || !Array.isArray(response.items)) return;
    for (const item of response.items) {
      if (!item || typeof item !== 'object') continue;
      const notice = item as Partial<NetworkMediaNotice>;
      if (typeof notice.url !== 'string') continue;
      if (!['media_file', 'hls_manifest', 'dash_manifest'].includes(String(notice.kind))) continue;
      ingestNetworkMediaDiscovery(notice as NetworkMediaNotice);
    }
  } catch {
    // Network observation is additive. DOM discovery must continue when it is unavailable.
  }
}

function startPersistentDiscovery(): void {
  if (!observer) {
    observer = new MutationObserver((mutations) => {
      const meaningful = mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return !target?.closest?.(`#${BADGE_ID}`);
      });
      if (meaningful) scheduleDiscovery(800);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'src', 'srcset', 'download', 'type']
    });
  }
  document.addEventListener('visibilitychange', onVisibilityChanged);
  scheduleDiscovery(60);
}

function stopPersistentDiscovery(): void {
  observer?.disconnect();
  observer = null;
  if (scanTimer !== null) window.clearTimeout(scanTimer);
  scanTimer = null;
  document.removeEventListener('visibilitychange', onVisibilityChanged);
  document.getElementById(BADGE_ID)?.remove();
  state = emptyState(false);
  notifyDiscoveryUpdate();
}

function onVisibilityChanged(): void {
  if (document.visibilityState === 'visible') scheduleDiscovery(160);
}

function scheduleDiscovery(delay: number): void {
  if (!state.enabled) return;
  if (scanTimer !== null) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    refreshPersistentDiscovery();
  }, delay);
}

function discoverDocumentResources(): Omit<PersistentDiscoveryState, 'enabled'> {
  const identities = new Set<string>();
  const items: PersistentDiscoveryItem[] = [];
  let fileCount = 0;
  let mediaCount = 0;
  let magnetCount = 0;
  let entryCount = 0;

  const register = (value: string, kind: DiscoveryKind, label?: string | null) => {
    const identity = kind === 'magnet' ? normalizeMagnet(value) : value;
    if (identities.has(identity) || identities.size >= 160) return;
    identities.add(identity);
    if (kind === 'file') fileCount += 1;
    else if (kind === 'media') mediaCount += 1;
    else if (kind === 'magnet') magnetCount += 1;
    else entryCount += 1;
    items.push({
      value,
      kind,
      label: cleanLabel(label) || filenameFromValue(value) || defaultLabel(kind),
      host: hostFromValue(value),
      extension: extensionFromValue(value)
    });
  };

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (identities.size >= 160 || !hasLayout(anchor)) continue;
    const resolved = resolveValue(anchor.getAttribute('href'));
    if (!resolved) continue;
    const label = anchor.getAttribute('download') || anchor.textContent || anchor.getAttribute('aria-label');

    if (resolved.startsWith('magnet:')) {
      register(resolved, 'magnet', label);
      continue;
    }

    const hint = resourceExtensionHint(resolved);
    if (hint?.candidateType === 'media') {
      register(resolved, 'media', label);
      continue;
    }
    if (hint?.candidateType === 'image') {
      const linkedImage = Boolean(anchor.querySelector('img,picture'));
      const explicitImageDownload = anchor.hasAttribute('download') || IMAGE_RESOURCE_TEXT.test(label || '');
      if (linkedImage || explicitImageDownload) register(resolved, 'file', label);
      continue;
    }
    if (hint) {
      register(resolved, 'file', label);
      continue;
    }
    if (anchor.hasAttribute('download')) {
      register(resolved, 'entry', label || '明确下载入口');
    }
  }

  for (const media of document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>('video, audio')) {
    if (!hasLayout(media)) continue;
    const values = new Set<string>();
    if (media.currentSrc) values.add(media.currentSrc);
    const direct = media.getAttribute('src');
    if (direct) values.add(direct);
    for (const source of media.querySelectorAll<HTMLSourceElement>('source[src]')) {
      const value = source.getAttribute('src');
      if (value) values.add(value);
    }
    for (const raw of values) {
      const resolved = resolveValue(raw);
      if (!resolved || resolved.startsWith('blob:')) continue;
      register(resolved, 'media', media.getAttribute('title') || media.getAttribute('aria-label'));
    }
  }

  for (const item of networkMedia.values()) register(item.value, 'media', item.label);

  return { count: identities.size, fileCount, mediaCount, magnetCount, entryCount, items };
}

function hasLayout(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function resolveValue(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('mailto:') || lower.startsWith('tel:')) return null;
  if (lower.startsWith('magnet:') || lower.startsWith('blob:')) return value;
  try { return new URL(value, window.location.href).toString(); } catch { return null; }
}

function normalizeMagnet(value: string): string {
  const match = value.match(/[?&]xt=urn:btih:([^&]+)/i);
  return match?.[1] ? `magnet:btih:${decodeURIComponent(match[1]).toLowerCase()}` : value;
}

function cleanLabel(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 120) : null;
}

function filenameFromValue(value: string): string | null {
  if (value.startsWith('magnet:')) {
    const name = value.match(/[?&]dn=([^&]+)/i)?.[1];
    if (!name) return null;
    try { return decodeURIComponent(name.replace(/\+/g, ' ')); } catch { return name; }
  }
  try {
    const name = new URL(value).pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : null;
  } catch {
    return null;
  }
}

function hostFromValue(value: string): string | null {
  if (value.startsWith('magnet:') || value.startsWith('blob:')) return null;
  try { return new URL(value).hostname || null; } catch { return null; }
}

function defaultLabel(kind: DiscoveryKind): string {
  return kind === 'media' ? '媒体资源' : kind === 'magnet' ? 'Magnet 资源' : kind === 'entry' ? '下载入口' : '文件资源';
}

function networkMediaLabel(notice: NetworkMediaNotice): string {
  if (notice.kind === 'hls_manifest') return 'HLS 流媒体';
  if (notice.kind === 'dash_manifest') return 'DASH 流媒体';
  return notice.mime_type?.startsWith('audio/') ? '网络音频' : '网络视频';
}

function renderDiscoveryBadge(count: number): void {
  if (!state.enabled || count <= 0) {
    document.getElementById(BADGE_ID)?.remove();
    return;
  }
  let button = document.getElementById(BADGE_ID) as HTMLButtonElement | null;
  if (!button) {
    button = document.createElement('button');
    button.id = BADGE_ID;
    button.type = 'button';
    button.title = '迅雷智取发现了可下载资源';
    Object.assign(button.style, {
      position: 'fixed', left: '20px', bottom: '24px', zIndex: '2147483645', width: '48px', height: '48px',
      display: 'grid', placeItems: 'center', padding: '0', border: '0', borderRadius: '50%', color: '#fff',
      background: '#1677ff', boxShadow: '0 8px 24px rgba(22,119,255,.32)', cursor: 'pointer'
    });
    button.append(createBirdMark(), createCountBadge());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void chrome.runtime.sendMessage({ type: 'XUNLEI_ZHIQU_OPEN_PANEL' });
    });
    document.documentElement.appendChild(button);
  }
  const countBadge = document.getElementById(COUNT_ID);
  if (countBadge) countBadge.textContent = count > 99 ? '99+' : String(count);
  button.setAttribute('aria-label', `迅雷智取发现 ${count} 项高置信可下载资源，点击打开`);
}

function createCountBadge(): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.id = COUNT_ID;
  Object.assign(badge.style, {
    position: 'absolute', top: '-5px', right: '-7px', minWidth: '21px', height: '21px', display: 'grid',
    placeItems: 'center', padding: '0 5px', border: '2px solid #fff', borderRadius: '999px', color: '#fff',
    background: '#ff4d4f', font: '700 11px/17px Microsoft YaHei UI, system-ui, sans-serif',
    boxShadow: '0 2px 7px rgba(0,0,0,.18)'
  });
  return badge;
}

function createBirdMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '27');
  svg.setAttribute('height', '27');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  body.setAttribute('d', 'M4 15.2c3.4-.5 6.7-3.2 8.8-8.1.7 2.7 2.7 4.5 6.4 5-1.8 1.7-3.9 2.6-6.1 2.7-2 2.7-4.5 4.1-8 4.4 1.8-1 3.1-2.3 3.9-4-1.9.5-3.5.5-5 0Z');
  body.setAttribute('fill', 'currentColor');
  const wing = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  wing.setAttribute('d', 'M10.2 13.2c1.8-.9 3.2-2.2 4.2-4 .5 1.4 1.5 2.4 3 3-2 .3-3.7 1-5.2 2.2');
  wing.setAttribute('fill', 'none');
  wing.setAttribute('stroke', '#dcebff');
  wing.setAttribute('stroke-width', '1.25');
  wing.setAttribute('stroke-linecap', 'round');
  svg.append(body, wing);
  return svg;
}

function notifyDiscoveryUpdate(): void {
  void chrome.runtime.sendMessage({
    type: 'XUNLEI_ZHIQU_DISCOVERY_UPDATE',
    state: getPersistentDiscoveryState()
  }).catch(() => undefined);
}

function emptyState(enabled: boolean): PersistentDiscoveryState {
  return { enabled, count: 0, fileCount: 0, mediaCount: 0, magnetCount: 0, entryCount: 0, items: [] };
}
