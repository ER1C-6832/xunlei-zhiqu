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

const STORAGE_PREFIX = 'zhiqu_network_media_tab_';
const MAX_PER_TAB = 120;
const MEDIA_URL_PATTERN = /\.(?:3g2|3gp|aac|aiff|amr|ape|asf|avi|av1|divx|f4v|flac|flv|m2t|m2ts|m4a|m4v|mid|mka|mkv|mov|mp3|mp4|mpe|mpeg|mpg|mpga|ogg|opus|qt|ra|rm|rmvb|ts|vob|wav|webm|wma)(?:[?#]|$)/i;
const HLS_PATTERN = /\.m3u8(?:[?#]|$)/i;
const DASH_PATTERN = /\.mpd(?:[?#]|$)/i;

export function registerNetworkMediaCapture(): void {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0 || !/^https?:/i.test(details.url)) return;
      const headers = readHeaders(details.responseHeaders || []);
      const kind = classifyNetworkMedia(details.url, headers.contentType);
      if (!kind) return;

      const record: NetworkMediaRecord = {
        url: details.url,
        kind,
        mime_type: headers.contentType,
        content_length: headers.contentLength,
        content_disposition: headers.contentDisposition,
        request_type: details.type,
        detected_at: Date.now()
      };
      void saveRecord(details.tabId, record);
    },
    { urls: ['http://*/*', 'https://*/*'] },
    ['responseHeaders']
  );

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'XUNLEI_ZHIQU_NETWORK_MEDIA_GET') return false;
    const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: true, items: [] });
      return false;
    }
    void readRecords(tabId)
      .then((items) => sendResponse({ ok: true, items }))
      .catch(() => sendResponse({ ok: true, items: [] }));
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.session.remove(storageKey(tabId));
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' && changeInfo.url) {
      void chrome.storage.session.remove(storageKey(tabId));
    }
  });
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

function classifyNetworkMedia(url: string, mimeType: string | null): NetworkMediaKind | null {
  if (HLS_PATTERN.test(url) || isHlsMime(mimeType)) return 'hls_manifest';
  if (DASH_PATTERN.test(url) || isDashMime(mimeType)) return 'dash_manifest';
  if (MEDIA_URL_PATTERN.test(url) || isMediaMime(mimeType)) return 'media_file';
  return null;
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
