type PersistentDiscoveryState = {
  enabled: boolean;
  count: number;
  fileCount: number;
  mediaCount: number;
  magnetCount: number;
};

export const AUTO_DISCOVERY_STORAGE_KEY = 'zhiqu_auto_discovery_enabled';

const BADGE_ID = 'xunlei-zhiqu-discovery-badge';
const COUNT_ID = 'xunlei-zhiqu-discovery-count';
const FILE_PATTERN = /\.(zip|rar|7z|exe|msi|dmg|pkg|appimage|deb|rpm|tar|gz|xz|torrent|pdf)(?:[?#]|$)/i;
const MEDIA_PATTERN = /\.(mp4|m3u8|mkv|webm|avi|mov|mp3|flac|aac|wav|ogg)(?:[?#]|$)/i;
const IMAGE_PATTERN = /\.(png|jpe?g|gif|webp|svg|bmp)(?:[?#]|$)/i;
const OBVIOUS_TEXT = /(?:download|installer|install|source|tarball|archive|package|下载|安装|源码|压缩包|磁力|magnet)/i;

let state: PersistentDiscoveryState = {
  enabled: false,
  count: 0,
  fileCount: 0,
  mediaCount: 0,
  magnetCount: 0
};
let observer: MutationObserver | null = null;
let scanTimer: number | null = null;

export async function initializePersistentDiscovery(): Promise<void> {
  try {
    const values = await chrome.storage.local.get(AUTO_DISCOVERY_STORAGE_KEY);
    applyPersistentDiscoveryEnabled(values[AUTO_DISCOVERY_STORAGE_KEY] === true);
  } catch {
    applyPersistentDiscoveryEnabled(false);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[AUTO_DISCOVERY_STORAGE_KEY]) return;
    applyPersistentDiscoveryEnabled(changes[AUTO_DISCOVERY_STORAGE_KEY].newValue === true);
  });
}

export function applyPersistentDiscoveryEnabled(enabled: boolean): PersistentDiscoveryState {
  if (state.enabled === enabled) {
    if (enabled) refreshPersistentDiscovery();
    return getPersistentDiscoveryState();
  }

  state = { ...state, enabled };
  if (enabled) startPersistentDiscovery();
  else stopPersistentDiscovery();
  return getPersistentDiscoveryState();
}

export function getPersistentDiscoveryState(): PersistentDiscoveryState {
  return { ...state };
}

export function refreshPersistentDiscovery(): PersistentDiscoveryState {
  if (!state.enabled || document.visibilityState === 'hidden') return getPersistentDiscoveryState();

  const discovered = discoverVisibleResources();
  state = { ...state, ...discovered };
  renderDiscoveryBadge(state.count);
  notifyDiscoveryUpdate();
  return getPersistentDiscoveryState();
}

function startPersistentDiscovery(): void {
  if (!observer) {
    observer = new MutationObserver((mutations) => {
      const meaningful = mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return !target?.closest?.(`#${BADGE_ID}`);
      });
      if (meaningful) scheduleDiscovery(500);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'src', 'download', 'type']
    });
  }

  window.addEventListener('scroll', onViewportChanged, { passive: true });
  window.addEventListener('resize', onViewportChanged, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChanged);
  scheduleDiscovery(40);
}

function stopPersistentDiscovery(): void {
  observer?.disconnect();
  observer = null;
  if (scanTimer !== null) window.clearTimeout(scanTimer);
  scanTimer = null;
  window.removeEventListener('scroll', onViewportChanged);
  window.removeEventListener('resize', onViewportChanged);
  document.removeEventListener('visibilitychange', onVisibilityChanged);
  document.getElementById(BADGE_ID)?.remove();
  state = { enabled: false, count: 0, fileCount: 0, mediaCount: 0, magnetCount: 0 };
  notifyDiscoveryUpdate();
}

function onViewportChanged(): void {
  scheduleDiscovery(420);
}

function onVisibilityChanged(): void {
  if (document.visibilityState === 'visible') scheduleDiscovery(120);
}

function scheduleDiscovery(delay: number): void {
  if (!state.enabled) return;
  if (scanTimer !== null) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    refreshPersistentDiscovery();
  }, delay);
}

function discoverVisibleResources(): Omit<PersistentDiscoveryState, 'enabled'> {
  const identities = new Set<string>();
  let fileCount = 0;
  let mediaCount = 0;
  let magnetCount = 0;

  const register = (value: string, kind: 'file' | 'media' | 'magnet') => {
    if (identities.has(value)) return;
    identities.add(value);
    if (kind === 'file') fileCount += 1;
    else if (kind === 'media') mediaCount += 1;
    else magnetCount += 1;
  };

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (identities.size >= 99 || !isVisible(anchor)) continue;
    const raw = anchor.getAttribute('href');
    const resolved = resolveValue(raw);
    if (!resolved) continue;
    if (resolved.startsWith('magnet:')) {
      register(normalizeMagnet(resolved), 'magnet');
      continue;
    }
    const evidence = `${anchor.textContent || ''} ${anchor.getAttribute('download') || ''} ${anchor.getAttribute('aria-label') || ''}`;
    if (MEDIA_PATTERN.test(resolved)) register(resolved, 'media');
    else if (FILE_PATTERN.test(resolved) || IMAGE_PATTERN.test(resolved) || anchor.hasAttribute('download') || OBVIOUS_TEXT.test(evidence)) register(resolved, 'file');
  }

  for (const media of document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>('video, audio')) {
    if (identities.size >= 99 || !isVisible(media)) continue;
    const values = new Set<string>();
    if (media.currentSrc) values.add(media.currentSrc);
    const direct = media.getAttribute('src');
    if (direct) values.add(direct);
    for (const source of media.querySelectorAll<HTMLSourceElement>('source[src]')) {
      const value = source.getAttribute('src');
      if (value) values.add(value);
    }
    for (const value of values) {
      const resolved = resolveValue(value);
      if (resolved) register(resolved, 'media');
    }
  }

  return {
    count: identities.size,
    fileCount,
    mediaCount,
    magnetCount
  };
}

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
}

function resolveValue(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('mailto:') || lower.startsWith('tel:')) return null;
  if (lower.startsWith('magnet:')) return value;
  try {
    return new URL(value, window.location.href).toString();
  } catch {
    return null;
  }
}

function normalizeMagnet(value: string): string {
  const match = value.match(/[?&]xt=urn:btih:([^&]+)/i);
  return match?.[1] ? `magnet:btih:${decodeURIComponent(match[1]).toLowerCase()}` : value;
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
    button.setAttribute('aria-label', '打开迅雷智取查看发现的资源');
    Object.assign(button.style, {
      position: 'fixed',
      left: '20px',
      bottom: '24px',
      zIndex: '2147483645',
      width: '46px',
      height: '46px',
      display: 'grid',
      placeItems: 'center',
      padding: '0',
      border: '0',
      borderRadius: '50%',
      color: '#fff',
      background: '#1677ff',
      boxShadow: '0 8px 24px rgba(22,119,255,.32)',
      cursor: 'pointer',
      font: '700 15px/1 Microsoft YaHei UI, system-ui, sans-serif'
    });

    const mark = document.createElement('span');
    mark.textContent = '智';
    mark.setAttribute('aria-hidden', 'true');
    const countBadge = document.createElement('span');
    countBadge.id = COUNT_ID;
    Object.assign(countBadge.style, {
      position: 'absolute',
      top: '-5px',
      right: '-7px',
      minWidth: '21px',
      height: '21px',
      display: 'grid',
      placeItems: 'center',
      padding: '0 5px',
      border: '2px solid #fff',
      borderRadius: '999px',
      color: '#fff',
      background: '#ff4d4f',
      font: '700 11px/17px Microsoft YaHei UI, system-ui, sans-serif',
      boxShadow: '0 2px 7px rgba(0,0,0,.18)'
    });
    button.append(mark, countBadge);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void chrome.runtime.sendMessage({ type: 'XUNLEI_ZHIQU_OPEN_PANEL' });
    });
    document.documentElement.appendChild(button);
  }

  const countBadge = document.getElementById(COUNT_ID);
  const text = count > 99 ? '99+' : String(count);
  if (countBadge && countBadge.textContent !== text) countBadge.textContent = text;
  button.setAttribute('aria-label', `迅雷智取发现 ${count} 项可下载资源，点击打开`);
}

function notifyDiscoveryUpdate(): void {
  void chrome.runtime.sendMessage({
    type: 'XUNLEI_ZHIQU_DISCOVERY_UPDATE',
    state: getPersistentDiscoveryState()
  }).catch(() => undefined);
}
