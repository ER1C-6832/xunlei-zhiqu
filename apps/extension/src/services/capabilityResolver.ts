import type { ZhiquCapabilities } from '@xunlei-zhiqu/contracts';

export type CapabilityFixtureMode =
  | 'demo_local'
  | 'client_runtime'
  | 'cloud_analysis'
  | 'local_only';

export type CapabilityProbe = {
  clientRuntimeAvailable: boolean;
  cloudAnalysisAvailable: boolean;
  demoLocalRuntimeAvailable: boolean;
};

const DEFAULT_FIXTURE_MODE: CapabilityFixtureMode = 'demo_local';

const DEMO_LOCAL_CAPABILITIES: ZhiquCapabilities = {
  schema_version: '0.1',
  localDiscovery: true,
  intelligentAnalysis: true,
  localDownload: true,
  cloudDelivery: true,
  reacquisition: false,
  runtimeKind: 'demo_local'
};

const CLIENT_RUNTIME_CAPABILITIES: ZhiquCapabilities = {
  schema_version: '0.1',
  localDiscovery: true,
  intelligentAnalysis: true,
  localDownload: true,
  cloudDelivery: true,
  reacquisition: true,
  runtimeKind: 'client'
};

const CLOUD_ANALYSIS_CAPABILITIES: ZhiquCapabilities = {
  schema_version: '0.1',
  localDiscovery: true,
  intelligentAnalysis: true,
  localDownload: false,
  cloudDelivery: false,
  reacquisition: false,
  runtimeKind: 'cloud_analysis'
};

const LOCAL_ONLY_CAPABILITIES: ZhiquCapabilities = {
  schema_version: '0.1',
  localDiscovery: true,
  intelligentAnalysis: false,
  localDownload: false,
  cloudDelivery: false,
  reacquisition: false,
  runtimeKind: 'none'
};

export function resolveZhiquCapabilities(probe: CapabilityProbe): ZhiquCapabilities {
  if (probe.clientRuntimeAvailable) return copyCapabilities(CLIENT_RUNTIME_CAPABILITIES);
  if (probe.cloudAnalysisAvailable) return copyCapabilities(CLOUD_ANALYSIS_CAPABILITIES);
  if (probe.demoLocalRuntimeAvailable) return copyCapabilities(DEMO_LOCAL_CAPABILITIES);
  return copyCapabilities(LOCAL_ONLY_CAPABILITIES);
}

export function resolveFixtureZhiquCapabilities(
  mode: CapabilityFixtureMode = getConfiguredCapabilityMode()
): ZhiquCapabilities {
  return resolveZhiquCapabilities(fixtureProbe(mode));
}

export function getConfiguredCapabilityMode(): CapabilityFixtureMode {
  const configured = import.meta.env.VITE_ZHIQU_CAPABILITY_MODE?.trim().toLowerCase();
  if (!configured) return DEFAULT_FIXTURE_MODE;
  if (isCapabilityFixtureMode(configured)) return configured;

  console.warn(
    `[迅雷智取] 未识别的 VITE_ZHIQU_CAPABILITY_MODE=${configured}，回退到 ${DEFAULT_FIXTURE_MODE}`
  );
  return DEFAULT_FIXTURE_MODE;
}

export function fixtureProbe(mode: CapabilityFixtureMode): CapabilityProbe {
  return {
    clientRuntimeAvailable: mode === 'client_runtime',
    cloudAnalysisAvailable: mode === 'cloud_analysis',
    demoLocalRuntimeAvailable: mode === 'demo_local'
  };
}

function isCapabilityFixtureMode(value: string): value is CapabilityFixtureMode {
  return value === 'demo_local'
    || value === 'client_runtime'
    || value === 'cloud_analysis'
    || value === 'local_only';
}

function copyCapabilities(capabilities: ZhiquCapabilities): ZhiquCapabilities {
  return { ...capabilities };
}
