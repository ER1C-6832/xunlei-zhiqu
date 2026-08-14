import type { AnalysisAccess, AnalysisCredential, AnalysisStreamEvent, CaptureBatch, LinkFavoriteCreateRequest, LinkHistoryItem, ManualJobCreateRequest, PendingRecoveryView, RecoveryCandidateChoiceResult, RecoveryCaptureResult, ResourceJobCreateRequest, ResourceJobSnapshot, ResourcePlan, ZhiquCapabilities } from '@xunlei-zhiqu/contracts';
import { resolveAnalysisAccess, resolveFixtureAnalysisCredential } from './analysisCredential';
import { resolveFixtureZhiquCapabilities } from './capabilityResolver';
import { LocalHttpTransport } from './transports/localHttpTransport';
export type TaskCenterTarget = 'downloads' | 'links';
export type AnalyzeResourcesOptions = { forceRefresh?: boolean; onEvent?: (event: AnalysisStreamEvent) => void; };
export type TransportAnalyzeResourcesOptions = AnalyzeResourcesOptions & { analysisCredential: AnalysisCredential; };
export type ZhiquCapabilityResolver = () => Promise<ZhiquCapabilities> | ZhiquCapabilities;
export type AnalysisCredentialResolver = () => Promise<AnalysisCredential | null> | AnalysisCredential | null;
export interface ZhiquServiceTransport { analyzeResources(batch: CaptureBatch, options: TransportAnalyzeResourcesOptions): Promise<ResourcePlan>; createJob(request: ResourceJobCreateRequest): Promise<ResourceJobSnapshot>; createManualJob(request: ManualJobCreateRequest): Promise<ResourceJobSnapshot>; favoriteResource(request: LinkFavoriteCreateRequest): Promise<LinkHistoryItem>; listPendingRecoveries(): Promise<PendingRecoveryView[]>; submitRecoveryCapture(recoveryId: string, batch: CaptureBatch): Promise<RecoveryCaptureResult>; chooseRecoveryCandidate(recoveryId: string, candidateId: string): Promise<RecoveryCandidateChoiceResult>; openTaskCenter(target: TaskCenterTarget): Promise<void>; }
export interface ZhiquServiceClient { getCapabilities(): Promise<ZhiquCapabilities>; getAnalysisAccess(): Promise<AnalysisAccess>; analyzeResources(batch: CaptureBatch, options?: AnalyzeResourcesOptions): Promise<ResourcePlan>; createJob(request: ResourceJobCreateRequest): Promise<ResourceJobSnapshot>; createManualJob(request: ManualJobCreateRequest): Promise<ResourceJobSnapshot>; favoriteResource(request: LinkFavoriteCreateRequest): Promise<LinkHistoryItem>; listPendingRecoveries(): Promise<PendingRecoveryView[]>; submitRecoveryCapture(recoveryId: string, batch: CaptureBatch): Promise<RecoveryCaptureResult>; chooseRecoveryCandidate(recoveryId: string, candidateId: string): Promise<RecoveryCandidateChoiceResult>; openTaskCenter(target?: TaskCenterTarget): Promise<void>; }
export class DefaultZhiquServiceClient implements ZhiquServiceClient {
  constructor(private readonly transport: ZhiquServiceTransport, private readonly capabilityResolver: ZhiquCapabilityResolver = resolveFixtureZhiquCapabilities, private readonly credentialResolver: AnalysisCredentialResolver = resolveFixtureAnalysisCredential) {}
  async getCapabilities(): Promise<ZhiquCapabilities> { return this.capabilityResolver(); }
  async getAnalysisAccess(): Promise<AnalysisAccess> { const [capabilities, credential] = await Promise.all([this.capabilityResolver(), this.credentialResolver()]); return resolveAnalysisAccess(capabilities, credential); }
  async analyzeResources(batch: CaptureBatch, options?: AnalyzeResourcesOptions): Promise<ResourcePlan> { const access = await this.getAnalysisAccess(); if (!access.canAnalyze || !access.analysisCredential) throw new Error('当前没有可用的智能分析凭据。'); return this.transport.analyzeResources(batch, { ...options, analysisCredential: access.analysisCredential }); }
  createJob(request: ResourceJobCreateRequest) { return this.transport.createJob(request); }
  createManualJob(request: ManualJobCreateRequest) { return this.transport.createManualJob(request); }
  favoriteResource(request: LinkFavoriteCreateRequest) { return this.transport.favoriteResource(request); }
  listPendingRecoveries() { return this.transport.listPendingRecoveries(); }
  submitRecoveryCapture(recoveryId: string, batch: CaptureBatch) { return this.transport.submitRecoveryCapture(recoveryId, batch); }
  chooseRecoveryCandidate(recoveryId: string, candidateId: string) { return this.transport.chooseRecoveryCandidate(recoveryId, candidateId); }
  openTaskCenter(target: TaskCenterTarget = 'downloads') { return this.transport.openTaskCenter(target); }
}
export const zhiquService: ZhiquServiceClient = new DefaultZhiquServiceClient(new LocalHttpTransport());
