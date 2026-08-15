# 迅雷智取

**看懂资源，选对文件，托管到完成。**

迅雷智取是一个面向复杂下载页面的智能资源交付 Agent。它会整理页面中的版本、系统、架构、安装形式、媒体规格和附件，帮助用户选择真正需要的文件，并把下载作为长期任务托管；原来源失效时，还可以在用户当前打开的新页面中重新寻找、验证可用来源并继续原任务。

核心产品由 Chrome / Edge 浏览器扩展、本地 Runtime 和下载任务中心组成。AI 负责理解资源，确定性 Runtime 负责真正执行、验证和恢复。

## 下载

### Windows 10 / 11 x64

Competition Release 的目标交付物为：

- `XunleiZhiqu-Setup-x64.exe` — 推荐安装包；
- `XunleiZhiqu-Portable-x64.zip` — 免安装兜底版本；
- `XunleiZhiqu-Extension.zip` — 浏览器扩展；
- `SHA256SUMS.txt` — Release 文件完整性校验。

当前仓库已经具备 Windows Release 打包流水线，但正式二进制尚需在 Windows x64 构建机生成并完成 clean-machine 真人验收后再发布 GitHub Release。因此这里暂不放一个尚不存在的下载链接。

正式 Release 发布后，普通用户只需要：

1. 下载并运行 `XunleiZhiqu-Setup-x64.exe`；
2. 安装结束后启动迅雷智取，任务中心会自动在浏览器中打开；
3. 安装浏览器扩展；
4. 打开一个真实下载页面，使用迅雷智取 Side Panel。

**已打包的 Competition Release 不要求用户安装 Python、Node.js、pnpm、uv 或源码仓库。**

### 浏览器扩展

浏览器商店入口尚未发布时，Competition Release 使用 Extension ZIP：

1. 下载 `XunleiZhiqu-Extension.zip`；
2. 解压到一个固定目录；
3. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`；
4. 打开“开发者模式”；
5. 点击“加载已解压的扩展程序”；
6. 选择刚才解压的目录。

安装器只安装本地 Runtime，不会修改浏览器注册表或强制安装扩展。

## 30 秒上手

1. 打开一个包含多个下载项的真实网页；
2. 打开迅雷智取 Side Panel；
3. 点击智能分析；
4. 查看版本、平台、架构、格式等通俗说明，并确认需要的资源；
5. 创建下载任务；
6. 在任务中心查看真实下载进度、暂停或继续。

如果原下载地址失效，可以使用“一键续取 / 寻找其他来源”。迅雷智取会在你当前打开的新页面中寻找原资源候选，并在真正切换来源前由本地 Runtime 做确定性验证。

## 产品能力

- **智能整理复杂下载页**：把散落的版本、平台、架构、安装版/便携版、媒体规格和附件整理成可理解的选择。
- **当前设备推荐**：给出有理由、可修改的场景化推荐，而不是替用户猜隐藏意图。
- **批量资源理解**：支持一个页面中的多个相关资源和多 Asset 下载任务。
- **真实本地下载**：HTTP / HTTPS 文件进入本地下载目录，不是浏览器假进度。
- **Pause / Resume**：暂停后继续使用真实 HTTP Range。
- **Runtime 重启恢复**：任务、`.part` 和执行状态由 SQLite 持久化，重启后继续保留。
- **长期任务与失败诊断**：区分普通中断、来源失效、鉴权失效、内容变化和本地保存问题。
- **跨页面一键续取**：来源失效后，可以在当前 active tab 的另一个页面、镜像或 CDN 中寻找同一资源。
- **Node B 找回原资源**：Node B 只负责语义身份匹配。
- **确定性来源验证**：新来源必须满足长度、Range 和已有 `.part` 字节抽样等安全条件后才允许拼接旧进度。

## AI 原生设计

```text
节点 A
→ 第一次理解页面资源并帮助用户选对

节点 B
→ 原来源变化后，在用户当前页面重新找到原资源

确定性 Runtime
→ 真正执行、诊断、验证来源、Range Resume 和 Source Switch
```

项目的核心原则是：**AI 负责理解，不负责证明两个来源可以安全拼接。** Node B 的语义判断不是写入许可；最终是否允许从旧 `.part` 继续，由本地 Runtime 的确定性验证决定。

## 隐私边界

完整 Source URL、Cookie、Authorization、signed token、本地绝对路径、`.part` 内容和下载执行状态属于本地执行层，不应进入模型 prompt。

模型处理的是经过压缩和脱敏的资源语义信息。Node A 使用既有 CloudAnalysisRequest 隐私边界；Node B 的候选与目标文本还会在 Runtime 做 URL / 凭证样式去敏。

## 当前支持范围

Competition Prototype 当前主要面向：

- Windows 10 / 11 x64；
- Chrome / Edge；
- 普通 HTTP / HTTPS 文件型资源；
- 软件安装包、压缩包、文档、图片、普通媒体和大文件等真实公网资源。

当前 Runtime Executor **不执行** Magnet / Torrent / HLS / M3U8 / DASH / `blob:` 等协议，也不会为了比赛版本绕过登录、CAPTCHA、DRM、防盗链或站点安全机制。

## 项目状态

核心闭环已经完成：首次资源理解与选择、真实下载、Pause / Range Resume、SQLite 持久化、来源失效诊断、Node B 重新找回以及确定性 Source Switch 都已进入 `main`。

**Stage G / 真实互联网试用仍在进行中。** Competition Release Packaging 与 Stage G 是否真人公网验收完成是两件事；在真实网站覆盖和 clean-machine 安装验证完成前，不宣称 Stage G PASS 或 Release Verified。

架构与历史验收记录见 `docs/blueprint/`。

## Competition Release 构建

开发机使用 Windows 10 / 11 x64，并准备 Node/Corepack、uv；要生成安装包还需要 Inno Setup。Release 构建不会自动 commit、push 或发布 GitHub Release。

在仓库根目录运行：

```powershell
.\scripts\build-release.ps1
```

脚本依次执行基础编译/类型检查、Task Center build、Extension build、PyInstaller onedir、Portable ZIP、Extension ZIP、Inno Setup 和 SHA256，最终统一输出到：

```text
artifacts/release/
├─ XunleiZhiqu-Setup-x64.exe
├─ XunleiZhiqu-Portable-x64.zip
├─ XunleiZhiqu-Extension.zip
└─ SHA256SUMS.txt
```

如果没有安装 Inno Setup，脚本会明确报告 Installer 未生成；Portable 和 Extension 仍会保留用于排查，但不能把这种状态称为完整 Competition Release。

### Competition Gateway

Release **绝不打包开发者 `.env` 或供应商 root API key**。面向比赛交付的零配置 AI 路径应连接专门的 Competition AI Gateway，并使用可吊销、有限额度的客户端 token。

构建时可以显式传入：

```powershell
.\scripts\build-release.ps1 `
  -GatewayBaseUrl "https://your-competition-gateway.example/v1" `
  -GatewayModel "deepseek-v4-flash" `
  -GatewayToken "competition-client-token"
```

`GatewayToken` 必须是为 Competition Release 单独设计的客户端凭证，不能是 DashScope / OpenAI 等供应商 root key。构建脚本会拒绝已知的直接供应商 endpoint，并在发现传入 token 与本地 `.env` 的 `MODEL_API_KEY` 相同时停止打包。

如果当前还没有 Competition Gateway，可以不传这些参数完成 Packaging；此时应准确描述为：**Packaging complete，AI zero-config release blocked by missing Competition Gateway**。

## 开发

开发模式仍保持现有 `.env` 和三端工作流。前端使用仓库锁定的 pnpm 版本。

安装依赖：

```powershell
corepack pnpm install
uv sync --project services/runtime
```

基础检查：

```powershell
uv run --project services/runtime python -m compileall services/runtime/src
corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
corepack pnpm --filter @xunlei-zhiqu/task-center build
```

开发模式启动 Runtime：

```powershell
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app --app-dir services/runtime/src --host 127.0.0.1 --port 8765
```

开发模式启动 Task Center：

```powershell
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

Runtime 默认状态库为 `~/.xunlei-zhiqu/runtime.db`，默认下载目录为 `~/Downloads/迅雷智取`。Competition Installer 只替换程序文件，不应把这些用户任务和下载文件写进或绑死在安装目录。
