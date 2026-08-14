# 迅雷智取

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

`main` 是当前代码事实来源。产品不扩张成通用聊天助手、通用爬虫或纯链接下载器；核心仍是 Chrome/Edge MV3 Extension、Python FastAPI Runtime 和 React 下载任务中心。

## 开发进度

- **Stage A~D：完成** — 页面资源采集、候选融合、Node A、ResourcePlan、用户确认与三端主链路。
- **Stage E0：完成** — Provider/Executor 边界与 Node A 交互性能基线。
- **Stage E：完成并真人验收** — 真实 HTTP 下载、Pause/Range Resume、SQLite 持久化、Runtime 重启后原任务原 `.part` 继续。
- **Stage F：完成并通过受控真人端到端闭环验收** — Diagnosis、一键续取、Browser Reacquisition、真实 Node B、确定性来源验证、Source Switch、原 `.part` 跨来源续传。
- **Stage G：进行中** — 不再增加 Agent 模块；当前进入真实互联网泛化、真实试用与产品收口。

Stage F 的受控验收只证明 Recovery Architecture 成立，详细事实保存在 `docs/blueprint/F-acceptance.md`。Stage G 不以 localhost、fixture 或自制资源站作为 PASS 依据。

## 当前完整链路

```text
真实页面
→ Extension Capture
→ Node A
→ ResourcePlan
→ 用户确认
→ ResourceJob
→ 真实 HTTP/HTTPS 下载
→ .part / Range Resume / SQLite
→ 现实失败
→ Runtime Diagnosis
→ 一次同来源轻量重试
→ 必要时「一键续取 / 寻找其他来源」
→ 用户进入任意相关真实页面
→ Extension 保持「继续下载」模式
→ 当前 active tab Capture
→ Node B 语义匹配
→ Runtime Source Verification
→ Source Switch
→ 原 ResourceJob / 原 .part / 原 offset 继续
→ 完成
```

## Stage G 已完成的代码收口

### Recovery 不再受原网站限制

原资源页只是“一键续取”的默认落点，不再是恢复范围边界。只要 pending RecoveryContext 仍存在，用户可以导航到原站其他页面、官方镜像、其他 CDN 或另一个网站；Extension 仍保持「继续下载」模式。

Recovery 只操作用户当前 active tab：首次打开恢复页面可以自动扫描一次；之后切换/导航页面只提示用户可以在当前页面继续寻找，不遍历所有 tabs、不自动打开搜索引擎、不后台爬网页。

Side Panel 的恢复动作收口为：

```text
在当前页面寻找
打开原资源页
```

### Node B 回到正式 Provider API

`ModelProviderAdapter` 提供正式的结构化语义调用能力，Node B 不再读取 Provider 的 `_inner`、`_client`、`_api_adapter`、`_model` 私有字段。

```text
RecoveryService
→ ModelProviderAdapter.generate_structured(...)
→ StructuredChatProvider
→ ProviderApiAdapter
→ OpenAI-compatible / DashScope supplier dialect
```

Node A 与 Node B 继续复用同一个 provider/model/client 体系，没有第二套 Gateway，也没有 Node B 性能工程。

Node B 模型输入继续排除原始 Source URL；候选文字和目标文字在 Runtime 再做一层 URL/凭证样式去敏。Node A 仍使用既有 CloudAnalysisRequest 隐私边界。

### GET `/v1/jobs` 为纯读

Task Center polling 不再触发 Diagnosis、same-source retry 或 `waiting_for_source` 状态推进。

真实下载状态由 executor 的 state sink 持久化，失败后的 Diagnosis / retry / reacquire 升级由 Runtime 内部轻量 reconcile loop 推进。没有 Event Bus、WebSocket 或新的状态系统。

### 连接失败可以升级到寻找其他来源

```text
第一次 connection interruption / 5xx
→ 一次 same-source retry

仍失败且没有继续取得有效进展
→ interrupted / waiting_for_source
→ 用户可「寻找其他来源」或「一键续取」
```

`runtime_interrupted` 仍保持 Stage E 语义：Runtime 重启后不自动联网，由用户继续原来源。

## 安全边界

Node B 只负责语义身份匹配，不是执行许可。跨来源复用旧 `.part` 仍必须通过 Runtime 的确定性验证：

```text
语义身份匹配
+
remote total 与原任务一致
+
新来源支持 Range
+
已有 .part 的 start / middle / end 小范围字节抽样一致
```

若公开页面已有可靠 checksum，可以作为更强证据；当前不建设强制全文件 hash/chunk tree 架构。

完整 Source URL、Cookie、Authorization、signed token、本地绝对路径和 `.part` 内容不应进入模型 prompt。

## Stage G 真人验收

Stage G 当前**尚未标记完成**。最终需要在真实 Chrome/Edge、真实公网 HTTP/HTTPS 和真实第三方公开资源上完成至少：

- 多个不同 DOM 结构的真实软件下载/文件页面；
- 图片与多图片真实下载；
- 普通 HTTP 直链媒体或大文件；
- Redirect / CDN；
- 一次不同真实公网来源的 Source A → Source B 跨网站恢复；
- 少量非开发者自然试用。

跨网站恢复必须保持同一个 ResourceJob、同一个 `.part`，Source B 用 HTTP Range 从旧百分比继续并最终完成。真实用户结果出来前不宣称 Stage G PASS。

## 基础检查

当前阶段不使用 pytest，也不建设新的测试框架。

```bash
uv run --project services/runtime python -m compileall services/runtime/src

corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
corepack pnpm --filter @xunlei-zhiqu/task-center build
```

关键能力最终以真实网站、真实浏览器、真实模型、真实公网下载和真人使用判断。

## 本地启动

```bash
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app \
  --app-dir services/runtime/src \
  --host 127.0.0.1 \
  --port 8765
```

Task Center：

```bash
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

Extension：

```bash
corepack pnpm --filter @xunlei-zhiqu/extension build
```

Runtime 默认状态库：`~/.xunlei-zhiqu/runtime.db`；下载目录和数据库都可以通过 `.env` 显式指定。

## 明确不扩张

Stage G 不新增聊天、搜索引擎 Agent、自动 Google/Bing、站点爬虫、VLM、BT/Magnet executor、M3U8/DASH downloader、多线程分块、账号/云盘、第二套模型系统或新的大型基础设施。

Magnet、Torrent、M3U8、DASH、blob 等当前执行器不能完成的协议应明确告诉用户“当前版本暂不支持这种下载方式”，而不是创建一个无法完成的任务。

Stage G 完成后不进入 Stage H，只允许真实使用后的 Bugfix、产品文案/体验打磨、录屏和比赛材料。
