$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

corepack pnpm build
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --host 127.0.0.1 --port 8765
