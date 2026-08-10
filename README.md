# 迅雷智取 v0.1 可运行骨架

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

本仓库按 `docs/blueprint/xunlei-zhiqu-v0.4.md` 初始化，当前只实现第一轮可运行纵向切片，不重新定义产品，也不扩张为通用聊天助手、通用爬虫或纯链接下载器。

## 本次已实现

- `apps/extension`：Chrome/Edge Manifest V3 扩展骨架，包含 Side Panel、DOM 链接与文本 Magnet 初步采集、`CaptureBatch` 生成、调用本地 Runtime 和展示 `ResourcePlan`。
- `apps/task-center`：React 迅雷 17 风格任务中心基础页，包含左侧导航、下载中/已完成、智取任务卡、异常状态、一键续取入口与任务详情。
- `services/runtime`：FastAPI 本地 Runtime，包含 CORS、健康检查、`POST /v1/capture/analyze`、示例任务快照接口和构建后 `/app` 静态托管。
- `ModelProviderAdapter`：统一模型调用边界。
- `FixtureProvider`：默认离线演示，执行轻量确定性去噪和场景化选择。
- `OpenAICompatibleProvider`：只在 Runtime 中读取 API Key，通过 OpenAI 兼容 `/chat/completions` 接口调用模型并校验结构化输出。
- `packages/contracts`：临时 TypeScript 契约；Runtime 中有对应 Pydantic v2 模型。
- 少量关键测试：Fixture 选型和分析 API。

## 尚未实现

- 完整 ResourceGraph、完整状态机和事件持久化；
- 节点 B、一键续取真实浏览器交接和下载恢复；
- 网络媒体捕获、图片捕获、Torrent 文件树和全部下载协议；
- 视觉模型；
- 大量 pytest、覆盖率门槛或微服务拆分。

## 环境要求

- Node.js 22+
- Corepack
- Python 3.12+
- uv
- Chrome 或 Edge

## 安装

在仓库根目录执行：

```powershell
corepack pnpm install
uv sync --project services/runtime
Copy-Item .env.example .env
```

默认 `MODEL_PROVIDER=fixture`，无需 API Key。

## 开发启动

### 1. Runtime

```powershell
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --reload --host 127.0.0.1 --port 8765
```

API 文档：`http://127.0.0.1:8765/docs`

### 2. 任务中心

另开终端：

```powershell
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

打开：`http://127.0.0.1:5173`

### 3. 浏览器扩展

另开终端：

```powershell
corepack pnpm --filter @xunlei-zhiqu/extension dev
```

然后在 Chrome/Edge 的扩展管理页开启开发者模式，选择“加载已解压的扩展”，目录为：

```text
apps/extension/dist
```

打开任意包含下载链接的公开页面，点击扩展图标，先“采集当前页”，再“交给节点 A 分析”。

也可以在 Windows PowerShell 中执行：

```powershell
.\scripts\dev.ps1
```

## 构建与验证

```powershell
corepack pnpm build
corepack pnpm typecheck
uv run --project services/runtime pytest
uv run --project services/runtime ruff check services/runtime
```

构建任务中心后，Runtime 会自动托管：`http://127.0.0.1:8765/app`

## 切换 OpenAI 兼容模型

复制 `.env.example` 为 `.env`，仅修改 Runtime 环境：

```dotenv
MODEL_PROVIDER=openai_compatible
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4.1-mini
MODEL_API_KEY=your-local-runtime-key
```

API Key 不得写入 `apps/extension`、`apps/task-center`、任何前端环境变量或 GitHub。

## 临时分析接口

```http
POST /v1/capture/analyze
Content-Type: application/json
```

示例输入：`packages/contracts/examples/capture-batch.json`

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8765/v1/capture/analyze `
  -ContentType 'application/json' `
  -InFile packages/contracts/examples/capture-batch.json
```

## 目录

```text
apps/extension          Manifest V3 Lens
apps/task-center        迅雷 17 风格 React 任务中心
services/runtime        FastAPI 本地 Runtime
packages/contracts      临时跨模块 TypeScript 契约
docs/blueprint          当前产品和架构事实来源
docs/adr                只记录高成本决策
demo                    后续受控资源页与故障场景
```
