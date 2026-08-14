import type { LinkFavoriteUpdateRequest, LinkHistoryItem, ManualJobCreateRequest, RecoveryHandoff, ResourceJobSnapshot, TaskAction } from '@xunlei-zhiqu/contracts';
export type RuntimeInfo = { status: string; provider: string; version: string; };
export type JobSubscriber = (jobs: ResourceJobSnapshot[]) => void;
const jobSubscribers = new Set<JobSubscriber>();
export function subscribeJobs(subscriber: JobSubscriber): () => void { jobSubscribers.add(subscriber); return () => jobSubscribers.delete(subscriber); }
function publishJobs(jobs: ResourceJobSnapshot[]) { for (const subscriber of jobSubscribers) subscriber(jobs); }
export class TaskServiceError extends Error { constructor(message: string, readonly status: number | null = null) { super(message); this.name = 'TaskServiceError'; } }
export interface TaskServiceClient { listJobs(): Promise<ResourceJobSnapshot[]>; getJob(jobId: string): Promise<ResourceJobSnapshot>; pauseJob(jobId: string): Promise<ResourceJobSnapshot>; resumeJob(jobId: string): Promise<ResourceJobSnapshot>; continueAcquisition(jobId: string): Promise<RecoveryHandoff>; cancelJob(jobId: string): Promise<void>; createManualJob(request: ManualJobCreateRequest): Promise<ResourceJobSnapshot>; listLinkLibrary(): Promise<LinkHistoryItem[]>; setFavorite(historyId: string, request: LinkFavoriteUpdateRequest): Promise<LinkHistoryItem>; getRuntimeInfo(): Promise<RuntimeInfo>; }
export class HttpTaskServiceClient implements TaskServiceClient {
  private readonly endpoint: string; private readonly sessionToken: string | null;
  constructor(endpoint = getRuntimeEndpoint(), sessionToken = getRuntimeSessionToken()) { this.endpoint = normalizeEndpoint(endpoint); this.sessionToken = sessionToken; }
  async listJobs(): Promise<ResourceJobSnapshot[]> { const jobs = await this.requestJson<ResourceJobSnapshot[]>('/v1/jobs', { cache: 'no-store' }, '读取任务失败'); publishJobs(jobs); return jobs; }
  getJob(jobId: string): Promise<ResourceJobSnapshot> { return this.requestJson(`/v1/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' }, '读取任务失败'); }
  pauseJob(jobId: string): Promise<ResourceJobSnapshot> { return this.postAction(jobId, 'pause'); }
  resumeJob(jobId: string): Promise<ResourceJobSnapshot> { return this.postAction(jobId, 'resume'); }
  continueAcquisition(jobId: string): Promise<RecoveryHandoff> { return this.requestJson(`/v1/jobs/${encodeURIComponent(jobId)}/continue-acquisition`, { method: 'POST' }, '一键续取失败'); }
  async cancelJob(jobId: string): Promise<void> { await this.request(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }, '取消任务失败'); }
  createManualJob(request: ManualJobCreateRequest): Promise<ResourceJobSnapshot> { return this.requestJson('/v1/jobs/manual', this.jsonPost(request), '创建任务失败'); }
  listLinkLibrary(): Promise<LinkHistoryItem[]> { return this.requestJson('/v1/link-library', { cache: 'no-store' }, '读取链接库失败'); }
  setFavorite(historyId: string, request: LinkFavoriteUpdateRequest): Promise<LinkHistoryItem> { return this.requestJson(`/v1/link-library/${encodeURIComponent(historyId)}/favorite`, this.jsonPost(request), '收藏操作失败'); }
  getRuntimeInfo(): Promise<RuntimeInfo> { return this.requestJson('/v1/health', { cache: 'no-store' }, '读取本地服务状态失败'); }
  private postAction(jobId: string, action: Extract<TaskAction, 'pause' | 'resume'>): Promise<ResourceJobSnapshot> { return this.requestJson(`/v1/jobs/${encodeURIComponent(jobId)}/${action}`, { method: 'POST' }, action === 'pause' ? '暂停任务失败' : '恢复任务失败'); }
  private jsonPost(body: unknown): RequestInit { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
  private async requestJson<T>(path: string, init: RequestInit, fallback: string): Promise<T> { const response = await this.request(path, init, fallback); try { return await response.json() as T; } catch (error) { const detail = error instanceof Error ? error.message : String(error); throw new TaskServiceError(`${fallback}：响应格式无效（${detail}）`, response.status); } }
  private async request(path: string, init: RequestInit, fallback: string): Promise<Response> { const headers = new Headers(init.headers); if (this.sessionToken) headers.set('X-Zhiqu-Session', this.sessionToken); let response: Response; try { response = await fetch(`${this.endpoint}${path}`, { ...init, headers }); } catch (error) { const detail = error instanceof Error ? error.message : String(error); throw new TaskServiceError(`${fallback}：${detail}`); } if (!response.ok) throw new TaskServiceError(`${fallback}：${await responseDetail(response)}`, response.status); return response; }
}
export const taskService: TaskServiceClient = new HttpTaskServiceClient();
function getRuntimeEndpoint(): string { const configured = import.meta.env.VITE_RUNTIME_URL?.trim(); if (configured) return normalizeEndpoint(configured); return import.meta.env.PROD ? window.location.origin : 'http://127.0.0.1:8765'; }
function getRuntimeSessionToken(): string | null { const value = import.meta.env.VITE_RUNTIME_SESSION?.trim(); return value || null; }
function normalizeEndpoint(value: string): string { return value.trim().replace(/\/+$/, ''); }
async function responseDetail(response: Response): Promise<string> { try { const body = await response.json() as { detail?: unknown }; if (typeof body.detail === 'string' && body.detail.trim()) return body.detail.trim(); } catch {} return `HTTP ${response.status}`; }
