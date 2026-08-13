import type {
  CaptureBatch,
  LinkFavoriteCreateRequest,
  LinkHistoryItem,
  ManualJobCreateRequest,
  ResourceJobCreateRequest,
  ResourceJobSnapshot,
  ResourcePlan
} from '@xunlei-zhiqu/contracts';
import type {
  TaskCenterTarget,
  TransportAnalyzeResourcesOptions,
  ZhiquServiceTransport
} from '../zhiquServiceClient';

const DEFAULT_RUNTIME_ENDPOINT = 'http://127.0.0.1:8765';

export class ZhiquTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = 'ZhiquTransportError';
  }
}

export class LocalHttpTransport implements ZhiquServiceTransport {
  private readonly endpoint: string;
  private readonly sessionToken: string | null;

  constructor(
    endpoint = getRuntimeEndpoint(),
    sessionToken = getRuntimeSessionToken()
  ) {
    this.endpoint = normalizeEndpoint(endpoint);
    this.sessionToken = sessionToken;
  }

  analyzeResources(
    batch: CaptureBatch,
    options: TransportAnalyzeResourcesOptions
  ): Promise<ResourcePlan> {
    const forceRefresh = options.forceRefresh === true;
    const suffix = forceRefresh ? '?refresh=true' : '';
    // AnalysisCredential is a logical authorization handle. The local Demo transport
    // intentionally does not serialize it into CaptureBatch; future client/cloud
    // transports resolve the handle at their own authentication boundary.
    return this.postJson<ResourcePlan>(
      `/v1/capture/analyze${suffix}`,
      batch,
      forceRefresh ? '重新智能分析失败' : '智能分析失败'
    );
  }

  createJob(request: ResourceJobCreateRequest): Promise<ResourceJobSnapshot> {
    return this.postJson<ResourceJobSnapshot>('/v1/jobs', request, '创建下载任务失败');
  }

  createManualJob(request: ManualJobCreateRequest): Promise<ResourceJobSnapshot> {
    return this.postJson<ResourceJobSnapshot>('/v1/jobs/manual', request, '创建任务失败');
  }

  favoriteResource(request: LinkFavoriteCreateRequest): Promise<LinkHistoryItem> {
    return this.postJson<LinkHistoryItem>('/v1/link-library/favorites', request, '收藏失败');
  }

  async openTaskCenter(target: TaskCenterTarget): Promise<void> {
    await chrome.tabs.create({ url: `${this.endpoint}/app/#/${target}` });
  }

  private async postJson<T>(path: string, body: unknown, fallback: string): Promise<T> {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (this.sessionToken) headers.set('X-Zhiqu-Session', this.sessionToken);

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ZhiquTransportError(`${fallback}：${detail}`);
    }

    if (!response.ok) {
      throw new ZhiquTransportError(
        `${fallback}：${await responseDetail(response)}`,
        response.status
      );
    }

    return response.json() as Promise<T>;
  }
}

export function getRuntimeEndpoint(): string {
  const configured = import.meta.env.VITE_RUNTIME_URL?.trim();
  return normalizeEndpoint(configured || DEFAULT_RUNTIME_ENDPOINT);
}

export function getRuntimeSessionToken(): string | null {
  const configured = import.meta.env.VITE_RUNTIME_SESSION?.trim();
  return configured || null;
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '') || DEFAULT_RUNTIME_ENDPOINT;
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail.trim();
  } catch {
    // Fall through to the stable HTTP status when the response is not JSON.
  }
  return `HTTP ${response.status}`;
}
