/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RUNTIME_URL?: string;
  readonly VITE_RUNTIME_SESSION?: string;
  readonly VITE_TASK_CENTER_FIXTURES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
