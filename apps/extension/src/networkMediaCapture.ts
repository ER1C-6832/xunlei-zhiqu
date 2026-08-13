type NetworkMediaKind = 'media_file' | 'hls_manifest' | 'dash_manifest';

export type NetworkMediaRecord = {
  url: string;
  kind: NetworkMediaKind;
  mime_type: string | null;
  content_length: number | null;
  content_disposition: string | null;
  request_type: string;
  detected_at: number;
};

const AUTO_DISCOVERY_STORAGE_KEY = 'zhiqu_auto_discovery_enabled';
const STORAGE_PREFIX = 'zhiqu_network_media_tab_';
const MAX_PER_TAB = 120;
const MEDIA_URL_PATTERN = /\.(?:3g2|3gp|aac|aiff|amr|ape|asf|avi|av1|divx|f4v|flac|flv|m2t|m2ts|m4a|m4v|mid|mka|mkv|mov|mp3|mp4|mpe|mpeg|mpg|mpga|ogg|opus|qt|ra|rm|rmvb|vob|wav|webm|wma)(?:[?#&/]|$)/i;
const HLS_PATTERN = /\.m3u8(?:[?#&/]|$)/i;
const DASH_PATTERN = /\.mpd(?:[?#&/]|$)/i;
const HLS_SEGMENT_PATTERN = /\.ts(?:[?#&/]|$)/i;
let discoveryEnabled = false;
let discoveryReady: Promise<void> = Promise.resolve();

export function registerNetworkMediaCapture(): void {
  discoveryReady = chrome.storage.local.get(AUTO_DISCOVERY_STORAGE_KEY)
    .then((values) => { discoveryEnabled = values[AUTO_DISCOVERY_STORAGE_KEY] === true; })
    .catch(() => { discoveryEnabled = false; });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[AUTO_DISCOVERY_STORAGE_KEY]) return;
    discoveryEnabled = changes[AUTO_DISCOVERY_STORAGE_KEY].newValue === true;
    if (!discoveryEnabled) void clearNetworkRecords();
  });

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      void handleHeadersReceived(details);
    },
    { urls: ['http://*/*', 'https://*/*'] },
    ['responseHeaders']
  );

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'XUNLEI_ZHIQU_NETWORK_MEDIA_GET') return false;
    const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
    void discoveryReady.then(async () => {
      if (!discoveryEnabled || typeof tabId !== 'number') {
        sendResponse({ ok: true, items: [] });
        return;
      }
      try {
        sendResponse({ ok: true, items: await readRecords(tabId) });
      } catch {
        sendResponse({ ok: true, items: [] });
      }
    });
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.session.remove(storageKey(tabId));
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      void chrome.storage.session.remove(storageKey(tabId));
    }
  });
}

async function handleHeadersReceived(details: chrome.webRequest.WebResponseHeadersDetails): Promise<void> {
  await discoveryReady;
  if (!discoveryEnabled || details.tabId < 0 || !/^https?:/i.test(details.url)) return;

  const headers = readHeaders(details.responseHeaders || []);
  const requestType = String(details.type);
  const kind = classifyNetworkMedia(
    details.url,
    headers.contentType,
    headers.contentDisposition,
    requestType
  );
  if (!kind) return;

  const record: NetworkMediaRecord = {
    url: details.url,
    kind,
    mime_type: headers.contentType,
    content_length: headers.contentLength,
    content_disposition: headers.contentDisposition,
    request_type: requestType,
    detected_at: Date.now()
  };
  await saveRecord(details.tabId, record);
}

async function saveRecord(tabId: number, record: NetworkMediaRecord): Promise<void> {
  const records = await readRecords(tabId);
  const existingIndex = records.findIndex((item) => item.url === record.url);
  if (existingIndex >= 0) records.splice(existingIndex, 1);
  records.unshift(record);
  if (records.length > MAX_PER_TAB) records.length = MAX_PER_TAB;
  await chrome.storage.session.set({ [storageKey(tabId)]: records });

  void chrome.tabs.sendMessage(tabId, {
    type: 'XUNLEI_ZHIQU_NETWORK_MEDIA_UPDATE',
    item: record
  }).catch(() => undefined);
}

async function readRecords(tabId: number): Promise<NetworkMediaRecord[]> {
  const key = storageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const value = stored[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, MAX_PER_TAB);
}

async function clearNetworkRecords(): Promise<void> {
  const stored = await chrome.storage.session.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(STORAGE_PREFIX));
  if (keys.length) await chrome.storage.session.remove(keys);
}

function classifyNetworkMedia(
  url: string,
  mimeType: string | null,
  contentDisposition: string | null,
  requestType: string
): NetworkMediaKind | null {
  const searchableUrl = decodeSearchableUrl(url);
  const dispositionFilename = filenameFromDisposition(contentDisposition);
  const searchableFilename = dispositionFilename ? decodeSearchableUrl(dispositionFilename) : '';

  if (HLS_PATTERN.test(searchableUrl) || HLS_PATTERN.test(searchableFilename) || isHlsMime(mimeType)) {
    return 'hls_manifest';
  }
  if (DASH_PATTERN.test(searchableUrl) || DASH_PATTERN.test(searchableFilename) || isDashMime(mimeType)) {
    return 'dash_manifest';
  }

  if (HLS_SEGMENT_PATTERN.test(searchableUrl) && requestType !== 'media') return null;
  if (mimeType && /video\/mp2t/i.test(mimeType) && requestType !== 'media') return null;

  if (requestType === 'media') return 'media_file';
  if (MEDIA_URL_PATTERN.test(searchableUrl) || MEDIA_URL_PATTERN.test(searchableFilename) || isMediaMime(mimeType)) {
    return 'media_file';
  }
  return null;
}

function decodeSearchableUrl(value: string): string {
  let decoded = value;
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8.trim().replace(/^"|"$/g, '')); } catch { return utf8.trim(); }
  }
  const plain = value.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  return (plain?.[1] || plain?.[2] || '').trim() || null;
}

function isMediaMime(value: string | null): boolean {
  return Boolean(value && /^(?:video|audio)\//i.test(value));
}

function isHlsMime(value: string | null): boolean {
  return Boolean(value && /(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(value));
}

function isDashMime(value: string | null): boolean {
  return Boolean(value && /application\/dash\+xml/i.test(value));
}

function readHeaders(headers: chrome.webRequest.HttpHeader[]): {
  contentType: string | null;
  contentLength: number | null;
  contentDisposition: string | null;
} {
  let contentType: string | null = null;
  let contentLength: number | null = null;
  let contentDisposition: string | null = null;

  for (const header of headers) {
    const name = header.name.toLowerCase();
    const value = header.value?.trim() || null;
    if (name === 'content-type' && value) contentType = value.split(';', 1)[0]?.trim() || value;
    else if (name === 'content-length' && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) contentLength = parsed;
    } else if (name === 'content-disposition' && value) contentDisposition = value;
  }
  return { contentType, contentLength, contentDisposition };
}

function isRecord(value: unknown): value is NetworkMediaRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<NetworkMediaRecord>;
  return typeof item.url === 'string'
    && ['media_file', 'hls_manifest', 'dash_manifest'].includes(String(item.kind));
}

function storageKey(tabId: number): string {
  return `${STORAGE_PREFIX}${tabId}`;
}
