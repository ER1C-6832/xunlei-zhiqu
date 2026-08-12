# 迅雷智取

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

本仓库以 `docs/blueprint/xunlei-zhiqu-v0.4.md` 为产品和架构事实来源。项目保持三层结构：Manifest V3 Browser Extension、本地 FastAPI Runtime、迅雷 17 风格 Task Center；不会扩张为通用聊天助手、通用爬虫或纯链接下载器。

## 开发进度

- **Stage A：已完成** — Monorepo、三端可运行骨架、环境变量与 ModelProviderAdapter。
- **Stage B：已完成** — 迅雷 17 风格任务中心、ResourceJob 数据流、云盘交付差异、链接库收藏/历史。
- **Stage C：已完成核心验证** — 真实矩形框选、多通道候选融合、真实 OpenAI-compatible 节点 A、Sanitized EvidencePack、ResourcePlan 映射回网页、`confirmed_item_ids` 用户确认、ResourceJob 创建。
- **Stage D：进行中，D1-D5 已完成** — 普通用户 UI、本地常驻自动发现、资源扩展名 Registry、全 DOM 强信号发现、Network Media、批量图片均已落地；D6 EvidenceReducer / 节点 A 压缩与缓存尚未开始。
- **Stage E：下一大阶段** — Stage D 完成后接入真实 Download Engine、真实进度和轻量质检。

## 当前已实现

### 浏览器扩展 `apps/extension`

- Chrome / Edge Manifest V3 Side Panel；
- 真实矩形框选；
- DOM href、选区纯文本 URL / Magnet、`video/audio/source` 基础采集；
- 完全重复 URL / BTIH 合并与 capture provenance；
- “智能整理”扫描当前可见区域，只做本地候选，不自动调用模型；
- “框选页面区域”形成独立候选路径，只做本地候选；
- “整理整个网页”覆盖完整 DOM，适合 Oracle JDK 等超长、多版本下载页；
- 所有候选路径都允许先查看候选，再由用户明确点击“智能分析”调用真实节点 A；
- 节点 A 完成后可一键定位真实网页中的推荐资源；
- 普通 UI 不展示 Candidate、DOM、SelectionScope、Provider、ResourcePlan、Stage、节点 A 等工程概念；

#### D2 / D4 自动发现

- 用户可控的页面自动发现，默认不开启；
- 开启后使用初次扫描 + `MutationObserver` + 防抖重新索引；
- D4 已从 viewport 发现升级为**完整 DOM 的高置信资源发现**；
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
- `ResourceType` 已扩展为 `software/document/video/audio/image/subtitle/model/design/archive/disk_image/mixed/unknown`；
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
- 最多选择 50 张 HTTP/HTTPS 图片直接创建现有普通 ResourceJob 并跳转任务中心；
- 图片扫描本身不调用 LLM。

### Runtime `services/runtime`

- FastAPI 本地服务，只监听本机；
- `POST /v1/capture/analyze`；
- Sanitized EvidencePack，Provider 不直接接收完整 CaptureBatch；
- `OpenAICompatibleProvider` + 显式开发 `FixtureProvider`；
- DashScope / DeepSeek V4 JSON Mode 兼容；
- EvidencePack 可接收 Extension Registry hint、网络媒体事实、blob 动态媒体标记和图片尺寸/来源等安全技术 metadata；
- 模型只能引用已有 Candidate ID，返回后有确定性引用校验；
- ResourceJob 创建、列表、暂停 / 恢复；
- 链接库收藏 / 历史；
- 当前 Job Store 仍为进程内轻量状态。

### 任务中心 `apps/task-center`

- 迅雷 17 风格下载主界面；
- 下载中 / 已完成；
- 本地与云盘 ResourceJob；
- Runtime 任务快照刷新、暂停 / 恢复；
- 任务详情中的目标、选择、问题、下一步；
- 链接库收藏 / 历史；
- Stage D 暂停继续扩张 Task Center UI，只保证能正确接收新 ResourceJob。

## Stage D 当前边界

**D1-D5 已完成，当前停在 D5。** 下一步只有 D6，不应在 D5 验收前继续：

- EvidenceReducer / EvidenceCompiler；
- 去重复上下文与辅助文件 evidence group；
- 节点 A Prompt 压缩与“不要为每个候选生成一张卡片”的规划约束；
- raw candidate / AI group count / token usage / latency 日志；
- bounded in-memory ResourcePlan cache；
- Python 这类 20~60 候选页面的输入 Token 明显降低。

Stage D 仍不实现真实下载执行、BT 下载、SQLite、节点 B、完整 ResourceGraph、视觉模型或大量测试。

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

真实节点 A 默认使用 OpenAI-compatible Provider。API Key 只写 Runtime 本地 `.env`：

```dotenv
MODEL_PROVIDER=openai_compatible
ENABLE_FIXTURE_PROVIDER=false
MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=deepseek-v4-flash
MODEL_API_KEY=your-local-runtime-key
MODEL_CONNECT_TIMEOUT_SECONDS=10
MODEL_READ_TIMEOUT_SECONDS=120
MODEL_WRITE_TIMEOUT_SECONDS=30
MODEL_MAX_COMPLETION_TOKENS=8192
```

Fixture 只能显式开发开启：

```dotenv
MODEL_PROVIDER=fixture
ENABLE_FIXTURE_PROVIDER=true
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

Stage D 每一步优先保护生产代码构建，不追求测试覆盖率：

```powershell
git pull --rebase origin main
corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
uv run --project services/runtime python -m compileall services/runtime/src
```

D5 新增了 `webRequest` 权限，重新构建后需要在 `chrome://extensions/` / `edge://extensions/` 对扩展点一次“重新加载”，并刷新待测试网页。

任务中心生产地址：

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
services/runtime        FastAPI 本地 Runtime
packages/contracts      最小跨模块 TypeScript 契约
docs/blueprint          当前产品和架构事实来源
docs/adr                只记录高成本决策
demo                    受控资源页与故障场景
```
