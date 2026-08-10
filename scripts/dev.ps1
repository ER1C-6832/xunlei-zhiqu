$Root = Split-Path -Parent $PSScriptRoot

Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$Root'; uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --reload --host 127.0.0.1 --port 8765"
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$Root'; corepack pnpm --filter @xunlei-zhiqu/task-center dev"
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$Root'; corepack pnpm --filter @xunlei-zhiqu/extension dev"

Write-Host '迅雷智取三个组件已分别启动。'
Write-Host '任务中心: http://127.0.0.1:5173'
Write-Host 'Runtime API: http://127.0.0.1:8765/docs'
Write-Host '扩展目录: apps/extension/dist'
