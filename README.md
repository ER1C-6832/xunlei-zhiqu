# 迅雷智取

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

产品与架构事实来源：`docs/blueprint/xunlei-zhiqu-v0.4.md`、`docs/blueprint/E0.md` 和 `docs/adr/`。Browser Extension、Runtime、Task Center 保持逻辑解耦；当前本地 Demo 可以迁移到迅雷客户端 / 服务端部署，而不把产品扩张成通用聊天助手或通用爬虫。

## 开发进度

- **Stage A~D：已完成** — 三端骨架、任务中心、真实框选/扫描、候选融合、Node A、ResourcePlan、自动发现、媒体/图片发现、EvidenceReducer、缓存和供应商适配。
- **Stage E0：已完成** — 架构迁移接缝、Node A 性能基线、Progressive Analysis UX（E0.1~E0.22）。
- **Stage E / Wave A：已完成实现，待真实页面验收** — asset-aware execution plan、真实 HTTP/HTTPS 文件下载、真实进度/速度/ETA、当前进程内 pause/resume、真实 cancel、`.part -> final`。
- **Stage E 后续：未进入** — Runtime 重启恢复、HTTP Range、持久化和更完整的执行前检查。
- **Stage F：未进入** — Node B、Diagnosis、来源恢复与可信 source switching。

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
ProviderApiAdapter                     +-- HttpDownloadExecutor   # Stage E-A real local path
  -> DashScope/OpenAI/Generic          +-- NoopDownloadExecutor   # fixture/fallback
                                        `-- future XunleiDownloadExecutor

Task Center
  -> TaskServiceClient
     -> HttpTaskServiceClient / future client bridge
```

关键边界：

- Extension 和 Task Center 的产品组件不拼 Runtime URL 或 `/v1/*`；HTTP 细节属于各自 transport/client。
- `CaptureBatch != CloudAnalysisRequest`；真实 URL、页面 URL、Cookie/Authorization、临时 token、本地路径、完整 HTML 不会自动进入未来云分析。
- Runtime 通过 `ModelProviderAdapter` 隔离模型供应商，通过 `DownloadExecutorPort` 隔离具体下载引擎。
- 本地真实任务的执行事实来自 DownloadExecutor；JobStore 保存任务元数据和用户目标。
- Cloud delivery 当前仍是 Demo，不会因为 Stage E-A 被错误下载到本地。

详细决策见 `docs/adr/0001-runtime-boundaries-and-model-adapters.md` 和 `docs/adr/0002-client-runtime-cloud-analysis-and-service-ports.md`。

## Stage E-A：真实 HTTP 下载

### 执行身份

不再使用：

```text
ResourceJob -> flat URL[]
```

现在是：

```text
ResourceJob
  -> DownloadExecutionRequest
     -> DownloadExecutionAsset[]
        -> primary_source
        -> alternate_sources[]
```

`ResourceJob` 是用户想完成的资源目标；`DownloadExecutionAsset` 是真正需要落盘的一个逻辑文件；Source 是这个文件的一个地址。

多个 candidate 只有在已有确定性证据证明同一资源时才归为一个 Asset，目前包括：

- `normalized_key` 相同；
- canonical URL 相同。

PlanItem 同时引用多个 candidate 并不自动表示它们互为镜像。不同 identity 会成为不同 Asset。手工新建的不同 URL 默认也是不同 Asset，仅 canonical URL 完全相同时去重。

### HttpDownloadExecutor

Stage E-A 本地 `delivery_target=local` 默认使用真实 `HttpDownloadExecutor`：

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

一个 Job 内多个 Asset 顺序下载，不并发、不分块。

当前支持普通 HTTP/HTTPS 文件型直链，例如 ZIP/EXE/MSI/PDF/直接 MP4 等。Stage E-A 明确不执行 Magnet/BT、HLS/DASH manifest、blob、FTP、aria2/qBittorrent/P2P。无可执行 Asset 时直接返回清楚错误，不创建假下载任务。

备用 source 会保存在对应 `asset_id` 下，但本 Wave 不自动 failover；主来源失败后任务进入 `waiting_for_source`，交给后续 Stage F。

### Pause / Resume / Cancel

Pause/Resume 只承诺当前 Runtime 进程仍存活：下载循环通过 cooperative `asyncio.Event` gate 停止/继续消费网络流。长时间暂停导致服务器断开时会如实失败，本 Wave不伪造 Range 续传。

Cancel 顺序是：

```text
cancel asyncio task
-> 关闭当前 HTTP response
-> 停止写盘
-> 删除当前 .part
-> 删除 ResourceJob
```

Runtime shutdown 与用户 Cancel 不同：shutdown 会停 background task 和 HTTP connection，但保留 `.part`，供后续恢复 Wave 使用。

### 状态事实来源

`execution_mode=download_engine` 的真实任务永远不会进入 `_advance_demo_job()`。

GET `/v1/jobs` 和 `/v1/jobs/{job_id}` 会用 Executor 的真实状态投影到现有 `ResourceJobSnapshot`：

```text
queued      -> planning
downloading -> downloading
paused      -> paused
completed   -> completed
failed      -> waiting_for_source
```

公开 schema 未重做；现有 `progress / downloaded_bytes / total_bytes / speed_bytes_per_second / eta_seconds / issue / stage_label` 已足够 Task Center 展示真实执行。

Cloud Demo 和显式 `DOWNLOAD_EXECUTOR=noop` 的 fixture 仍可保留旧 Demo 行为。

## Extension 产品文案

Stage E-A 不重做 Side Panel，只做信息减法：

- 扫描结果改为“发现 N 项可下载内容”；
- 首屏分类只保留文件、视频/音频、图片、磁力链接等用户有意义的类别；
- “候选资源 / 来自当前可见页面 / 使用这批资源”等工程表达已移除；
- 页面推荐标注不再显示绿色解释卡，只保留“定位到网页”；
- 推荐 tag 使用“适合当前电脑 / 兼容性更好 / 优先清晰度 / 体积更小”，不展示 raw reason 或 `os=windows` 一类技术事实；
- 创建任务后只短暂提示“已创建下载任务”，主按钮变为“打开任务中心”。

Task Center 保持原布局，通过现有轮询显示真实 bytes/speed/ETA，并在本地未完成任务详情提供真实“取消任务”。

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
# 留空默认 ~/Downloads/迅雷智取；真实大文件测试建议显式设置。
DOWNLOAD_DIRECTORY=

RUNTIME_AUTH_MODE=off
```

Extension 开发 fixture (`apps/extension/.env.local`)：

```dotenv
VITE_RUNTIME_URL=http://127.0.0.1:8765
VITE_ZHIQU_CAPABILITY_MODE=demo_local
VITE_ZHIQU_ANALYSIS_CREDENTIAL=demo
VITE_RUNTIME_SESSION=
```

## 启动

Runtime：

```powershell
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --reload --host 127.0.0.1 --port 8765
```

Task Center 开发模式：

```powershell
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

Extension 构建并旁加载 `apps/extension/dist`：

```powershell
corepack pnpm --filter @xunlei-zhiqu/extension build
```

## Stage E-A 自动检查

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

Stage E 测试重点保护：ExecutionAsset 分组、未确认资源不执行、Manual URL identity、非 HTTP/manifest 拒绝、真实 `.part` 写入、pause/resume、cancel 删除 `.part`、以及 real Job 不进入 Demo progress。

## Stage E-A 真实验收

建议先把下载目录设到容易观察的位置：

```dotenv
DOWNLOAD_EXECUTOR=http
DOWNLOAD_DIRECTORY=C:\Users\<you>\Downloads\迅雷智取
```

重启 Runtime 后，走真实 Python/JDK 页面：

```text
扫描 / 框选
-> 智能分析
-> 确认推荐文件
-> 保存到“本地”
-> 开始下载
-> 打开任务中心
```

应看到真实磁盘变化：

```text
<filename>.part        # 下载中持续增长
<filename>             # 正常完成后原子替换
```

Task Center 应显示来自 Runtime Executor 的真实 `downloaded bytes / total / speed / ETA / progress`。暂停后 `.part` 停止增长且 speed=0；同一 Runtime 进程中恢复后继续增长；取消一个新任务后网络停止、`.part` 删除、任务移除；完成后 `.part` 消失且任务显示 100%。

可用一个故意返回 404 的 HTTP URL确认任务进入 `waiting_for_source`，但本 Wave不要继续做换源或 Node B。

## 明确留给后续 Wave / Stage F

本 Wave没有实现：SQLite/JobStore 持久化、Runtime 重启恢复、HTTP Range 断点续传、完整 Preflight、磁盘空间检查体系、完整 hash 校验、自动 source failover、Node B/Diagnosis/一键续取、Magnet/BT、HLS/DASH 编排、aria2/qBittorrent/P2P、多连接分块、WebSocket/下载事件总线。
