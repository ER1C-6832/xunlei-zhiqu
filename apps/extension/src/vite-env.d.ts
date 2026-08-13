/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RUNTIME_URL?: string;
  readonly VITE_RUNTIME_SESSION?: string;
  readonly VITE_ZHIQU_CAPABILITY_MODE?:
    | 'demo_local'
    | 'client_runtime'
    | 'cloud_analysis'
    | 'local_only';
  readonly VITE_ZHIQU_ANALYSIS_CREDENTIAL?:
    | 'demo'
    | 'anonymous'
    | 'client_session'
    | 'web_session'
    | 'guest_trial'
    | 'none';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
