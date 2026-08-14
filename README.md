# 迅雷智取

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

产品与架构事实来源：`docs/blueprint/xunlei-zhiqu-v0.4.md`、`docs/blueprint/E0.md` 和 `docs/adr/`。Browser Extension、Runtime、Task Center 保持逻辑解耦；当前本地 Demo 可以迁移到迅雷客户端 / 服务端部署，而不把产品扩张成通用聊天助手或通用爬虫。

## 开发进度

- **Stage A~D：已完成** — 三端骨架、任务中心、真实框选/扫描、候选融合、Node A、ResourcePlan、自动发现、媒体/图片发现、EvidenceReducer、缓存和供应商适配。
- **Stage E0：已完成** — 架构迁移接缝、Node A 性能基线、Progressive Analysis UX（E0.1~E0.22）。
- **Stage E / Wave A：已完成并通过真实 HTTP 下载验收** — asset-aware execution plan、真实 HTTP/HTTPS 文件下载、真实 bytes/speed/ETA、当前进程内 pause/resume、cancel、`.part -> final`。
- **Stage E / Wave B：已完成** — `interrupted` 执行状态、最小 failure facts、真实/fixture 任务隔离、Task Center 真实状态语义、多 Asset 聚合呈现。
- **Stage E / Wave C：下一步** — HTTP Range、Runtime 重启恢复、轻量持久化、Preflight。
- **Stage F：未进入** — Diagnosis、Node B、来源恢复与可信 source switching。

## 当前架构

```text
Browser Extension
  -> ZhiquServiceClient
     -> LocalHttpTransport / future client-or-cloud transport
                |
                v
             Runtime
          /      |       \
         v       v        v
ModelProviderAdapter   ResourceJob   DownloadExecutorPort
         |                              |
ProviderApiAdapter                     +-- HttpDownloadExecutor
  -> DashScope/OpenAI/Generic          +-- NoopDownloadExecutor
                                        `-- future XunleiDownloadExecutor

Task Center
  -> TaskServiceClient
     -> HttpTaskServiceClient / future client bridge
```

关键边界：

- Extension 和 Task Center 产品组件不拼 Runtime URL 或 `/v1/*`；HTTP 细节属于各自 transport/client。
- `CaptureBatch != CloudAnalysisRequest`；真实 URL、页面 URL、Cookie/Authorization、临时 token、本地路径、完整 HTML 不会自动进入未来云分析。
- Runtime 通过 `ModelProviderAdapter` 隔离模型供应商，通过 `DownloadExecutorPort` 隔离具体下载引擎。
- `ResourceJob` 保存用户目标和任务元数据；真实执行进度、速度、ETA、当前文件和失败事实来自 DownloadExecutor。
- Cloud delivery 当前仍保持原 Demo 路径，不会被本地 HTTP executor 错误落盘。

详细边界见 `docs/adr/0001-runtime-boundaries-and-model-adapters.md` 和 `docs/adr/0002-client-runtime-cloud-analysis-and-service-ports.md`。

## Stage E：真实 HTTP 执行

### Asset-aware execution

Runtime 内部执行模型为：

```text
ResourceJob
  -> DownloadExecutionRequest
     -> DownloadExecutionAsset[]
        -> primary_source
        -> alternate_sources[]
```

一个 `ResourceJob` 是用户想完成的资源目标；一个 `DownloadExecutionAsset` 是真正需要落盘的一个逻辑文件；Source 只是这个文件的一个地址。

多个 candidate 只有在已有确定性证据证明同一资源时才归为一个 Asset，目前包括相同 `normalized_key` 或相同 canonical URL。PlanItem 同时引用多个 candidate 并不会自动让它们成为镜像。手工新建的不同 URL 也默认是不同 Asset，仅 canonical URL 完全相同时去重。

一个 Job 内多个 Asset 顺序下载，不并发、不分块。任务中心仍只显示一个外层 Job，`stage_label` 可以表达当前正在下载哪个 Asset。

### HttpDownloadExecutor

本地 `delivery_target=local` 默认使用真实 `HttpDownloadExecutor`：

```text
GET primary_source
-> follow redirect
-> Content-Disposition / final URL / filename_hint 选择文件名
-> filename sanitization + duplicate-safe naming
-> <filename>.part
-> streaming raw response bytes
-> 更新真实 downloaded bytes / speed / ETA
-> Content-Length 最小完成检查（若可用）
-> atomic .part -> final file
```

当前支持普通 HTTP/HTTPS 文件型直链，例如 ZIP/EXE/MSI/PDF/直接 MP4 等。当前不执行 Magnet/BT、HLS/DASH manifest、blob、FTP、aria2/qBittorrent/P2P。

Cancel 会停止当前任务并删除当前 `.part`。Runtime shutdown 与 Cancel 不同：shutdown 停止连接但保留 `.part`。普通执行失败同样保留已有 `.part`，供 Wave C 的 Range 恢复使用。

### Interrupted != waiting_for_source

Wave B 冻结了最重要的状态边界：

```text
执行连接/HTTP/本地写盘失败
        ↓
    interrupted
```

而不是：

```text
执行失败
   ↓
waiting_for_source
```

二者语义不同：

- `interrupted`：当前执行已经中断，但没有证明必须更换来源；
- `waiting_for_source`：已经得到“任务需要重新获取来源”的诊断结论，保留给 Stage F。

真实 HTTP executor 本 Wave 不主动产生 `waiting_for_source`。即使 HTTP 404/403/410，也先保存执行事实，例如 `failure_kind=http_error` 和 HTTP status，再对用户表达“下载中断 / 服务器未找到文件”等信息；是否属于来源失效由未来 Diagnosis 决定。

内部最小 failure facts：

```text
connection_interrupted
http_error (+ http_status_code)
length_mismatch
local_io
unknown
```

这些是 Runtime-internal facts，不直接展示 enum 给用户。

### Pause / Resume

当前 Pause/Resume 仍是 Wave A 的 cooperative stream pause：

```text
downloading
   ↓ pause
paused
   ↓ resume（原 HTTP stream 仍存活）
downloading
```

如果长暂停后服务器已经关闭原 connection：

```text
paused
   ↓ resume
原 stream 读取失败
   ↓
interrupted
```

Wave B 不会从 byte 0 自动重启下载，也不会假装已经支持断点续传。`interrupted` 当前 `next_action=null`，Task Center 不显示不可工作的继续按钮。真正稳定的 Resume 留给 Wave C 的 HTTP Range。

### 状态事实来源

`execution_mode=download_engine` 的真实任务永远不会进入 `_advance_demo_job()`。GET `/v1/jobs` 和 `/v1/jobs/{job_id}` 使用 Executor 当前状态投影公开快照：

```text
queued      -> planning
downloading -> downloading
paused      -> paused
failed      -> interrupted
completed   -> completed
```

对于已知总大小：

```text
progress = downloaded_bytes / total_bytes
```

如果多 Asset 中仍有未知 size，`total_bytes=0` 表达“总大小尚未知”，Task Center 只展示已下载字节，不伪造百分比。

Link History 对 `downloading / paused / interrupted / waiting_for_source` 都保持 `active`；只有完成任务映射 `completed`。一次临时连接中断不会永久把链接标成 failed。

## 真实任务与 Fixture 隔离

默认运行不再自动注入 Stage B 示例任务：

```dotenv
DOWNLOAD_EXECUTOR=http
TASK_FIXTURES_ENABLED=false
```

此时 Runtime 新启动后 `/v1/jobs` 默认为空，只有用户真实创建任务后才出现任务。`DOWNLOAD_EXECUTOR=noop` 与 UI fixture 是两件独立的事，不会互相隐式开启。

只有显式 UI 开发时才启用：

Runtime：

```dotenv
TASK_FIXTURES_ENABLED=true
```

Task Center `apps/task-center/.env.local`：

```dotenv
VITE_TASK_CENTER_FIXTURES=true
```

真实使用保持：

```dotenv
VITE_TASK_CENTER_FIXTURES=false
```

Task Center 在本地服务未连接时不再用 Example App 等 fixture 冒充真实任务；首次连接失败会显示“本地服务未连接”，已经获取过真实 snapshot 后发生断连则保留最后一次真实状态。

## Task Center 状态语义

用户侧状态现在明确区分：

```text
planning            准备下载
downloading         正在下载
paused              已暂停
interrupted         下载中断
waiting_for_source  需要续取
completed           已完成
```

顶部总速度只统计 `status=downloading` 的任务；paused/interrupted/waiting/completed 均不计入。Issue 筛选和通知同时覆盖 `interrupted` 与 `waiting_for_source`，主动暂停不算异常。

完成任务的当前主要动作是“复制保存位置”，因为浏览器 Demo 尚未真正打开 Windows Explorer；不会用“打开文件夹”文案伪装成已实现能力。

任务详情只展示文件/任务名称、保存位置、真实进度、速度、剩余时间、当前正在下载的资源和来源页面，不展示 asset id、candidate id、failure enum、source credential 或执行引擎内部状态。

## Node A 稳定配置

Stage E 不继续优化 Node A。当前已 benchmark 的推荐组合继续冻结：

```dotenv
MODEL_PROVIDER=dashscope
MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=deepseek-v4-flash
NODE_A_PROFILE=pipeline_v3
MODEL_STREAM_DIAGNOSTICS=false
MODEL_HTTP2_ENABLED=false
```

`pipeline` 保留为 v2 rollback profile。

## 本地配置

首次安装：

```powershell
corepack pnpm install
uv sync --project services/runtime
Copy-Item .env.example .env
```

Runtime `.env` 示例：

```dotenv
MODEL_PROVIDER=dashscope
ENABLE_FIXTURE_PROVIDER=false
MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=deepseek-v4-flash
MODEL_API_KEY=your-local-runtime-key
NODE_A_PROFILE=pipeline_v3
MODEL_STREAM_DIAGNOSTICS=false
MODEL_HTTP2_ENABLED=false

PLAN_CACHE_TTL_SECONDS=1200
PLAN_CACHE_MAX_ENTRIES=64

DOWNLOAD_EXECUTOR=http
DOWNLOAD_DIRECTORY=
TASK_FIXTURES_ENABLED=false

RUNTIME_AUTH_MODE=off
```

Extension 开发配置 `apps/extension/.env.local`：

```dotenv
VITE_RUNTIME_URL=http://127.0.0.1:8765
VITE_ZHIQU_CAPABILITY_MODE=demo_local
VITE_ZHIQU_ANALYSIS_CREDENTIAL=demo
VITE_RUNTIME_SESSION=
```

Task Center 真实模式 `apps/task-center/.env.local`：

```dotenv
VITE_RUNTIME_URL=http://127.0.0.1:8765
VITE_RUNTIME_SESSION=
VITE_TASK_CENTER_FIXTURES=false
```

## 启动

Runtime：

```powershell
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --reload --host 127.0.0.1 --port 8765
```

Task Center：

```powershell
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

Extension 构建并旁加载 `apps/extension/dist`：

```powershell
corepack pnpm --filter @xunlei-zhiqu/extension build
```

## Stage E-B 自动检查

```powershell
corepack pnpm typecheck

Remove-Item -Recurse -Force .\apps\extension\dist -ErrorAction SilentlyContinue
corepack pnpm --filter @xunlei-zhiqu/extension build
corepack pnpm --filter @xunlei-zhiqu/task-center build
Select-String -Path .\apps\extension\dist\content.js -Pattern '^\s*import'

uv run --project services/runtime python -m compileall services/runtime/src
uv run --project services/runtime pytest `
  services/runtime/tests/test_e0_architecture_seams.py `
  services/runtime/tests/test_stage_e_download_execution.py `
  -q
```

`Select-String` 必须无输出。

Stage E-B 测试重点保护：ExecutionAsset identity、真实任务不走 Demo progress、connection failure → `interrupted`、pause → speed 0 / resume action、`waiting_for_source` 仍是合法未来状态、fixture 显式开关、HTTP 404 failure facts、连接中断保留 `.part`、cancel 删除 `.part`、以及多 Asset 聚合 bytes/current asset label。

## Stage E-B 人工验收

### 1. 干净启动

新启动 Runtime 和 Task Center，默认不应出现 Example App / sample-dataset 等示例任务。

### 2. 真实 JDK 下载

```text
扫描 / 框选
-> 智能分析
-> 确认 Windows x64 文件
-> 保存到本地
-> 打开任务中心
```

任务中心只应看到真实创建的任务，总速度来自真实 `downloading` Job。

### 3. 短暂停

暂停后：

```text
状态 = 已暂停
speed = 0
.part 不再增长
```

很快继续，如果原 HTTP stream 仍存活，应继续下载。

### 4. 连接中断

如果服务器在暂停期间关闭 connection，随后继续读取失败：

```text
状态 = 下载中断
issue = 下载连接已中断（或具体 HTTP/长度错误）
next_action = null
.part 保留
```

不得自动变成“需要续取”。

### 5. HTTP 404

手工创建一个返回 404 的 URL，应显示：

```text
下载中断
服务器未找到文件
```

本 Wave 不自动调用 Node B 或切换来源。

### 6. Cancel

取消未完成/中断任务后，任务消失，当前 `.part` 删除。

## 下一步：Stage E / Wave C

Wave C 才实现下载器意义上的稳定续传：

```text
.part offset
+
HTTP Range: bytes=<offset>-
+
轻量任务持久化
+
Runtime 重启恢复
+
Preflight
```

Wave B 明确没有实现：HTTP Range、断点续传、Runtime 重启恢复、SQLite、完整 Preflight、磁盘空间体系、自动 source failover、Diagnosis Controller、Node B、ReacquisitionRequest、一键续取、Hash/chunk identity、WebSocket、多线程分块、BT/Magnet、HLS/DASH executor。
