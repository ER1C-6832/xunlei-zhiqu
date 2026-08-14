# 迅雷智取：闭环资源交付 Agent 开发者决策蓝图

> **产品名**：迅雷智取  
> **技术定义**：单编排器、双智能节点、确定性执行的闭环资源交付 Agent  
> **当前代码事实来源**：GitHub `main`  
> **当前阶段**：Stage F — Diagnosis、重新智取、Node B 与一键续取闭环

这份 v0.4 只保留当前开发仍然有效的产品与架构约束。历史方案与早期测试/协作流程可从 Git 历史查看；当历史内容与当前 `main` 或本文件冲突时，以当前 `main` 和最新开发纪律为准。

---

## 1. 产品定义

迅雷智取不是通用聊天助手、通用爬虫或纯链接下载器。

产品由三部分组成：

1. Chrome / Edge Manifest V3 浏览器扩展；
2. Python FastAPI 本地 Runtime；
3. React 实现的迅雷 17 风格下载任务中心。

核心结构固定为：

```text
单编排器
+
节点 A：第一次理解页面资源并帮助用户选对
+
节点 B：原来源失效后，在新环境中重新找到原资源
+
确定性 Runtime：真正执行、诊断、验证与切换来源
```

模型不直接写文件、不决定 Range append、不删除用户数据，也不把“看起来像同一资源”当作可以拼接旧字节的证明。

---

## 2. 当前完整产品链路

首次获取：

```text
真实页面
→ 多通道 Capture
→ Node A
→ ResourcePlan
→ 用户确认
→ ResourceJob
→ ExecutionAsset[]
→ HttpDownloadExecutor
→ .part
→ final
```

失败恢复：

```text
真实下载
→ 来源失效
→ DiagnosisService
→ waiting_for_source
→ 一键续取
→ Browser Reacquisition
→ 复用 Capture
→ Node B
→ Source Verification
→ Source A → Source B
→ 原 ResourceJob / 原 .part / 原 offset 继续
→ 完成
```

任何恢复都必须保持原任务身份。验证通过后不创建第二个 ResourceJob。

---

## 3. Stage E 状态

Stage E 已完成功能与真人真实链路验收。

```text
Stage E / Wave A：完成
Stage E / Wave B：完成
Stage E / Wave C：完成并真人验收
Stage E：完成
```

真人已确认：

```text
JDK 下载中
→ Runtime kill
→ Runtime restart
→ 原 ResourceJob 恢复
→ 原 .part 保留
→ HTTP Range 从磁盘实际 offset 继续
→ 最终完成
```

因此普通网络抖动、用户 Pause、Runtime restart、同来源 Range Resume 都属于 Stage E，不属于 Node B。

必须始终维持：

```text
interrupted != waiting_for_source
```

---

## 4. 当前开发纪律

### 4.1 真实反馈优先

当前 Demo 阶段不使用 pytest，不追求自动化测试体系，也不把旧 assertion 当作业务事实。

Python 基础检查：

```bash
uv run --project services/runtime python -m compileall services/runtime/src
```

前端基础检查：

```bash
corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
corepack pnpm --filter @xunlei-zhiqu/task-center build
```

关键能力以以下事实验收：

```text
真实页面
真实浏览器交互
真实 Runtime
真实下载
真实 .part
真实 HTTP Range
受控真实故障
真实日志
```

可以保留 `demo/fault-scenarios/`、`scripts/manual-*.py` 这类真人 Demo / smoke 工具，但不重新包装成测试框架。

### 4.2 直接 main 快速迭代

当前阶段直接在 `main` 开发，正常小 commit，不建立长期 Wave/agent 分支，不创建 Draft PR，不重写 main 历史。

### 4.3 少抽象

除非真实链路需要，否则不新增复杂 Incident 层、ResourceGraph、Event Sourcing、消息总线、WebSocket、Redis/Kafka 或新的数据库框架。

---

## 5. 技术栈

Runtime：

- Python 3.12+
- FastAPI
- Uvicorn
- Pydantic / pydantic-settings
- HTTPX
- stdlib SQLite

前端：

- React
- TypeScript
- Vite / pnpm workspace
- Chrome / Edge Manifest V3 Extension

模型：

- `ModelProviderAdapter`
- `ProviderApiAdapter`
- 当前 DashScope/OpenAI-compatible 供应商实现
- Node A 与 Node B 复用同一模型接入体系

当前 Runtime 技术栈不包含 pytest / pytest-asyncio。

---

## 6. 持久任务模型

外部长期对象仍然是 `ResourceJob`。

下载执行仍然是：

```text
ResourceJob
→ DownloadExecutionRequest
→ ExecutionAsset[]
```

Stage F 不推翻这套模型。

Runtime 本地 SQLite 保存：

- public ResourceJob snapshot；
- private acquisition context；
- execution request / asset source facts；
- execution status；
- Stage E Range / path / validator facts；
- pending RecoveryContext；
- 极简 `recovery_history[]`。

恢复上下文直接附着在当前 Job JSON snapshot，不建设多张恢复表。

模型输入不包含 Cookie、Authorization、完整 HTML、本地绝对路径、`.part` 内容或完整临时 URL token。

---

## 7. Stage F：Diagnosis

Diagnosis 是确定性服务，不是 Agent，也不调用 LLM。

最小输出：

```text
action:
  retry_same_source
  resume_same_source
  fix_local_issue
  reacquire_source
  stop

reason:
  source_unavailable
  auth_or_link_expired
  source_changed
  network_interrupted
  disk_full
  permission_denied
  range_unavailable
  local_path_issue
```

核心规则：

```text
runtime_interrupted / connection_interrupted
→ same-source resume/retry

500 / 502 / 503 / 504
→ 一次轻量 same-source retry
→ 仍失败才 reacquire_source

404 / 410
→ source_unavailable
→ waiting_for_source

401 / 403
→ auth_or_link_expired
→ waiting_for_source

remote_changed / Range mismatch
→ source_changed
→ waiting_for_source

disk / permission / path
→ fix_local_issue
→ 不调用 Node B
```

公开 Job status 不为 Stage F 爆炸式扩张。短时步骤只放 Runtime internal `recovery_phase`，Task Center 映射成“正在检查来源 / 正在寻找新的下载地址 / 正在验证新来源 / 正在继续下载”。

---

## 8. 一键续取

只有 Diagnosis 得出 `reacquire_source` 后：

```text
status = waiting_for_source
next_action = continue_acquisition
```

Task Center 原任务行出现主动作：

```text
一键续取
```

不再另设独立 ResumeRecoveryBar，也不允许两套 `/v1/jobs` 轮询。

执行顺序：

### Tier 1 — 当前来源

若来源恢复并能通过确定性检查，直接 same-source resume，不调用 Node B。

### Tier 2 — 已有备用来源

`alternate_sources[]` 先经过确定性验证；安全才切换，不调用 Node B。

### Tier 3 — 浏览器重新智取

当前与备用都不可用：

```text
Runtime 创建并持久化 RecoveryContext
→ continue-acquisition 返回 recovery_id / original_page_url
→ Task Center 打开原页面
→ Extension 获取 pending recovery
→ 当前页面重新 Capture
→ Node B 匹配
→ Runtime verifier 验证
```

---

## 9. RecoveryContext

保持轻量，至少携带：

- recovery_id / job_id / asset_id；
- resource title / type；
- 已确认 variant 摘要与关键版本/平台/架构/package/media 属性；
- original page URL / title（只在本地）；
- original source facts（只在本地）；
- expected total；
- downloaded bytes；
- failure reason；
- confirmed item / plan 摘要。

Runtime 重启后 pending recovery 不丢失。

Extension 只展示用户语言：

```text
继续下载
资源名称
已确认规格
已保留 xx% 下载进度
正在当前页面寻找可用下载地址…
```

不向用户暴露 RecoveryContext、Reacquisition、Candidate、Evidence、Node B 等内部术语。

---

## 10. Node B

Node B 的唯一职责：

> 判断新页面中的哪些候选在语义上可能是原任务已经确认的资源。

禁止 Node B：

- 新建/修改 ResourceJob；
- 删除文件；
- 切换 Source；
- 决定 Range append；
- 证明字节完全相同；
- 重新生成 ResourcePlan。

恢复链路默认不重新调用 Node A：

```text
Original Resource Identity
+
New Page Candidates
→ Node B
```

Node B 复用当前 `ModelProviderAdapter` / `ProviderApiAdapter` / provider/model，不建立第二套供应商体系。

输入保持紧凑：target、失败摘要、候选的 label/filename/content-type/size/附近文本等去敏信息。原始候选 URL 只留在本地 Runtime map，不进入模型 prompt。

输出保持很小：

```json
{
  "matches": [{"candidate_id": "c1", "confidence": "high", "reason": "版本、平台、架构和安装类型一致"}],
  "possible": [{"candidate_id": "c4", "reason": "版本一致但安装类型不同"}],
  "reject": [{"candidate_id": "c2", "reason": "架构不一致"}]
}
```

正常 Recovery 最多一次 Node B 主调用，输出预算约 512 tokens。模型失败时降级为用户手选候选，随后仍然走同一个确定性 verifier。

---

## 11. Source Verification

Node B 结果不是执行许可。

强 checksum 若页面已经公开提供可以利用，但第一版不要求所有资源全文件 SHA256。

有 `.part` 时优先使用：

```text
semantic identity
+
remote total == original expected total
+
Range supported
+
已有区间 start / middle / end 的 32~64 KB byte samples 全部与本地 .part 一致
```

该证据称为：

```text
sample_match
```

不是 `cryptographically_identical`。

Source B 不支持 Range：

```text
可以认为是正确资源
但不能复用旧 .part 自动 append
```

byte sample 任一不一致：

```text
verification = mismatch
→ reject
→ 禁止 switch_source
→ 禁止 append
→ 原 .part 保持不变
```

---

## 12. Source Switch

验证通过后只切换原 ExecutionAsset：

```text
primary_source = Source B
```

必须保留：

```text
same job_id
same asset_id
same final_path
same part_path
```

offset 永远来自磁盘实际 `.part` size。

Source B 随后的真实下载仍必须满足 Stage E 的 Range 安全条件：

```text
Range: bytes=<actual_part_size>-
→ HTTP 206
→ exact Content-Range start
→ exact total
→ validator / remote facts safe
→ append existing .part
```

否则停止，不污染旧进度。

---

## 13. 受控故障 Demo

`demo/fault-scenarios/recovery_server.py` 提供合法自控内容：

- Source A：正常文件 + Range，可切换为永久失效；
- Source B：不同 URL、与 A 完全相同字节、支持 Range；
- Source C：名称和大小相似，但实际字节不同。

Stage F 真人主验收只认下面完整链路：

```text
Source A
→ 真下载到 30%~50%
→ A 永久失效
→ Diagnosis
→ waiting_for_source
→ 一键续取
→ Browser Reacquisition
→ Node B
→ B / C 进入验证
→ B sample_match
→ C mismatch
→ Source A → B
→ 原 .part 从旧 offset 增长
→ 100%
```

同时真人看三条边界：

1. 本地路径/磁盘类错误不触发 Node B；
2. 临时网络中断优先当前 Source；
3. Source C 被 verifier 拒绝且 `.part` 不被污染。

只有上述主链路在真实浏览器/Runtime 中成功，Stage F 才能标记完成。

---

## 14. 当前明确不做

Stage F 不扩张到：

- 通用搜索引擎或 Google/Bing 全网搜索；
- 多 Agent；
- 复杂 ResourceGraph；
- Event Sourcing；
- WebSocket；
- Redis/Kafka；
- 新数据库框架；
- 强制全文件 hash / chunk hash tree；
- P2P / BT / Magnet executor；
- HLS / DASH downloader；
- 多线程 HTTP 下载；
- 真实迅雷账号；
- 云 AI Gateway 产品化；
- Native Messaging；
- 付费体系；
- 视觉模型；
- Node A 新一轮性能优化；
- 登录、付费墙、CAPTCHA、DRM 绕过；
- 下载后自动执行未知文件。

当前 Demo 的重点只有一个：**跨来源恢复 Agent 闭环。**
