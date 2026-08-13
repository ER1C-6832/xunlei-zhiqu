# 迅雷智取

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

本仓库以 `docs/blueprint/xunlei-zhiqu-v0.4.md` 与 `docs/blueprint/E0.md` 为产品与架构事实来源。Browser Extension、Runtime、Task Center 保持逻辑解耦；部署可以从本地 Demo 迁移到迅雷客户端 / 服务端，但不会把产品扩张成通用聊天助手、通用爬虫或纯链接下载器。

## 开发进度

- **Stage A：已完成** — Monorepo、三端骨架、配置与 ModelProviderAdapter。
- **Stage B：已完成** — 迅雷 17 风格任务中心、ResourceJob、云盘交付差异、链接库。
- **Stage C：已完成核心验证** — 真实框选、多通道候选融合、真实节点 A、Sanitized EvidencePack、ResourcePlan 映射回网页、用户最终确认。
- **Stage D：已完成** — 常驻发现、Resource Extension Registry、全 DOM 强信号、Network Media、批量图片、EvidenceReducer、缓存、模型供应商适配和细粒度 HTTP trace。
- **Stage E0：已完成** — Wave A Architecture Seam、Wave B Node A Performance、Wave C Progressive Analysis UX，覆盖 **E0.1~E0.22**。
- **Stage E：尚未进入** — 下一阶段才接真实 DownloadExecutor、真实进度、暂停/恢复/Range 与轻量持久化。

## 当前架构

```text
Browser Extension
  -> ZhiquServiceClient
     -> CapabilityResolver / AnalysisCredential
     -> LocalHttpTransport (Demo)
     -> future ClientTransport / CloudAnalysisTransport
                |
                v
             Runtime
          /      |       \
         v       v        v
ModelProviderAdapter   DownloadExecutorPort   ResourceJob
(ModelGatewayPort)     (Noop in E0)           / Agent state
         |
         v
StructuredChatProvider
         |
         v
ProviderApiAdapter
  -> DashScope / OpenAI / Generic

Task Center
  -> TaskServiceClient
     -> HttpTaskServiceClient (Demo)
     -> future Client WebView / Native bridge
```

关键边界：

- Extension 产品组件不拼 Runtime URL 或 `/v1/*`；Demo HTTP 细节属于 `LocalHttpTransport`。
- Task Center 页面不直接 `fetch` Runtime；路由、endpoint、session header 属于 `HttpTaskServiceClient`。
- `ZhiquCapabilities` 描述部署形态能力，`AnalysisCredential` 描述当前会话是否允许智能分析，两者分离。
- 完整 Agent / ResourceJob 的长期主体属于迅雷客户端 Runtime；无客户端 cloud fallback 只做 Node A，不复制完整下载状态机。
- `CaptureBatch != CloudAnalysisRequest`；真实下载 URL、页面 URL、Cookie、Authorization、临时 token、本地路径、完整 HTML、无关整页正文不会进入未来 cloud analysis contract。
- Runtime 只认 `ModelProviderAdapter` 这一 ModelGatewayPort 语义边界；供应商方言由 `ProviderApiAdapter` 隔离。
- 下载执行只经过 `DownloadExecutorPort`；E0 仍使用 `NoopDownloadExecutor`，不会下载真实字节。
- Runtime HTTP 已有 `X-Zhiqu-Session` 接缝；默认 `RUNTIME_AUTH_MODE=off` 保持 Demo，`static_token` 只做开发验证。

详细决策：

- `docs/adr/0001-runtime-boundaries-and-model-adapters.md`
- `docs/adr/0002-client-runtime-cloud-analysis-and-service-ports.md`

## Wave A — Architecture Seam（E0.1~E0.9）

Wave A 已冻结可迁移边界：

- `ZhiquServiceClient` + `LocalHttpTransport`；
- Capability Resolver；
- `AnalysisCredential`；
- `CloudAnalysisRequest` 隐私边界；
- `TaskServiceClient`；
- ADR 0002；
- `DownloadExecutorPort`；
- `ModelProviderAdapter` 作为 ModelGatewayPort；
- Runtime client-session seam。

当前 capability fixture：

```text
demo_local | client_runtime | cloud_analysis | local_only
```

当前 AnalysisCredential fixture：

```text
demo | anonymous | client_session | web_session | guest_trial | none
```

这些只是 E0 能力/身份 fixture，不代表真实 Native Messaging、Cloud Runtime 或迅雷账号体系已经实现。

## Wave B — Node A Performance（E0.10~E0.15）

Wave B 建立了真实 TTFT / generation / total 测量、供应商 SSE 归一化、固定脱敏 benchmark、model/provider/profile A/B、connection reuse / HTTP2 观测，以及独立 `pipeline_v3`。

### 推荐稳定配置

当前真实 benchmark 验证的稳定组合：

```dotenv
MODEL_PROVIDER=dashscope
MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=deepseek-v4-flash
NODE_A_PROFILE=pipeline_v3
MODEL_STREAM_DIAGNOSTICS=false
MODEL_HTTP2_ENABLED=false
```

`pipeline` 保留为 v2 回滚档。上述 v3 推荐结论只覆盖已经测试的 DashScope + `deepseek-v4-flash`；换供应商或模型需要重新 benchmark。

固定 Python / JDK / image 的 9 次 HTTP/1.1 A/B：

| 中位数 | pipeline v2 | pipeline v3 | 变化 |
|---|---:|---:|---:|
| input tokens | 1348 | 1236 | -8.3% |
| output tokens | 533 | 459 | -13.9% |
| TTFT | 906 ms | 862 ms | -4.9% |
| generation | 5220 ms | 4823 ms | -7.6% |
| total | 6257 ms | 5637 ms | -9.9% |
| ResourcePlan validation | 100% | 100% | 持平 |

图片原图偏好补强后又做 5 次 v3 定向复测，5/5 选择原图、5/5 validation；连接复用观测为首请求 `false`、后四次 `true`。

结论：DeepSeek V4 当前主要 latency 在首 token 之后的 generation，而非 Runtime 本地 JSON/Pydantic/guards 或连接握手。Qwen Flash 虽快但 ResourcePlan 质量不足，未进入稳定配置。HTTP/2 能协商成功但没有稳定延迟优势，保持默认关闭。`ResourcePlanCache` 命中路径 lookup 约为 0ms。

## Wave C — Progressive Analysis UX（E0.16~E0.22）

Wave C 把约 5~6 秒真实 Node A 等待变成有信息的渐进体验，而**没有把未校验的模型内容暴露给用户**。

当前流程：

```text
点击智能分析
  -> Extension 立即基于 CaptureBatch 做确定性本地资源概览
  -> 展示无数字动态进度条
  -> POST /v1/capture/analyze-stream
  -> Runtime 发语义 phase event
  -> Provider 内部完整聚合模型 JSON
  -> normalize + Pydantic
  -> deterministic guards
  -> plan_validated
  -> 完整 ResourcePlan
  -> Extension 平滑替换为正式推荐
```

UI 只看到这些语义阶段：

```text
evidence_ready
cache_hit
model_request_started
model_first_token
model_completed
plan_validated
done
```

界面不会展示这些技术名，而映射为“准备资源说明 / 正在理解版本区别 / 正在生成推荐 / 正在确认结果”等产品文案。

### 本地预览

点击分析后无需等待模型，Extension 立即依据已有确定性证据展示：

- 当前页面标题；
- 已发现资源数量；
- Windows / macOS / Linux；
- 源码 / 相关附件；
- 媒体 / 图片 / Magnet。

这里只使用 capture metadata、section heading、extension 和显式平台文字，不执行 Node A 语义推荐，不会假装知道“哪个一定最好”。

### 动态进度

进度条内部使用最近非缓存 Node A 完整耗时的移动中位数做插值：

- 本地阶段立即启动；
- 模型阶段随历史 latency 平滑推进；
- 慢请求在约 90% 附近缓慢前进，不倒退；
- `model_completed / plan_validated` 驱动最后阶段；
- UI 不显示伪造的数字百分比。

历史只保存在 Extension `chrome.storage.local`，只是 UX hint；读取/写入失败不会影响分析。

### Streaming 安全边界

旧接口继续保留：

```text
POST /v1/capture/analyze
```

Progressive UI 使用新增：

```text
POST /v1/capture/analyze-stream
Content-Type: application/x-ndjson
```

模型 token / 半截 JSON 永远留在 Runtime。`LocalHttpTransport` 只解析 Runtime 自己的 phase/result/error NDJSON；最终 `result.plan` 必须已经经过完整 JSON parse、normalizer、Pydantic 和 deterministic guards。

`MODEL_STREAM_DIAGNOSTICS=false` 仍是正常默认值：它控制普通 legacy 调用是否主动进入诊断 streaming；Progressive endpoint 在需要真实 `model_first_token` phase 时会在 Runtime 内部请求 provider streaming，但仍不会把原始 token delta 发给浏览器。

### Cache hit 快速路径

相同 sanitized Evidence + provider namespace 命中 `ResourcePlanCache` 时：

```text
evidence_ready
-> cache_hit
-> plan_validated
-> done
-> ResourcePlan
```

完全跳过模型 Provider。没有为了播放动画而设置人为延迟，缓存命中应直接快速替换成结果。

重新智能分析仍使用 `refresh=true`，明确绕过 ResourcePlan cache，便于用户真正要求重新判断。

## Runtime 当前能力

`services/runtime` 当前包含：

- FastAPI Demo Runtime；
- Sanitized EvidencePack + EvidenceReducer；
- `quality / fast / wire / wire2 / pipeline / pipeline_v3`；
- StructuredChatProvider；
- DashScope / OpenAI / Generic OpenAI-compatible API adapter；
- TTFT / generation / HTTP trace；
- deterministic ResourcePlan validation / device guard；
- bounded in-memory ResourcePlan cache；
- normal + progressive analyze API；
- ResourceJob create/list/pause/resume/cancel；
- Link Library；
- `DownloadExecutorPort` + Noop executor；
- `ClientSessionAuthPort` + off/static-token fixture。

当前 Job Store 仍为进程内 Demo 状态。

## Extension 当前能力

`apps/extension` 当前包含：

- Chrome / Edge Manifest V3 Side Panel；
- 真实矩形框选；
- DOM href、纯文本 URL/Magnet、video/audio/source、Network Media 多通道融合；
- 当前页、框选、整页三种主动扫描；
- 页面自动发现 + MutationObserver；
- M3U8 / DASH / 独立媒体网络发现；
- 批量图片；
- 本地候选列表；
- Progressive Analysis UX；
- ResourcePlan 映射回网页；
- 用户可修改最终推荐，再创建 ResourceJob。

## 本地配置

首次安装：

```powershell
corepack pnpm install
uv sync --project services/runtime
Copy-Item .env.example .env
```

模型 Key 只允许存在 Runtime `.env`。DashScope Demo 推荐：

```dotenv
MODEL_PROVIDER=dashscope
ENABLE_FIXTURE_PROVIDER=false
MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=deepseek-v4-flash
MODEL_API_KEY=your-local-runtime-key
NODE_A_PROFILE=pipeline_v3

MODEL_CONNECT_TIMEOUT_SECONDS=10
MODEL_READ_TIMEOUT_SECONDS=120
MODEL_WRITE_TIMEOUT_SECONDS=30
MODEL_MAX_COMPLETION_TOKENS=4096
MODEL_STREAM_DIAGNOSTICS=false
MODEL_HTTP2_ENABLED=false

PLAN_CACHE_TTL_SECONDS=1200
PLAN_CACHE_MAX_ENTRIES=64
RUNTIME_AUTH_MODE=off
```

Extension 开发 fixture（`apps/extension/.env.local`）：

```dotenv
VITE_RUNTIME_URL=http://127.0.0.1:8765
VITE_ZHIQU_CAPABILITY_MODE=demo_local
VITE_ZHIQU_ANALYSIS_CREDENTIAL=demo
VITE_RUNTIME_SESSION=
```

## 开发启动

Runtime：

```powershell
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --reload --host 127.0.0.1 --port 8765
```

Task Center：

```powershell
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

Extension 构建：

```powershell
corepack pnpm --filter @xunlei-zhiqu/extension build
```

Chrome / Edge 旁加载目录：

```text
apps/extension/dist
```

## E0 收口验证

```powershell
git pull --rebase origin main

corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
corepack pnpm --filter @xunlei-zhiqu/task-center build
Select-String -Path .\apps\extension\dist\content.js -Pattern '^\s*import'

uv run --project services/runtime python -m compileall services/runtime/src
uv run --project services/runtime pytest `
  services/runtime/tests/test_capture_analyze.py `
  services/runtime/tests/test_e0_architecture_seams.py `
  services/runtime/tests/test_e0_progressive_analysis.py `
  -q

node --experimental-strip-types scripts/check_e0_cloud_privacy.mts
```

`Select-String` 必须无输出，继续保护 MV3 `content.js` 自包含约束。

人工验收只需要真实主链路：扫描一个版本较多的下载页 → 点击智能分析 → 立即看到本地概览和动态进度 → phase 文案自然推进 → 最终完整推荐平滑出现 → 创建任务 / 打开任务中心；再对相同 Evidence 做一次普通分析确认 cache hit 快速路径，对“重新智能分析”确认仍然绕过缓存。

## E0 之后仍然不做

在明确进入 Stage E 之前，当前仍不实现：

- 真实 HTTP Download Engine / Range；
- BT / Magnet 下载执行；
- SQLite / 完整 ResourceGraph / EventLog；
- 完整 Node B / 一键续取；
- 真正 Cloud Analysis Service / 迅雷 AI Gateway；
- 第二套完整 Cloud Runtime；
- 真正 Native Messaging；
- 迅雷账号登录 / OAuth / 会员系统；
- 视觉模型；
- 微服务、Kafka、Redis。
