import type {
  AnalysisAccess,
  AnalysisCredential,
  ZhiquCapabilities
} from '@xunlei-zhiqu/contracts';

export type AnalysisCredentialFixture =
  | 'demo'
  | 'anonymous'
  | 'client_session'
  | 'web_session'
  | 'guest_trial'
  | 'none';

const DEFAULT_ANALYSIS_CREDENTIAL: AnalysisCredentialFixture = 'demo';

export function resolveFixtureAnalysisCredential(): AnalysisCredential | null {
  const configured = (import.meta.env.VITE_ZHIQU_ANALYSIS_CREDENTIAL || DEFAULT_ANALYSIS_CREDENTIAL)
    .trim()
    .toLowerCase();

  if (configured === 'none') return null;
  if (isAnalysisCredentialFixture(configured)) {
    return {
      schema_version: '0.1',
      kind: configured
    };
  }

  console.warn(
    `[迅雷智取] 未识别的 VITE_ZHIQU_ANALYSIS_CREDENTIAL=${configured}，回退到 ${DEFAULT_ANALYSIS_CREDENTIAL}`
  );
  return {
    schema_version: '0.1',
    kind: DEFAULT_ANALYSIS_CREDENTIAL
  };
}

export function resolveAnalysisAccess(
  capabilities: ZhiquCapabilities,
  credential: AnalysisCredential | null
): AnalysisAccess {
  return {
    canAnalyze: capabilities.intelligentAnalysis && credential !== null,
    analysisCredential: capabilities.intelligentAnalysis ? credential : null
  };
}

function isAnalysisCredentialFixture(value: string): value is Exclude<AnalysisCredentialFixture, 'none'> {
  return value === 'demo'
    || value === 'anonymous'
    || value === 'client_session'
    || value === 'web_session'
    || value === 'guest_trial';
}
