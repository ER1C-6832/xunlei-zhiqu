import type {
  CaptureBatch,
  LinkFavoriteCreateRequest,
  LinkHistoryItem,
  ManualJobCreateRequest,
  ResourceJobCreateRequest,
  ResourceJobSnapshot,
  ResourcePlan,
  ZhiquCapabilities
} from '@xunlei-zhiqu/contracts';
import { resolveFixtureZhiquCapabilities } from './capabilityResolver';
import { LocalHttpTransport } from './transports/localHttpTransport';

export type TaskCenterTarget = 'downloads' | 'links';

export type AnalyzeResourcesOptions = {
  forceRefresh?: boolean;
};

export type ZhiquCapabilityResolver = () => Promise<ZhiquCapabilities> | ZhiquCapabilities;

export interface ZhiquServiceTransport {
  analyzeResources(batch: CaptureBatch, options?: AnalyzeResourcesOptions): Promise<ResourcePlan>;
  createJob(request: ResourceJobCreateRequest): Promise<ResourceJobSnapshot>;
  createManualJob(request: ManualJobCreateRequest): Promise<ResourceJobSnapshot>;
  favoriteResource(request: LinkFavoriteCreateRequest): Promise<LinkHistoryItem>;
  openTaskCenter(target: TaskCenterTarget): Promise<void>;
}

export interface ZhiquServiceClient {
  getCapabilities(): Promise<ZhiquCapabilities>;
  analyzeResources(batch: CaptureBatch, options?: AnalyzeResourcesOptions): Promise<ResourcePlan>;
  createJob(request: ResourceJobCreateRequest): Promise<ResourceJobSnapshot>;
  createManualJob(request: ManualJobCreateRequest): Promise<ResourceJobSnapshot>;
  favoriteResource(request: LinkFavoriteCreateRequest): Promise<LinkHistoryItem>;
  openTaskCenter(target?: TaskCenterTarget): Promise<void>;
}

export class DefaultZhiquServiceClient implements ZhiquServiceClient {
  constructor(
    private readonly transport: ZhiquServiceTransport,
    private readonly capabilityResolver: ZhiquCapabilityResolver = resolveFixtureZhiquCapabilities
  ) {}

  async getCapabilities(): Promise<ZhiquCapabilities> {
    return this.capabilityResolver();
  }

  analyzeResources(batch: CaptureBatch, options?: AnalyzeResourcesOptions) {
    return this.transport.analyzeResources(batch, options);
  }

  createJob(request: ResourceJobCreateRequest) {
    return this.transport.createJob(request);
  }

  createManualJob(request: ManualJobCreateRequest) {
    return this.transport.createManualJob(request);
  }

  favoriteResource(request: LinkFavoriteCreateRequest) {
    return this.transport.favoriteResource(request);
  }

  openTaskCenter(target: TaskCenterTarget = 'downloads') {
    return this.transport.openTaskCenter(target);
  }
}

export const zhiquService: ZhiquServiceClient = new DefaultZhiquServiceClient(
  new LocalHttpTransport()
);
