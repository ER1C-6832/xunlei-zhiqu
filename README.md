# 迅雷智取

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

本仓库以 `docs/blueprint/xunlei-zhiqu-v0.4.md` 为产品和架构事实来源。项目保持三层结构：Manifest V3 Browser Extension、本地 FastAPI Runtime、迅雷 17 风格 Task Center；不会扩张为通用聊天助手、通用爬虫或纯链接下载器。

## 开发进度

- **Stage A：已完成** — Monorepo、三端可运行骨架、环境变量与 ModelProviderAdapter。
- **Stage B：已完成** — 迅雷 17 风格任务中心、ResourceJob 数据流、云盘交付差异、链接库收藏/历史。
- **Stage C：已完成核心验证** — 真实矩形框选、多通道候选融合、真实 OpenAI-compatible 节点 A、Sanitized EvidencePack、ResourcePlan 映射回网页、`confirmed_item_ids` 用户确认、ResourceJob 创建。
- **Stage D：进行中** — D1 已完成普通用户界面去工程化；D2 已加入用户可控的常驻本地资源发现、页面变化监听和网页资源数量浮标。主动扫描与框选只做本地候选采集，必须由用户再次点击“智能分析”才调用 LLM。
- **Stage E：下一大阶段** — Stage D 完成后接入真实 Download Engine、真实进度和轻量质检。

## 当前已实现

### 浏览器扩展 `apps/extension`

- Chrome / Edge Manifest V3 Side Panel；
- 真实矩形框选 SelectionScope；
- DOM href、选区纯文本 URL / Magnet、`video/audio/source` 基础采集；
- 完全重复 URL / BTIH 合并与 capture provenance；
- 主动“智能整理”和框选均先在本地采集候选，不自动调用模型；
- 用户明确点击“智能分析”后才执行 `CaptureBatch` → Runtime → 真实节点 A → `ResourcePlan`；
- D2 页面自动发现默认关闭；用户开启后使用 MutationObserver、滚动/视口变化做轻量本地资源计数，不构造 EvidencePack、不调用 LLM；
- D2 在真实网页左下角显示圆形资源浮标与数量角标，点击只打开 Side Panel；
- 用户修改推荐后以 `confirmed_item_ids` 创建 ResourceJob；
- 本地 / 云盘交付目标；
- ResourcePlan 可收藏到链接库；
- 推荐结果可映射回真实网页；
- 普通界面不展示 Candidate、DOM、SelectionScope、Provider、ResourcePlan、Stage、节点 A 等工程概念；
- API Key 永远不进入扩展。

### Runtime `services/runtime`

- FastAPI 本地服务，只监听本机；
- `POST /v1/capture/analyze`；
- Sanitized EvidencePack，Provider 不直接接收完整 CaptureBatch；
- `OpenAICompatibleProvider` + 显式开发 `FixtureProvider`；
- DashScope / DeepSeek V4 JSON Mode 兼容；
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

D1 与 D2 已完成当前 Demo 所需的用户界面简化和本地常驻发现。以下仍属于后续 D3-D6，不应误认为已完成：

- 完整资源扩展名 Registry 与 ResourceType 扩展；
- 更强的全 DOM 资源发现与自动复杂度触发；
- Network Media Capture、M3U8 / DASH；
- `<img>` / `srcset` / `picture` / CSS background-image 与批量图片；
- EvidenceReducer / EvidenceCompiler；
- Token / latency / usage 日志与轻量 ResourcePlan 缓存。

Stage D 不实现真实下载执行、BT 下载、SQLite、节点 B、完整 ResourceGraph、视觉模型或大量测试。

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
corepack pnpm --filter @xunlei-zhiqu/extension typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
uv run --project services/runtime python -m compileall services/runtime/src
```

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
