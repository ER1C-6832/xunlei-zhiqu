# 迅雷智取

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

本仓库以 `docs/blueprint/xunlei-zhiqu-v0.4.md` 为产品和架构事实来源。项目保持三层结构：Manifest V3 Browser Extension、本地 FastAPI Runtime、迅雷 17 风格 Task Center；不会扩张为通用聊天助手、通用爬虫或纯链接下载器。

## 开发进度

- **Stage A：已完成** — Monorepo、三端可运行骨架、环境变量与 ModelProviderAdapter。
- **Stage B：已完成** — 迅雷 17 风格任务中心、ResourceJob 数据流、云盘交付差异、链接库收藏/历史。
- **Stage C：已完成核心验证** — 真实矩形框选、多通道候选融合、真实节点 A、Sanitized EvidencePack、ResourcePlan 映射回网页、`confirmed_item_ids` 用户确认、ResourceJob 创建。
- **Stage D：已完成** — 普通用户 UI、本地常驻自动发现、资源扩展名 Registry、全 DOM 强信号发现、Network Media、批量图片、EvidenceReducer、节点 A 压缩规划、缓存、模型供应商适配边界和细粒度 HTTP latency 诊断。
- **Stage E0：进行中** — 生产迁移接缝、Node A 性能诊断与分析等待体验收口；**E0.1 已完成**：Extension 通过 `ZhiquServiceClient` 使用 Runtime 能力，当前 Demo HTTP 地址和 `/v1` 路由只存在于 `LocalHttpTransport`。
- **Stage E：E0 完成后进入** — 接入真实 Download Engine、真实进度和轻量质检。

## 三层边界

```text
Browser Extension
      |
      v
ZhiquServiceClient
      |
      v
LocalHttpTransport (Demo) -- HTTP /v1 contracts --> Runtime <-- HTTP /v1 contracts -- Task Center
                                                        |
                                                        v
                                             ModelProviderAdapter
                                                        |
                                                StructuredChatProvider
                                                        |
                                                ProviderApiAdapter
                                       / openai / dashscope / generic
```

- Extension 负责采集、页面联动和用户显式操作，不持有模型 Key；产品 UI 只调用 `ZhiquServiceClient` 的语义方法，不拼 Runtime URL 或 `/v1/*` 路由；
- 当前 `LocalHttpTransport` 是 Demo 部署适配层，独占 `VITE_RUNTIME_URL`、localhost 默认值、HTTP 路由和 Task Center URL；未来 Client/Cloud transport 不要求改写 React 产品逻辑；
- Task Center 目前只消费 Runtime 的任务/链接库 API，不承载资源判断；其独立 `TaskServiceClient` 属于 E0.5；
- Runtime 构建脱敏 EvidencePack、调用节点 A、做确定性校验并创建 ResourceJob；
- `NODE_A_PROFILE` 只控制我们自己的 Prompt / Evidence wire / ResourcePlan wire，不选择供应商或模型；
- `MODEL_PROVIDER` 只选择 API 方言适配器，`MODEL_NAME` 单独选择模型；
- Demo 可以由 Runtime 静态托管 Task Center；这是部署便利，不是代码依赖。

详细模型/部署边界见 `docs/adr/0001-runtime-boundaries-and-model-adapters.md`。Stage E0 后续会补充客户端 Runtime 与 Cloud Analysis 的生产迁移 ADR。

## 当前已实现

### 浏览器扩展 `apps/extension`

- Chrome / Edge Manifest V3 Side Panel；
- 真实矩形框选；
- DOM href、选区纯文本 URL / Magnet、`video/audio/source` 基础采集；
- 完全重复 URL / BTIH 合并与 capture provenance；
- “智能整理”扫描当前可见区域，只做本地候选，不自动调用模型；
- “框选页面区域”形成独立候选路径，只做本地候选；
- “整理整个网页”覆盖完整 DOM，适合 Oracle JDK 等超长、多版本下载页；
- 所有候选路径都允许先查看候选，再由用户明确点击“智能分析”调用节点 A；
- 节点 A 完成后可一键定位真实网页中的推荐资源；
- 普通 UI 不展示 Candidate、DOM、SelectionScope、Provider、ResourcePlan、Stage、节点 A 等工程概念；
- E0.1 新增 `services/zhiquServiceClient.ts` + `services/transports/localHttpTransport.ts`：分析、创建 ResourceJob、批量图片任务、收藏和打开任务中心统一经过语义客户端；
- StageD React UI 与批量图片 UI 不再直接 `fetch` Runtime，也不知道 `127.0.0.1:8765` 和具体 `/v1` 路径；
- `VITE_RUNTIME_URL` 只由 `LocalHttpTransport` 读取；旧的 Vite 源码字符串替换注入已删除；
- 旧 StageC Side Panel 实现已经退出 active path 并删除，避免维护第二条直连 Runtime 的 UI 链路；模型 Key 永远不进入扩展。

#### D2 / D4 自动发现

- 用户可控的页面自动发现；
- 开启后使用初次扫描 + `MutationObserver` + 防抖重新索引；
- 自动模式扫描完整 DOM 的高置信资源；
- 红点数量只统计强资源信号：Registry 已知资源扩展名、Magnet、`download` 属性、`video/audio/source`、明确媒体 manifest、被动观察到的网络媒体；
- 普通 `download.php`、未知 page URL、仅附近出现 download 文案的导航链接不会仅凭文本进入红点；
- 自动发现全过程只在本地运行，不构造 EvidencePack、不调用 LLM；
- 页面动态更新后资源数量可更新；
- 网页左下角显示飞鸟资源浮标与数量角标，点击只打开 Side Panel；
- 自动发现与“当前视口主动扫描”是两条不同候选路径，可分别查看。

#### D3 Resource Registry

- `resourceExtensions.ts` 统一维护主要文档/电子书、字幕、视频、音频、图片、设计/CAD、模型、压缩包、磁盘镜像和安装包扩展名；
- 大小写匹配不敏感；
- Registry 同时供框选、主动扫描、整页扫描和自动发现使用；
- `.bin` / `.dds` / `.stl` / `.dat` / `.cbr` / `.cbz` 等歧义扩展只提供本地 family hint；
- `ResourceType` 为 `software/document/video/audio/image/subtitle/model/design/archive/disk_image/mixed/unknown`；
- `.m3u8` 与 `.mpd` 作为媒体 manifest 候选进入 Registry。

#### D5 Network Media

- Manifest V3 service worker 使用非阻塞 `chrome.webRequest` 被动观察当前标签页媒体响应；
- 捕获常见独立媒体文件、HLS `.m3u8`、DASH `.mpd`，并保留 Content-Type、Content-Length、Content-Disposition 等技术事实；
- 网络媒体按标签页存入 `chrome.storage.session`，service worker 重启后仍可在当前浏览器会话恢复；
- DOM 媒体候选与网络媒体按完全相同 URL 融合，不按文件名相似去重；
- HLS 的大量 `.ts` XHR 分片不会作为独立资源刷屏；
- `<video>` 的 `blob:` 只标记为动态媒体信号、不可直接下载；若网络观察捕获到真实 manifest / media URL，则以真实网络候选补充；
- 不做 DRM 绕过，不破解加密媒体。

#### D5 批量图片

- 独立“批量图片”入口，不把网页所有 icon/头像计入普通自动发现红点；
- 用户主动进入后扫描 `<img src>`、`srcset`、`picture/source`、链接原图和 CSS `background-image`；
- 展示图片尺寸、格式、来源方式与“可能原图”提示；
- 支持全部 / 大图 / 可能原图筛选；
- 最多选择 50 张 HTTP/HTTPS 图片，经 `ZhiquServiceClient.createManualJob()` 创建现有普通 ResourceJob 并打开任务中心；
- 图片扫描本身不调用 LLM。

### Runtime `services/runtime`

- FastAPI Runtime；Demo 默认只监听本机；
- `POST /v1/capture/analyze`；
- Sanitized EvidencePack，Provider 不直接接收完整 CaptureBatch；
- `ModelProviderAdapter` 是 Runtime 到模型层的稳定业务边界；
- `StructuredChatProvider` 负责通用 OpenAI-compatible HTTP transport；
- `ProviderApiAdapter` 隔离供应商方言：当前有 OpenAI、DashScope、Generic OpenAI-compatible；Fixture 仍为显式开发模式；
- DashScope 的 `enable_thinking` 等供应商/模型特殊字段不再进入 Analyzer 或 Factory 的业务判断；
- EvidencePack 可接收 Extension Registry hint、网络媒体事实、blob 动态媒体标记和图片尺寸/来源等安全技术 metadata；
- D6 `EvidenceReducer` 在模型前进一步压缩脱敏事实：自动模式降低低置信 page/navigation、缩短 `nearby_text`、去重重复上下文，并把高重复签名/校验/SBOM 聚成 evidence group，同时保留全部原 Candidate ID；
- `wire2` / `pipeline` 是我们的协议 A/B profile，与供应商/模型选择分离；
- 模型只能引用已有 Candidate ID，返回后仍有确定性引用/设备兼容/主资源校验；
- bounded in-memory ResourcePlan cache，默认 20 分钟 TTL / 64 条；
- ResourceJob 创建、列表、暂停 / 恢复；
- 链接库收藏 / 历史；
- 当前 Job Store 仍为进程内轻量状态。

#### D6 HTTP latency 拆分

模型调用不再只有一个模糊的 `http_ms`。Runtime 使用 HTTPX/HTTPCore trace 在客户端可观测范围内记录：

```text
dispatch_ms
+ tcp_connect_ms
+ tls_handshake_ms
+ request_headers_ms
+ request_body_ms
+ upstream_wait_ms
+ response_body_ms
+ response_close_ms
+ transport_unattributed_ms
```

同时记录：

```text
connection_reused
http_version
client_transport_ms
provider_reported_ms   # 只有供应商返回可安全解释的单一 Server-Timing dur 时
response_bytes
```

`upstream_wait_ms` 是“请求已发送后等待响应头”的客户端观测值，包含公网/代理 RTT、供应商网关/排队和模型处理；客户端不能在供应商没有遥测的情况下把它伪装成纯模型推理时间。供应商若返回 `Server-Timing`，只额外记录其明确报告的数据。

另外 `node_a_provider_timing` 继续区分 JSON build/parse、normalize、Pydantic validate 等本地 Provider 工作；`node_a_analysis` 区分 Evidence compile、cache、provider roundtrip、deterministic guards 与 Runtime local overhead。

### 任务中心 `apps/task-center`

- 迅雷 17 风格下载主界面；
- 下载中 / 已完成；
- 本地与云盘 ResourceJob；
- Runtime 任务快照刷新、暂停 / 恢复；
- 任务详情中的目标、选择、问题、下一步；
- 链接库收藏 / 历史；
- Stage D 没有继续扩张 Task Center UI，只保证能正确接收新 ResourceJob；
- 开发默认调用本地 Runtime；生产 build 未设置 `VITE_RUNTIME_URL` 时使用 `window.location.origin`，因此可由本地或远端 Runtime 同源托管；分离部署时显式设置 `VITE_RUNTIME_URL`；
- Task Center 目前仍直接使用 HTTP 地址/路由，计划在 E0.5 收口进 `TaskServiceClient`，不在 E0.1 偷跑该步骤。

## Stage E0 当前边界

E0 的目标是让今天的：

```text
Browser Extension
→ localhost FastAPI Runtime
→ Demo Task Center
```

未来能够迁移为：

```text
Browser Extension
→ 迅雷客户端 Runtime
→ 迅雷真实下载引擎
→ 迅雷 AI Gateway
```

而不推翻 Node A、ResourceJob、Agent 编排和 UI 产品逻辑。

当前只完成 **E0.1**。下一步是 E0.2 Capability Resolver；尚未实现 Cloud Analysis、DownloadExecutorPort、Native Messaging、Runtime 鉴权或 streaming analysis。

Stage E0 / Stage D 仍然**不包含**：

- 真实 HTTP Download Engine；
- BT / Magnet 下载执行；
- 节点 B；
- SQLite / 完整 ResourceGraph / 事件溯源；
- 视觉模型；
- 微服务或真正的云端 AI Gateway；
- 真正 Native Messaging / 迅雷账号登录；
- 大量 pytest / Playwright。

Stage E0 完成后才进入 Stage E 的真实下载执行。

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

API Key 只写 Runtime 本地 `.env`。以当前 DashScope + DeepSeek Demo 为例：

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
```

供应商和模型是独立配置：

```text
MODEL_PROVIDER=openai            + MODEL_NAME=<OpenAI model>
MODEL_PROVIDER=dashscope         + MODEL_NAME=<Qwen/DeepSeek/etc. available there>
MODEL_PROVIDER=openai_compatible + MODEL_NAME=<compatible model>
```

旧 `.env` 若仍为 `MODEL_PROVIDER=openai_compatible` 且 URL 是 `*.aliyuncs.com`，Runtime 会为兼容旧配置暂时自动选择 DashScope adapter 并打印迁移 warning；建议改成显式 `MODEL_PROVIDER=dashscope`。

Fixture 只能显式开发开启：

```dotenv
MODEL_PROVIDER=fixture
ENABLE_FIXTURE_PROVIDER=true
```

## 部署配置

Extension 本地开发无需额外配置。E0.1 后 Runtime 地址只由 `LocalHttpTransport` 读取；React 产品组件不再读取该变量，也不再依赖 Vite 的源码字符串替换。构建给其他 Runtime endpoint 时，在 `apps/extension/.env.local` 或 shell 中设置：

```dotenv
VITE_RUNTIME_URL=https://runtime.example.com
```

Task Center 开发默认 `http://127.0.0.1:8765`；生产 build 默认同源。若前端和 Runtime 分离部署，在 `apps/task-center/.env.local` 设置同名变量。

远端 Task Center Origin 还需要加入 Runtime：

```dotenv
RUNTIME_CORS_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,https://task-center.example.com
```

这些都是公开部署地址，不是模型凭证。

## D6 性能观察

常规成本日志：

```text
node_a_analysis model=deepseek-v4-flash candidate_raw_count=25 candidate_ai_count=13 input_tokens=3129 output_tokens=494 cache_hit=false latency_ms=6897 ...
```

细粒度模型 HTTP 调用：

```text
node_a_http_trace api_provider=dashscope model=deepseek-v4-flash http_version=HTTP/1.1 connection_reused=true dispatch_ms=... tcp_connect_ms=... tls_handshake_ms=... request_headers_ms=... request_body_ms=... upstream_wait_ms=... response_body_ms=... response_close_ms=... transport_unattributed_ms=... client_transport_ms=... provider_reported_ms=... response_bytes=...
```

同一份脱敏证据短时间重复分析命中 Runtime 本地缓存时：

```text
cache_hit=true input_tokens=0 output_tokens=0
```

## 开发启动

Runtime：

```powershell
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --reload --host 127.0.0.1 --port 8765
```

任务中心：

```powershell
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

扩展持续构建：

```powershell
corepack pnpm --filter @xunlei-zhiqu/extension dev
```

Chrome / Edge 旁加载目录：

```text
apps/extension/dist
```

## 拉取更新后的检查 / 构建

优先保护生产代码构建，不追求测试覆盖率：

```powershell
git pull --rebase origin main
corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
uv run --project services/runtime python -m compileall services/runtime/src
```

D5 使用了 `webRequest` 权限，重新构建后需要在 `chrome://extensions/` / `edge://extensions/` 对扩展点一次“重新加载”，并刷新待测试网页。

任务中心生产地址（本地 Demo）：

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
demo                    受控资源页与故障场景
```
