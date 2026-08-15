# Competition Release — Clean Machine Acceptance

> 当前状态：**等待真人 Windows clean-machine 验收。**
>
> 这份清单只验证“别人拿走安装包能不能直接工作”，不替代 Stage G 的真实公网资源覆盖，也不使用 localhost/fixture 宣布产品能力通过。

## 1. 验收机器

Windows 10 / 11 x64 真实机器或 VM。

验收开始前确认机器没有依赖当前开发环境：

- 不需要 Git；
- 不需要 Python；
- 不需要 Node.js；
- 不需要 pnpm；
- 不需要 uv；
- 没有当前源码仓库。

只提供：

```text
XunleiZhiqu-Setup-x64.exe
XunleiZhiqu-Extension.zip
SHA256SUMS.txt
```

如果浏览器扩展已经上架商店，可以用商店安装入口替代 Extension ZIP。

## 2. Artifact 完整性

记录：

```text
验收日期：
Windows 版本：
浏览器及版本：
测试人：
Setup SHA256：
Portable SHA256：
Extension SHA256：
```

用 `SHA256SUMS.txt` 对照三个 Release artifact。

## 3. 安装

1. 双击 `XunleiZhiqu-Setup-x64.exe`；
2. 不使用管理员权限完成 per-user 安装；
3. 默认安装目录应为 `%LOCALAPPDATA%\Programs\XunleiZhiqu`；
4. 开始菜单出现“迅雷智取”；
5. 安装结束页默认提供“启动迅雷智取”。

PASS：普通安装过程中不要求 Python、Node、pnpm、uv、Git 或源码目录。

## 4. 首次启动

从开始菜单启动迅雷智取。

期望：

```text
XunleiZhiqu.exe
→ 检查 127.0.0.1:8765/v1/health
→ 启动本地 Runtime
→ 等待 ready
→ 默认浏览器打开 http://127.0.0.1:8765/app/
```

确认：

- Task Center 正常显示，不依赖 Vite 开发服务器；
- `http://127.0.0.1:8765/v1/health` 返回正常；
- 普通启动没有 Python/Uvicorn 黑色 console；
- `~/.xunlei-zhiqu/logs/runtime.log` 可用于失败排查。

## 5. 重复启动

Runtime 已运行时连续再次启动“迅雷智取”两次。

PASS：

- 不出现 8765 端口占用错误；
- 不启动第二个 Runtime；
- 再次打开/聚焦 Task Center 即可。

如果 8765 被非迅雷智取程序占用，应该看到可理解的启动失败提示，而不是 Python traceback。

## 6. 浏览器扩展

商店尚未发布时：

1. 解压 `XunleiZhiqu-Extension.zip`；
2. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`；
3. 开启开发者模式；
4. 选择“加载已解压的扩展程序”；
5. 选择解压目录。

PASS：不需要下载源码或执行前端 build。

## 7. 真实公网下载

选择一个真实公网 HTTP / HTTPS 文件页面，不使用 localhost 页面。

必须真实走完：

```text
真实页面
→ Extension Capture
→ Node A
→ ResourcePlan
→ 用户确认
→ ResourceJob
→ 真实 HTTP 下载
→ Task Center 显示进度
→ 文件真实落盘
```

记录页面、文件名、最终大小和结果。

## 8. Pause / Resume

下载一个足够大的真实 HTTP / HTTPS 文件：

```text
下载中
→ Pause
→ .part 保留
→ Resume
→ 从已有进度继续
→ 完成
```

PASS：不是从 0 重下，最终文件可正常使用。

## 9. Runtime 重启恢复

下载进行中时关闭 Runtime，再从开始菜单重新启动迅雷智取。

PASS：

- 原 ResourceJob 仍在；
- 原 `.part` 仍在；
- 已有任务状态从 SQLite 恢复；
- 用户可以继续原任务。

## 10. 升级/卸载数据安全抽查

如果有两个安装包版本可用，直接覆盖安装新版。

PASS：

- `~/.xunlei-zhiqu/runtime.db` 保留；
- 已下载文件保留；
- `.part` 保留；
- 安装器只替换程序目录内容。

卸载后默认也不应删除用户 Downloads 或 `~/.xunlei-zhiqu`。

## 11. Release 内容安全检查

检查安装目录、Portable 解压目录和 Extension ZIP。

不得出现：

- 开发 `.env` / `*.env.local`；
- DashScope / OpenAI 等供应商 root API key；
- 开发机 SQLite / `.part` /真实下载记录；
- benchmark 输出；
- 开发机私有绝对路径；
- Extension 的 `src`、`node_modules`、tsconfig 等开发文件。

Competition Gateway 的专用可吊销客户端 token（若发布策略选择打入）不等同于供应商 root key，但仍需确认它确实是专用、有限额度的 Release 凭证。

## 12. 验收结论

只有全部必需项通过后填写：

```text
Clean Machine Acceptance: PASS
验收人：
日期：
Setup 实际大小：
Extension ZIP 实际大小：
备注：
```

在此之前，只能说“Release artifacts generated / 等待 clean-machine 真人验收”，不能说“Release verified”。
