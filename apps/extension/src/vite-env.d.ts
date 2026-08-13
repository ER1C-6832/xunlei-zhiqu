/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RUNTIME_URL?: string;
  readonly VITE_ZHIQU_CAPABILITY_MODE?:
    | 'demo_local'
    | 'client_runtime'
    | 'cloud_analysis'
    | 'local_only';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
