# Competition Release：嵌入本地模型配置

比赛短期交付如果暂时没有 Competition Gateway，可以显式选择把开发机根目录 `.env` 中现有的模型配置写入本地生成的 Release：

```powershell
.\scripts\build-release.ps1 -EmbedLocalModelConfig
```

该开关是显式 opt-in；默认构建仍不会打包开发者供应商凭据。

构建脚本会读取：

- `MODEL_PROVIDER`
- `MODEL_BASE_URL`
- `MODEL_NAME`
- `MODEL_API_KEY`
- `NODE_A_PROFILE`

支持的 Provider 仍然是现有 Runtime Provider：`openai`、`dashscope`、`openai_compatible`。不会创建第二套 Provider/Gateway。

## 风险边界

嵌入后的 API Key 会存在于本地生成的 `release-config.json`，因此能拿到安装包或 Portable 的人原则上可以提取该 Key。这个模式只适合短期比赛、限额/可撤销凭据，不适合作为长期公开发行方案。

Key 不会提交到 GitHub，也不会进入浏览器 Extension / Task Center 前端 bundle。正式公开发行仍推荐 Competition Gateway + 可撤销客户端 token。
