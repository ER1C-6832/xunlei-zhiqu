# 迅雷智取

> 单编排器、双智能节点、确定性执行的闭环资源交付 Agent。

`main` 是当前代码事实来源。产品不扩张成通用聊天助手、通用爬虫或纯链接下载器；核心仍是 Chrome/Edge MV3 Extension、Python FastAPI Runtime 和 React 下载任务中心。

## 开发进度

- **Stage A~D：完成** — 页面资源采集、候选融合、Node A、ResourcePlan、用户确认与三端主链路。
- **Stage E0：完成** — 架构接缝、Provider/Executor 边界与 Node A 交互性能基线。
- **Stage E / Wave A：完成** — 真实 HTTP/HTTPS 下载与 `.part -> final`。
- **Stage E / Wave B：完成** — `interrupted`、失败事实、多 Asset 与 Task Center 真实状态。
- **Stage E / Wave C：完成并真人验收** — HTTP Range、`.part` 断点、SQLite 持久化、Runtime kill/restart 后原任务原路径继续。
- **Stage E：完成**。
- **Stage F：完成并真人验收** — Diagnosis、一键续取、Browser Reacquisition、真实 Node B、确定性来源验证与 Source Switch 已完整闭环。

Stage E 真人验收事实：JDK 真实下载中关闭 Runtime，重启后原 ResourceJob 和 `.part` 仍在，继续下载使用 HTTP Range 从原 offset 增长并最终完成；没有从 0 重来，也没有产生重复文件名。

Stage F 真人验收事实：受控真实 HTTP 下载中 Source A 在约 39.4% 进度永久失效并返回 HTTP 410；Diagnosis 得到 `source_unavailable → reacquire_source → waiting_for_source`；Task Center 一键续取后浏览器重新 Capture，Node B 使用真实 `deepseek-v4-flash` 调用匹配两个候选；Runtime 对 Source B 完成 3 段 `sample_match`，对同名同大小但不同字节的 Source C 明确 `mismatch`；随后原任务以磁盘 `.part` 的 `105644032` bytes 为 offset 切换到 Source B，收到 `206` 且 `Content-Range` 从同一 offset 开始，最终完成 256 MiB 文件。最终跨来源拼接文件 SHA256 与完整 Source B 参考文件完全一致：`F17D53B0A0D7968B33C22C7F941C8691C041BE00DD5889F5BE4998341927BE9D`。

## 核心架构

```text
Browser Extension
  ├─ 普通模式：Capture → Node A → ResourcePlan → 用户确认
  └─ 恢复模式：pending recovery → Capture → Node B
                                      │
                                      v
Runtime / Single Orchestrator
  ├─ ModelProviderAdapter + ProviderApiAdapter
  ├─ ResourceJob + private acquisition context
  ├─ DiagnosisService                 # 确定性
  ├─ Source Verification              # 确定性
  └─ RecoverableHttpDownloadExecutor
            │
            ├─ same-source Range resume
            └─ verified Source A → Source B switch

Task Center
  └─ 原任务行：继续下载 / 一键续取
```

Node A 只负责第一次理解并选择资源。Node B 只负责在新页面中判断哪些候选可能仍是原任务资源。真正决定新来源能否接到旧 `.part` 后面的，是 Runtime 的确定性验证器，而不是模型置信度。

## Stage F 恢复语义

`interrupted != waiting_for_source`。

```text
Download failure
  ↓
DiagnosisService
  ├─ runtime / connection interruption → same-source resume/retry
  ├─ 5xx → 一次轻量 same-source retry，再失败才重新智取
  ├─ 404 / 410 → source_unavailable → waiting_for_source
  ├─ 401 / 403 → auth_or_link_expired → waiting_for_source
  ├─ remote_changed / range mismatch → source_changed → waiting_for_source
  └─ disk / permission / path → fix_local_issue，不调用 Node B
```

只有 `waiting_for_source` 才出现 **一键续取**。

一键续取按三层执行：

1. 当前来源若仍可安全使用，直接同来源恢复；
2. 已有 `alternate_sources[]` 先做确定性验证，通过则直接切换；
3. 都不可用才建立持久化 RecoveryContext，打开原资源页，由 Extension 复用现有 Capture 系统收集新候选并交给 Node B。

Node B 不重新调用 Node A，也不会创建新 ResourcePlan。它只接收原已确认资源的紧凑身份摘要、失败类型和去敏后的候选摘要，输出高概率/可能/拒绝候选。原始 URL、Cookie、Authorization、完整 HTML、本地绝对路径和 `.part` 内容不会发给模型。

### 跨来源 `.part` 验证

Node B 的结果不是执行许可。对已有 `.part`，Runtime 要求：

```text
语义身份匹配
+
remote total 与原任务一致
+
Source B 支持 Range
+
本地已下载区间的 start / middle / end 小范围字节抽样全部一致
```

验证结果内部称为 `sample_match`，不是密码学完整性证明。Source B 不支持 Range 时可以作为从头下载来源，但不能自动复用旧进度；任一抽样不一致则明确拒绝，并保持原 `.part` 不变。

验证通过后只更新原 `ExecutionAsset.primary_source`，保留同一个 `job_id`、`asset_id`、`final_path`、`part_path`，并以磁盘上实际 `.part` 大小作为 offset 向 Source B 请求 Range。

## 受控 Stage F Demo

启动故障服务器：

```bash
python demo/fault-scenarios/recovery_server.py
```

资源页：

```text
http://127.0.0.1:8877/resource
```

Source A 正常时页面只提供 A。把真实任务下载到约 30%~50% 后，可让 A 永久失效：

```text
http://127.0.0.1:8877/control?source_a=gone
```

重新打开资源页后会出现：

- Source B：与 A 完全相同的字节内容，不同 URL，支持 Range；
- Source C：名称和总大小相同，但字节内容不同。

已真人验收链路：

```text
Source A 真下载
→ A 永久失效
→ Diagnosis
→ waiting_for_source
→ Task Center「一键续取」
→ 浏览器原资源页进入「继续下载」模式
→ Capture B / C
→ Node B 语义匹配
→ Verifier: B sample_match / C mismatch
→ 原 ResourceJob Source A → Source B
→ 原 .part 从旧 offset 继续
→ 100%
→ 最终 SHA256 与完整 Source B 一致
```

## 当前开发纪律

当前 Demo 阶段**不使用 pytest**，不追求自动化测试框架。基础错误只用编译、typecheck 和 build 守住；关键能力用真实页面、真实下载、真实 Runtime 和受控故障场景验收。

Python：

```bash
uv run --project services/runtime python -m compileall services/runtime/src
```

前端：

```bash
corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
corepack pnpm --filter @xunlei-zhiqu/task-center build
```

开发直接基于 `main` 小步提交，不建立长期 Wave/agent 开发分支，不重写 `main` 历史。

## 本地启动

```bash
corepack pnpm install
uv sync --project services/runtime
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --host 127.0.0.1 --port 8765
```

另一个终端：

```bash
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

构建扩展：

```bash
corepack pnpm --filter @xunlei-zhiqu/extension build
```

Runtime 默认本地状态库：`~/.xunlei-zhiqu/runtime.db`。可通过 `.env` 的 `RUNTIME_STATE_DB` 和 `DOWNLOAD_DIRECTORY` 显式指定 Demo 数据库与下载目录。

## 明确边界

当前主 Demo 聚焦普通 HTTP/HTTPS byte stream。Stage F 不扩张到通用搜索引擎、多 Agent、ResourceGraph、Event Sourcing、WebSocket、Redis/Kafka、BT/Magnet executor、HLS/DASH downloader、多线程 HTTP、视觉模型、登录/付费墙/CAPTCHA/DRM 绕过或下载后自动执行文件。
