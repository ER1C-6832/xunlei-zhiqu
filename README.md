# 迅雷智取

> 看懂资源，选对文件，托管到完成。

迅雷智取是一款面向复杂下载页面的智能资源下载工具。它会从网页中整理真正可下载的资源，识别版本、系统、架构、安装形式、媒体规格和附件差异，给出可解释、可修改的选择，并由本地 Runtime 负责真实下载、断点续传和来源恢复。

它不是通用聊天助手，也不是简单的“复制链接下载器”。迅雷智取关注的是一件事：**从复杂页面中找到正确资源，并可靠地交付到本地。**

## 下载

支持 **Windows 10 / 11 x64**，浏览器支持 **Chrome / Edge**。

前往 [GitHub Releases](https://github.com/ER1C-6832/xunlei-zhiqu/releases/latest) 下载最新版本：

| 文件 | 用途 |
| --- | --- |
| `XunleiZhiqu-Setup-x64.exe` | Windows 安装包，推荐普通用户使用 |
| `XunleiZhiqu-Portable-x64.zip` | 免安装便携版 |
| `XunleiZhiqu-Extension.zip` | 浏览器扩展独立包，作为安装兜底 |
| `SHA256SUMS.txt` | Release 文件 SHA256 校验值 |

安装包不要求用户额外安装 Python、Node.js、pnpm、uv 或源码仓库。

## 快速开始

1. 安装并启动迅雷智取；
2. 按安装助手完成 Chrome / Edge 扩展加载；
3. 打开一个包含下载资源的网页；
4. 打开迅雷智取 Side Panel，点击 **智能分析**；
5. 查看推荐资源及版本、平台、架构、格式等说明；
6. 确认需要的资源并开始下载；
7. 在任务中心查看进度、暂停、继续或处理下载异常。

本地 Runtime 启动后，任务中心默认位于：

```text
http://127.0.0.1:8765/app/
```

## 为什么需要迅雷智取

软件下载页、Release 页面、镜像站、素材页和媒体页往往同时存在多个看起来都能下载的链接：

- Windows / Linux / macOS；
- x64 / x86 / ARM64；
- EXE / MSI / ZIP / portable；
- stable / beta / source code；
- 原图 / 缩略图 / 多种尺寸；
- 不同编码、分辨率和音频格式；
- 多个 CDN、镜像或临时下载地址。

迅雷智取会先理解这些资源之间的差异，再让用户确认下载内容，而不是把页面上的所有链接原样堆出来。

## 核心能力

### 智能资源理解

- 从真实网页中采集可下载资源和周边语义；
- 将版本、系统、架构、安装形式、媒体规格等技术信息翻译成更易理解的说明；
- 根据当前设备给出有理由、可修改的推荐；
- 支持一个页面中的多个相关资源和多文件任务。

### 真实本地下载

- HTTP / HTTPS 文件真实写入本地磁盘；
- 下载过程使用 `.part` 临时文件；
- 支持暂停与 HTTP Range 续传；
- 任务状态使用 SQLite 持久化；
- Runtime 重启后保留任务与已有下载进度；
- 已完成 Asset 不会因为多文件任务恢复而重复下载。

### 来源失效后的重新智取

如果原下载地址失效，迅雷智取不会直接丢弃已有进度。

用户可以打开另一个相关页面、官方镜像或其他 CDN，然后在 Side Panel 中选择 **在当前页面寻找**。系统会尝试找到与原任务语义一致的新来源，并在通过本地确定性验证后继续原任务。

```text
原来源失效
    ↓
下载诊断
    ↓
同来源轻量重试
    ↓
寻找其他来源
    ↓
当前页面资源采集
    ↓
AI 语义匹配
    ↓
本地确定性来源验证
    ↓
Source Switch
    ↓
从原 .part / 原 offset 继续下载
```

跨来源续传不会只依赖模型判断。新来源必须由 Runtime 验证文件长度、Range 能力和已有 `.part` 的字节抽样一致性，确认能够安全拼接后才允许继续写入。

## 工作原理

迅雷智取由三个部分组成：

```text
Chrome / Edge Extension
        │
        │ 页面资源采集、交互与恢复入口
        ▼
Python FastAPI Runtime
        │
        ├─ Node A：首次资源理解与选型
        ├─ Node B：来源失效后的语义重新匹配
        └─ Deterministic Runtime：下载、诊断、验证、续传
        │
        ▼
React Task Center
```

核心原则是：

> **AI 负责理解，确定性 Runtime 负责执行和证明。**

Node A 帮助用户第一次选对资源；Node B 在来源变化后帮助找回同一资源。模型的语义结果不会直接获得磁盘写入许可，真正的下载、续传和 Source Switch 都由本地 Runtime 控制。

## 浏览器扩展

Windows 安装包会同时安装扩展文件，并提供扩展安装助手。受 Chrome / Edge 的本地扩展安装策略限制，未上架浏览器商店时仍需要用户在浏览器中进行一次确认。

安装器会帮助打开对应的扩展管理页和扩展目录。手动安装时也可以使用 `XunleiZhiqu-Extension.zip`：

1. 解压 ZIP；
2. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`；
3. 开启开发者模式；
4. 选择 **加载已解压的扩展程序**；
5. 选择包含 `manifest.json` 的扩展目录。

## 支持范围

当前版本主要面向普通公开 HTTP / HTTPS 文件型资源，包括：

- 软件安装包与 Release Assets；
- ZIP / 7z / tar 等压缩包；
- PDF、数据文件和普通附件；
- 图片与多图片页面；
- 普通音视频直链；
- 大文件、Redirect 和 CDN；
- 支持 HTTP Range 的镜像来源。

以下类型当前不会进入下载执行器：

- Magnet / Torrent；
- HLS / M3U8；
- MPEG-DASH；
- `blob:` URL；
- DRM 内容；
- 需要绕过登录、CAPTCHA、防盗链或其他站点安全机制的资源。

遇到当前不支持的协议时，产品应明确提示能力边界，而不是创建一个无法完成的下载任务。

## 隐私与安全

下载执行层保留在本地 Runtime。

完整 Source URL、Cookie、Authorization、signed token、本地绝对路径、`.part` 内容和下载执行状态不应发送给模型。模型侧处理的是经过压缩和脱敏的资源语义信息；来源切换的最终许可仍由本地确定性验证决定。

默认服务只监听：

```text
127.0.0.1:8765
```

不会默认暴露到局域网。

## 数据位置

默认下载目录：

```text
~/Downloads/迅雷智取
```

默认 Runtime 状态库：

```text
~/.xunlei-zhiqu/runtime.db
```

Runtime 日志：

```text
~/.xunlei-zhiqu/logs/runtime.log
```

安装或升级程序文件不会主动删除用户下载任务和下载目录。

## 从源码运行

### 环境要求

- Windows 10 / 11 x64；
- Node.js + Corepack；
- pnpm `10.14.0`；
- Python `>= 3.12`；
- [uv](https://docs.astral.sh/uv/)。

安装依赖：

```powershell
corepack pnpm install
uv sync --project services/runtime
```

复制并配置环境变量：

```powershell
Copy-Item .env.example .env
Copy-Item apps\extension\.env.example apps\extension\.env
Copy-Item apps\task-center\.env.example apps\task-center\.env
```

基础检查：

```powershell
uv run --project services/runtime python -m compileall services/runtime/src
corepack pnpm typecheck
corepack pnpm --filter @xunlei-zhiqu/extension build
corepack pnpm --filter @xunlei-zhiqu/task-center build
```

启动 Runtime：

```powershell
uv run --project services/runtime uvicorn xunlei_zhiqu_runtime.main:app `
  --app-dir services/runtime/src `
  --host 127.0.0.1 `
  --port 8765
```

启动 Task Center 开发服务器：

```powershell
corepack pnpm --filter @xunlei-zhiqu/task-center dev
```

构建浏览器扩展：

```powershell
corepack pnpm --filter @xunlei-zhiqu/extension build
```

## 构建 Windows Release

Windows Release 通过统一脚本生成：

```powershell
.\scripts\build-release.ps1
```

脚本会依次完成 Runtime compile check、workspace typecheck、Task Center build、Extension build、PyInstaller onedir、Portable ZIP、Inno Setup Installer 和 SHA256 文件生成。

最终产物位于：

```text
artifacts/release/
├─ XunleiZhiqu-Setup-x64.exe
├─ XunleiZhiqu-Portable-x64.zip
├─ XunleiZhiqu-Extension.zip
└─ SHA256SUMS.txt
```

如果需要构建一个显式包含本机模型配置的有限分发版本，可以使用：

```powershell
.\scripts\build-release.ps1 -EmbedLocalModelConfig
```

该模式会把根目录 `.env` 中的模型 Provider、Endpoint、Model 和 API Key 写入本地生成的 Release Artifact。**任何拿到 Artifact 的人都可能提取该凭证，因此只应使用可随时吊销、有限额度、专用于分发的 Key，并在分发结束后立即轮换或吊销。**

更推荐的公开分发方式是使用独立 AI Gateway：

```powershell
.\scripts\build-release.ps1 `
  -GatewayBaseUrl "https://your-gateway.example/v1" `
  -GatewayModel "deepseek-v4-flash" `
  -GatewayToken "client-token"
```

## 项目结构

```text
apps/
├─ extension/       Chrome / Edge Manifest V3 扩展
└─ task-center/     React 下载任务中心

services/
└─ runtime/         FastAPI 本地 Runtime

packages/
└─ contracts/       三端共享类型与协议

release/windows/    PyInstaller / Inno Setup 配置
scripts/            构建与发布脚本
docs/               架构、验收与设计文档
```

## 反馈

如果遇到无法识别的真实下载页、来源恢复失败、错误的资源推荐或其他可复现问题，请在 GitHub Issues 中提供页面类型、操作步骤和必要的脱敏日志。不要提交 API Key、Cookie、Authorization Header、signed URL 或其他访问凭证。
