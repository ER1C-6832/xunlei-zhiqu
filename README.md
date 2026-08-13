# 迅雷智取

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

本仓库以 `docs/blueprint/xunlei-zhiqu-v0.4.md` 和当前 Stage E0 蓝图 `docs/blueprint/E0.md` 为产品与架构事实来源。项目保持 Browser Extension、Runtime、Task Center 三个逻辑边界；部署形态可以迁移，但不会扩张为通用聊天助手、通用爬虫或纯链接下载器。

## 开发进度

- **Stage A：已完成** — Monorepo、三端可运行骨架、环境变量与 ModelProviderAdapter。
- **Stage B：已完成** — 迅雷 17 风格任务中心、ResourceJob 数据流、云盘交付差异、链接库收藏/历史。
- **Stage C：已完成核心验证** — 真实矩形框选、多通道候选融合、真实节点 A、Sanitized EvidencePack、ResourcePlan 映射回网页、用户最终确认与 ResourceJob 创建。
- **Stage D：已完成** — 本地常驻发现、Resource Extension Registry、全 DOM 强信号发现、Network Media、批量图片、EvidenceReducer、节点 A 压缩协议、缓存、模型供应商适配边界和细粒度 HTTP latency trace。
- **Stage E0：进行中** — **Wave A / E0.1~E0.9 已完成**：Extension、Task Center、Runtime、模型入口和未来 Download Engine 已建立可替换接缝；下一步进入 **Wave B：Node A Performance（E0.10~E0.15）**。
- **Stage E：E0 完成后进入** — 接入真实 DownloadExecutor、真实进度、暂停/恢复/Range 与轻量持久化。

## 当前架构边界

```text
Browser Extension
      |
      v
ZhiquServiceClient
      |\
      | +-- CapabilityResolver
      | +-- AnalysisCredential
      |
      +-- LocalHttpTransport (Demo)
      +-- ClientTransport             # future seam only
      +-- CloudAnalysisTransport      # future analysis-only seam
                 |
                 v
              Runtime
          /       |        \
         v        v         v
ModelProviderAdapter   DownloadExecutorPort   ResourceJob
(semantic Model        (Noop in E0)           / Agent state
 GatewayPort)

Task Center
      |
      v
TaskServiceClient
      |
      v
HttpTaskServiceClient (Demo) / future Client WebView bridge
```

关键原则：

- Extension 产品组件不拼 Runtime URL 或 `/v1/*`；当前 Demo HTTP 细节只在 `LocalHttpTransport`。
- Task Center 产品页面不直接 `fetch` Runtime；HTTP 路由、endpoint 与 session header 只在 `HttpTaskServiceClient`。
- `ZhiquCapabilities` 描述当前部署形态有什么能力；`AnalysisCredential` 描述当前会话有没有智能分析资格，两者独立。
- 完整 Agent / ResourceJob 的长期主体属于迅雷客户端 Runtime；无客户端云端 fallback 只做 Node A 分析，不复制第二套完整 Runtime。
- `CaptureBatch != CloudAnalysisRequest`。真实资源 URL、页面 URL、Cookie、Authorization、临时 token、本地路径、完整 HTML 与无关整页正文不会因为未来走云分析而自动上传。
- 现有 `ModelProviderAdapter` 就是 Runtime 当前的 **ModelGatewayPort 语义边界**；不为了改名字重写一套模型架构。
- Agent/HTTP API 不依赖具体下载实现；所有执行动作经 `DownloadExecutorPort`。E0 使用 `NoopDownloadExecutor`，不会实际下载文件。
- Runtime HTTP 已预留 `X-Zhiqu-Session`。默认 `RUNTIME_AUTH_MODE=off` 保持当前 Demo；`static_token` 只用于开发验证安全接缝。

详细决策见：

- `docs/adr/0001-runtime-boundaries-and-model-adapters.md`
- `docs/adr/0002-client-runtime-cloud-analysis-and-service-ports.md`

## Wave A：Architecture Seam

### E0.1 / E0.2：Service Client + Capability Resolver

Extension 已统一通过 `ZhiquServiceClient` 使用：

```text
getCapabilities
getAnalysisAccess
analyzeResources
createJob
createManualJob
favoriteResource
openTaskCenter
```

当前 capability fixture：

| Fixture | 智能分析 | 本地下载 | 云盘交付 | 重新智取 |
|---|---:|---:|---:|---:|
| `demo_local` | 是 | 是 | 是 | 否 |
| `client_runtime` | 是 | 是 | 是 | 是 |
| `cloud_analysis` | 是 | 否 | 否 | 否 |
| `local_only` | 否 | 否 | 否 | 否 |

这些 fixture 只模拟能力，不代表真实 ClientTransport / CloudAnalysisTransport 已实现。

### E0.3：AnalysisCredential

逻辑 credential 当前支持：

```text
demo
anonymous
client_session
web_session
guest_trial
none
```

它只表示“谁允许调用智能分析”，不等于模型供应商 API Key，也不与本地/云端部署形态绑死。`ZhiquServiceClient` 在调用模型前统一检查 AnalysisAccess；UI 的 `intelligentAnalysis` 也是 capability + credential 的有效结果。

### E0.4：CloudAnalysisRequest 隐私边界

Extension 有独立 `buildCloudAnalysisRequest()`，它不会直接复制 CaptureBatch。允许上传的是候选语义和少量安全技术事实，例如 candidate id、文件名/扩展名、必要上下文、公开 MIME/size、资源 family hint 与设备信息。

明确不进入 cloud contract：

```text
candidate.value / 真实下载 URL
page.url / candidate.page_url
Cookie / Authorization / token / signature
本地文件路径
完整页面 HTML
CaptureBatch.metadata
page.relevant_text 整页正文
矩形几何坐标
```

`assertCloudAnalysisRequestPrivacy()` 和 `scripts/check_e0_cloud_privacy.mts` 保护这条边界。Extension 这里只做隐私裁剪，不复制 Python EvidenceReducer 的 Token reduction 逻辑。

### E0.5：TaskServiceClient

当前 active Task Center `StageBReadableApp` 已通过 `TaskServiceClient` 完成：

```text
listJobs
getJob
pauseJob
resumeJob
cancelJob
createManualJob
listLinkLibrary
setFavorite
getRuntimeInfo
```

`HttpTaskServiceClient` 是当前 Demo transport；以后可换 Client WebView Bridge / Native IPC，不要求重写任务中心页面。旧的未使用 `StageBApp.tsx` 直连 Runtime 实现已删除。

### E0.6：ADR 0002

ADR 0002 冻结：客户端 Runtime 是完整 Agent 主体、Cloud Analysis 只做 Node A、Cloud privacy contract、前端 Service Client、模型 Gateway Port、DownloadExecutorPort 与 Runtime session seam。

### E0.7：DownloadExecutorPort

Runtime 已有最小执行端口：

```text
create
pause
resume
cancel
status
add_source
```

`create` 使用 Runtime 内部 `DownloadExecutionRequest`：

```text
ResourceJobSnapshot + confirmed source values
```

真实 source 只在 Runtime 内部交给 executor，不写入公开 Job snapshot，也不进入 CloudAnalysisRequest。当前实现为 `NoopDownloadExecutor`，所以仍不会下载任何字节。

Runtime 同时新增 `POST /v1/jobs/{job_id}/cancel`，取消直接移除当前 Demo Job，而不是为冻结的公开 Job status 临时增加一个 `canceled` 状态。

### E0.8：ModelGatewayPort 语义

不新增平行的无人使用模型框架。现有：

```text
CaptureAnalyzer
→ ModelProviderAdapter          # current semantic ModelGatewayPort
→ StructuredChatProvider
→ ProviderApiAdapter
→ DashScope / OpenAI / Generic
```

继续保留。未来生产接迅雷 AI Gateway 时只需要新增类似 `XunleiGatewayProviderAdapter`，Analyzer 不应出现模型/供应商判断。

### E0.9：Runtime client session seam

HTTP client 已统一支持：

```text
X-Zhiqu-Session
```

Runtime：

```dotenv
RUNTIME_AUTH_MODE=off
RUNTIME_STATIC_SESSION_TOKEN=
```

可切换到：

```dotenv
RUNTIME_AUTH_MODE=static_token
RUNTIME_STATIC_SESSION_TOKEN=dev-session-value
```

Extension / Task Center 的开发 fixture 可分别设置：

```dotenv
VITE_RUNTIME_SESSION=dev-session-value
```

`VITE_RUNTIME_SESSION` 仅用于验证当前静态 token 接缝，**不是生产持久凭证**。未来生产 session 必须由客户端 Native Messaging / authenticated localhost handshake 等方式动态建立，而不是固化进前端 bundle。

## 浏览器扩展 `apps/extension`

Stage D 已有：

- Chrome / Edge Manifest V3 Side Panel；
- 真实矩形框选；
- DOM href、纯文本 URL/Magnet、video/audio/source、Network Media 等候选融合；
- 当前视口智能整理、框选路径、整个网页扫描三种主动候选路径；
- 本地常驻自动发现 + MutationObserver；
- Resource Extension Registry；
- M3U8 / DASH / 独立媒体网络发现；
- 批量图片扫描、筛选与最多 50 张交付；
- 所有候选先本地展示，只有用户明确点击才调用节点 A；
- ResourcePlan 返回后可映射回网页并定位推荐项；
- 用户仍能修改 AI 推荐，最终由 `confirmed_item_ids` 决定 ResourceJob。

E0 Wave A 在这些能力之上只增加迁移/隐私/身份接缝，没有重做 Stage D 资源发现。

## Runtime `services/runtime`

当前 Runtime 包含：

- FastAPI Demo Runtime；
- Sanitized EvidencePack + EvidenceReducer；
- `quality / fast / wire / wire2 / pipeline` Node-A protocol profile；
- provider-neutral StructuredChatProvider；
- OpenAI / DashScope / Generic OpenAI-compatible API adapter；
- deterministic ResourcePlan validation / device compatibility guard；
- bounded in-memory ResourcePlan cache；
- ResourceJob 创建、列表、暂停、恢复、取消；
- 链接库收藏 / 历史；
- `DownloadExecutorPort` + Noop executor；
- `ClientSessionAuthPort` + off/static-token fixture；
- 当前 Job Store 仍为进程内 Demo 状态。

### D6 HTTP latency trace

客户端可观测模型 HTTP 阶段继续保留：

```text
dispatch_ms
tcp_connect_ms
tls_handshake_ms
request_headers_ms
request_body_ms
upstream_wait_ms
response_body_ms
response_close_ms
transport_unattributed_ms
client_transport_ms
provider_reported_ms
```

`upstream_wait_ms` 仍只表示“请求发出后到响应头”的客户端观测值，包含 WAN、供应商 Gateway/排队与模型处理；不能在供应商没有 telemetry 时假装成纯模型推理时间。Wave B 会通过 streaming diagnostics 真正拆 TTFT / generation / total。

## Task Center `apps/task-center`

- 迅雷 17 风格下载主界面；
- 下载中 / 已完成；
- 本地与云盘 ResourceJob；
- Runtime 任务快照刷新、暂停 / 恢复；
- 任务详情中的目标、选择、问题、下一步；
- 链接库收藏 / 历史；
- 新建普通任务；
- E0.5 后 active UI 只依赖 `TaskServiceClient`，不持有 Runtime route / endpoint。

## 当前仍然不做

Wave A 没有提前实现：

- 真实 HTTP Download Engine / Range；
- BT / Magnet 下载执行；
- SQLite / 完整 ResourceGraph / 事件溯源；
- 完整 Node B / 一键续取；
- 真正 Cloud Analysis Service / 迅雷 AI Gateway；
- 第二套完整 Cloud Runtime；
- 真正 Native Messaging；
- 迅雷账号登录 / OAuth / 会员系统；
- 视觉模型；
- 微服务、Kafka、Redis；
- 大量 pytest / Playwright。

## 环境要求

- Node.js 22+
- Corepack
- Python 3.12+
- uv
- Chrome 或 Edge

## 首次安装

```powershell
corepack pnpm install
uv sync --project services/runtime
Copy-Item .env.example .env
```

模型 Key 永远只写 Runtime 本地 `.env`。DashScope + DeepSeek Demo 例如：

```dotenv
MODEL_PROVIDER=dashscope
ENABLE_FIXTURE_PROVIDER=false
MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=deepseek-v4-flash
MODEL_API_KEY=your-local-runtime-key

NODE_A_PROFILE=pipeline
MODEL_CONNECT_TIMEOUT_SECONDS=10
MODEL_READ_TIMEOUT_SECONDS=120
MODEL_WRITE_TIMEOUT_SECONDS=30
MODEL_MAX_COMPLETION_TOKENS=4096
PLAN_CACHE_TTL_SECONDS=1200
PLAN_CACHE_MAX_ENTRIES=64

RUNTIME_AUTH_MODE=off
```

供应商和模型独立配置：

```text
MODEL_PROVIDER=openai            + MODEL_NAME=<OpenAI model>
MODEL_PROVIDER=dashscope         + MODEL_NAME=<Qwen/DeepSeek/etc. available there>
MODEL_PROVIDER=openai_compatible + MODEL_NAME=<compatible model>
```

Fixture 只能显式开发开启：

```dotenv
MODEL_PROVIDER=fixture
ENABLE_FIXTURE_PROVIDER=true
```

## Extension 部署/fixture 配置

`apps/extension/.env.local`：

```dotenv
VITE_RUNTIME_URL=http://127.0.0.1:8765
VITE_ZHIQU_CAPABILITY_MODE=demo_local
VITE_ZHIQU_ANALYSIS_CREDENTIAL=demo
VITE_RUNTIME_SESSION=
```

Capability fixture：

```text
demo_local | client_runtime | cloud_analysis | local_only
```

AnalysisCredential fixture：

```text
demo | anonymous | client_session | web_session | guest_trial | none
```

`client_runtime` / `cloud_analysis` 目前不会自动创建未来 transport；真正 ClientTransport / CloudAnalysisTransport 仍然延期。

Task Center 开发默认 `http://127.0.0.1:8765`；生产 build 未设置 `VITE_RUNTIME_URL` 时使用同源。其 HTTP endpoint 现在只存在于 `HttpTaskServiceClient`。

## 开发启动

Runtime：

```powershell
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --reload --host 127.0.0.1 --port 8765
```

Task Center：

```powershell
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

Extension 持续构建：

```powershell
corepack pnpm --filter @xunlei-zhiqu/extension dev
```

Chrome / Edge 旁加载目录：

```text
apps/extension/dist
```

## Wave A 收口检查

统一检查命令：

```powershell
git pull --rebase origin main

corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
corepack pnpm --filter @xunlei-zhiqu/task-center build

Select-String -Path .\apps\extension\dist\content.js -Pattern '^\s*import'

uv run --project services/runtime python -m compileall services/runtime/src
uv run --project services/runtime pytest services/runtime/tests/test_e0_architecture_seams.py -q

node --experimental-strip-types scripts/check_e0_cloud_privacy.mts
```

`Select-String` 必须无输出，继续保护 MV3 `content.js` 自包含约束。Wave A 的测试只保护 Cloud privacy、Runtime session 和 executor seam，不追覆盖率。

## 下一 Wave

Wave B 连续处理 E0.10~E0.15：

```text
Provider streaming diagnostics
→ TTFT / generation / total
→ connection reuse / HTTP2 benchmark
→ 固定 Evidence benchmark
→ model/provider/profile A/B
→ pipeline v3 低风险输入/输出收缩
```

`pipeline_v2`/当前稳定 `pipeline` 不会被实验直接覆盖；先拿真实性能与正确性数据，再决定稳定配置。

## 本地入口

任务中心：

```text
http://127.0.0.1:8765/app/
```

API 文档：

```text
http://127.0.0.1:8765/docs
```

## 目录

```text
apps/extension          Manifest V3 迅雷智取扩展
apps/task-center        迅雷 17 风格 React 任务中心
services/runtime        FastAPI Runtime
packages/contracts      最小跨模块 TypeScript 契约
docs/blueprint          当前产品和架构事实来源
docs/adr                高成本决策与边界说明
scripts                 开发/契约检查脚本
demo                    受控资源页与故障场景
```
