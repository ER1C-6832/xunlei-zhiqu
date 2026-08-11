# 迅雷智取 · Stage B complete

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

本仓库以 `docs/blueprint/xunlei-zhiqu-v0.4.md` 为当前产品和架构事实来源。阶段 A 与阶段 B 已完成；下一阶段进入 C：智能多选与候选融合。项目不会扩张为通用聊天助手、通用爬虫或纯链接下载器。

## 当前已实现

### 浏览器扩展 `apps/extension`

- Chrome/Edge Manifest V3 Side Panel；
- DOM 链接与文本 Magnet 初步采集；
- `CaptureBatch` → Runtime → 节点 A → `ResourcePlan`；
- 本地 / 云盘交付目的地选择；
- 确认计划后创建 `ResourceJob`；
- ResourcePlan 可直接“收藏到链接库”，不必先创建任务；
- API Key 不进入扩展。

### 任务中心 `apps/task-center`

阶段 B 已按迅雷 17 下载模块方向完成高保真收口：

- 飞鸟品牌标识；
- 左侧只保留下载、云盘、链接库和设置；
- 下载中 / 已完成；
- 本地任务与云盘任务差异；
- 智取任务、普通任务、异常任务；
- Runtime 快照自动刷新；
- 暂停 / 恢复写回 Runtime；
- 可用的任务筛选、排序和批量暂停 / 恢复；
- 右上角 Runtime 状态、通知、用户菜单；
- 设置界面：刷新频率、列表密度、默认交付位置、通知和关于；
- 新建普通下载任务（仅作为迅雷已有下载能力的任务中心入口）；
- 任务详情明确呈现“目标、选择、问题、下一步”；
- 链接库“收藏 / 历史”、分类筛选、列表 / 网格视图；
- 历史记录可关联回 ResourceJob；
- 收藏可在任务中心切换，也可直接从智取扩展创建。

### Runtime `services/runtime`

- `GET /v1/health`
- `POST /v1/capture/analyze`
- `POST /v1/jobs`
- `POST /v1/jobs/manual`
- `GET /v1/jobs`
- `GET /v1/jobs/{job_id}`
- `POST /v1/jobs/{job_id}/pause`
- `POST /v1/jobs/{job_id}/resume`
- `GET /v1/link-library`
- `GET /v1/link-history`（兼容入口）
- `POST /v1/link-library/favorites`
- `POST /v1/link-library/{history_id}/favorite`
- 构建后的任务中心托管在 `/app/`。

当前 Job Store 仍为进程内轻量状态；这是阶段 B 的刻意边界。SQLite 持久化、真实 Download Engine、节点 B 与恢复系统不在本阶段提前实现。

## 尚未实现

- 阶段 C：DOM / 纯文本 / Magnet / 框选候选融合、去重、智能多选；
- 完整 ResourceGraph 与持久状态机；
- 真实 Download Engine、分块与协议执行；
- 节点 B 与一键续取闭环；
- 最终哈希 / 文件结构 / 完整性交付验证；
- 第一版视觉模型。

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

默认 `MODEL_PROVIDER=fixture`，无需 API Key。

## 开发启动

Runtime：

```powershell
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --reload --host 127.0.0.1 --port 8765
```

任务中心：

```powershell
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

浏览器扩展持续构建：

```powershell
corepack pnpm --filter @xunlei-zhiqu/extension dev
```

Chrome / Edge 加载目录：

```text
apps/extension/dist
```

也可以使用：

```powershell
.\scripts\dev.ps1
```

## 本地更新后的重构 / 构建

阶段 B 不新增 npm 或 Python 第三方依赖。拉取代码后执行：

```powershell
git pull --rebase origin main
corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/task-center build
corepack pnpm --filter @xunlei-zhiqu/extension build
uv run --project services/runtime python -m compileall services/runtime/src
```

然后重启 Runtime，并在浏览器扩展管理页点击“重新加载”。

任务中心生产地址：

```text
http://127.0.0.1:8765/app/
```

API 文档：

```text
http://127.0.0.1:8765/docs
```

## OpenAI 兼容模型

仅在 Runtime `.env` 中配置：

```dotenv
MODEL_PROVIDER=openai_compatible
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4.1-mini
MODEL_API_KEY=your-local-runtime-key
```

API Key 不得写入 `apps/extension`、`apps/task-center`、任何前端环境变量或 GitHub。

## 目录

```text
apps/extension          Manifest V3 迅雷智取 Lens
apps/task-center        迅雷 17 风格 React 任务中心
services/runtime        FastAPI 本地 Runtime
packages/contracts      临时跨模块 TypeScript 契约
docs/blueprint          当前产品和架构事实来源
docs/adr                只记录高成本决策
demo                    后续受控资源页与故障场景
```
