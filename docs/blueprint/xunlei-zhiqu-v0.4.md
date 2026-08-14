# 迅雷智取：闭环资源交付 Agent 开发者决策蓝图

> **产品名**：迅雷智取  
> **技术定义**：单编排器、双智能节点、确定性执行的闭环资源交付 Agent  
> **当前代码事实来源**：GitHub `main`  
> **当前阶段**：Stage G — 真实环境泛化、真实试用与产品收口

这份蓝图只保留当前仍有效的产品与工程约束。Stage A~F 的历史实现与验收事实保留在 Git 历史和对应 acceptance 文档中；当前开发不再扩张核心能力。

---

## 1. 产品边界

迅雷智取由三部分组成：

1. Chrome / Edge Manifest V3 浏览器扩展；
2. Python FastAPI 本地 Runtime；
3. React 下载任务中心。

固定技术结构：

```text
单编排器
+
节点 A：第一次理解页面资源并帮助用户选对
+
节点 B：原来源失效后，在用户当前页面中找回原资源
+
确定性 Runtime：执行、诊断、来源验证与 Source Switch
```

不做通用聊天助手、通用爬虫、自动搜索引擎或纯链接下载器。

---

## 2. 已完成阶段

```text
Stage A~D：完成
Stage E0：完成
Stage E：完成并真人验收
Stage F：完成并通过受控真人端到端闭环验收
Stage G：进行中
```

Stage E 已证明同来源真实 HTTP Range、SQLite 持久化、Runtime restart 后原任务原 `.part` 继续。

Stage F 已证明：Source A 永久失败后，Diagnosis → 一键续取 → Browser Reacquisition → 真实 Node B → B sample_match / C mismatch → Source Switch → 原 `.part` 从旧 offset 继续 → 最终内容正确。详细记录见 `docs/blueprint/F-acceptance.md`。

受控场景通过只证明 Recovery Architecture，不等于真实互联网泛化完成。

---

## 3. Stage G 唯一目标

把已经完成的完整产品从“架构闭环成立”推进到：

> **真实互联网环境里可以正常使用的完整可试用原型。**

Stage G 不再增加新的 Agent 模块。完成后不进入 Stage H，只允许真实使用后的 Bugfix、文案/体验打磨、录屏和比赛材料。

---

## 4. 当前完整产品链路

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
→ 必要时一键续取 / 寻找其他来源
→ 用户进入任意相关真实页面
→ Extension Recovery Mode
→ 当前 active tab Capture
→ Node B
→ Runtime Source Verification
→ Source Switch
→ 原 ResourceJob / 原 .part / 原 offset 继续
→ 完成
```

恢复永远保持原任务身份，不创建第二个 ResourceJob。

---

## 5. Recovery Mode 的真实网站边界

原资源页只是恢复后的默认落点，不是范围边界。

只要 pending RecoveryContext 存在，用户可以去：

- 原网站其他下载页；
- 官方镜像页；
- 其他 CDN；
- 另一个域名；
- 另一个真实资源站。

Extension 继续显示：

```text
继续下载
资源名称 / 已确认规格
已保留 xx%
在当前页面寻找可用下载地址
```

只允许操作当前 active tab。首次打开恢复页可以自动扫描一次；之后导航或切换页面只提示用户显式“在当前页面寻找”。禁止遍历所有 tabs、后台爬网页、自动打开 Google/Bing 或自行全网搜索。

---

## 6. Node A / Node B 模型边界

Node A 在 Stage G 冻结。除非真实网站持续暴露某一类通用资源无法理解，否则不做新 profile、benchmark、换模型或 token 微优化。

Node B 只做语义身份匹配：

```text
Original Resource Identity
+
Current Page Candidates
→ Node B
```

Node A 与 Node B 都通过正式 `ModelProviderAdapter` 使用模型。Node B 使用公开的结构化语义能力，不读取 Provider `_inner`、`_client`、`_api_adapter`、`_model` 私有字段。

```text
ModelProviderAdapter
→ StructuredChatProvider
→ ProviderApiAdapter
→ supplier/model dialect
```

不建立第二套 Gateway 或 Provider。

---

## 7. Runtime 状态推进

`GET /v1/jobs` 与 `GET /v1/jobs/{job_id}` 是纯读，不承担 Diagnosis、retry 或状态迁移。

Executor 的 state sink 负责把真实执行状态持久化；Runtime 内部轻量 reconcile loop 在失败后做：

```text
failure facts
→ DiagnosisService
→ retry_same_source / resume_same_source / fix_local_issue / reacquire_source
→ persist public state
```

不建设 Event Bus、WebSocket、Redis/Kafka 或新的状态框架。

核心语义：

```text
runtime_interrupted
→ 用户决定何时继续，不自动联网

connection_interrupted
→ 一次 same-source retry
→ 仍失败则允许“寻找其他来源”

500 / 502 / 503 / 504
→ 一次 same-source retry
→ 仍失败则 reacquire_source

404 / 410
→ source_unavailable
→ waiting_for_source

401 / 403
→ auth_or_link_expired
→ waiting_for_source

remote_changed / Range mismatch
→ source_changed
→ waiting_for_source

local disk / permission / path
→ fix_local_issue
→ 不调用 Node B
```

`interrupted != waiting_for_source` 继续保持。

---

## 8. Source Verification 与 `.part` 安全

Node B 的语义结果不是执行许可。

已有 `.part` 时，通用 fallback 仍然要求：

```text
semantic identity
+
remote total == original expected total
+
Range supported
+
已有区间 start / middle / end 小范围 byte samples 与本地 .part 一致
```

任一不一致：

```text
reject
→ 禁止 switch_source
→ 禁止 append
→ 原 .part 保持不变
```

若真实页面明确提供可靠 checksum，可以保存并优先利用，但不建设强制全文件 hash、chunk hash tree 或新的 identity 架构。

验证通过后只更新原 ExecutionAsset 的 primary source，保留：

```text
same job_id
same asset_id
same final_path
same part_path
offset = filesystem .part size
```

Source B 必须返回安全的 HTTP 206 / exact Content-Range 后才能 append。

---

## 9. 模型隐私

完整 Source URL 只属于本地执行层。

Node A / Node B 模型输入不得包含：

- query token / signed secret；
- Cookie；
- Authorization；
- 完整临时 URL；
- 本地绝对路径；
- `.part` 内容；
- 完整 HTML。

Node A 使用既有 CloudAnalysisRequest 隐私边界；Node B 除排除 raw source 外，在 Runtime 再对候选/目标文本做 URL 与凭证样式去敏。

---

## 10. Stage G 开发纪律

```text
不写 pytest
不运行 pytest
不新增测试框架
直接 main 小步开发
不创建 agent branch
不创建 Draft PR
```

基础检查：

```bash
uv run --project services/runtime python -m compileall services/runtime/src

corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
corepack pnpm --filter @xunlei-zhiqu/task-center build
```

能力只以真实网站、真实 Chrome/Edge、真实公网 HTTP/HTTPS、真实模型、真实下载、真实故障和真人使用判断。

`demo/fault-scenarios/` 只作为 Stage F 历史调试工具保留；Stage G 不继续开发、不部署到公网、不作为 PASS 条件。

---

## 11. Stage G 真实使用范围

不做固定网站测试矩阵，也不写 hostname 特判。真实试用应覆盖明显不同的 DOM / 下载路径，例如：

- 简单软件下载页；
- 版本/平台/架构复杂的软件发布页；
- GitHub Release 或类似 Release 列表；
- PDF / 数据文件；
- 普通图片、srcset/高清图；
- 多图片选择与多 Asset 落盘；
- 普通 HTTP MP4/WebM/大文件；
- 302 Redirect → CDN → actual file。

若遇到登录、CAPTCHA、DRM、防盗链或特殊鉴权，记录为当前 Limit，不绕过安全机制。

Magnet、Torrent、M3U8、DASH、blob 等当前执行器不能完成的协议应明确告诉用户“当前版本暂不支持这种下载方式”，不创建假下载任务。

---

## 12. Stage G 最关键真人验收

不使用 localhost。

```text
真实网站 A
→ Extension + Node A
→ 真实公网 Source A 下载到 20%~50%
→ 网络层使 Source A 不可连接
→ 一次 same-source retry 失败
→ 寻找其他来源
→ 用户进入真实网站 B
→ Extension 保持 Recovery Mode
→ 当前页 Capture
→ Node B
→ Runtime verifier
→ 同一个 ResourceJob
→ 同一个 .part
→ Source B HTTP Range
→ 从旧百分比继续
→ 100%
→ 最终内容正确
```

Source A/B 必须是真实第三方公开合法资源，最好不同 hostname；可对真实 Source A 做本机网络层故障注入，但禁止为了验收部署远程 fake server。

最终文件优先使用官方 SHA256/SHA512；没有官方 checksum 时，可人工完整下载 Source B 参考文件对比 hash，但这不进入产品代码。

---

## 13. Stage G 完成条件

最终真人使用至少应覆盖：

```text
多个结构不同的真实软件下载 / 文件网站
1 个真实图片场景
1 个多图片场景
1 个真实直链媒体 / 大文件场景
1 个 Redirect / CDN 场景
1 个真实跨网站 Source A → Source B 恢复
少量非开发者自然试用
```

数量服从质量，不做为了打勾而扩张的测试平台。

只有真实使用证据完成后才把 Stage G 标记为完成。Code Agent 无法替代真实 Chrome、公网实际下载和真人反馈时，必须明确写“代码已准备，等待真人验收”，不能用 localhost/fixture/mock 宣布 PASS。

---

## 14. Stage G 之后

Stage G 完成后 Code Freeze。

不再问“还能加什么”，只允许：

```text
真实使用
→ 修 Bug
→ 产品文案/体验打磨
→ 录 Demo
→ 比赛材料
```

最终目标不是“生产可用/百万用户稳定”，而是：

> **真实 Browser Extension + 真实 Model + 真实公网资源 + 真实下载 + 真实长期任务 + 真实恢复的完整可试用原型。**
