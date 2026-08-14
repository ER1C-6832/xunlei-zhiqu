# Stage F 真人验收记录

> 日期：2026-08-14  
> 结论：**PASS / Stage F 完成**

本记录用于冻结 Stage F 的真人验收事实。验收不是 pytest、fixture 或纯脚本拼接测试，而是经过真实浏览器 Extension、真实 Runtime、真实模型 Node B、真实 HTTP Range、真实 `.part` 与真实 Source Switch 的完整产品链路。

## 验收场景

受控故障服务：`demo/fault-scenarios/recovery_server.py`

- Source A：初始可下载，随后永久失效并返回 HTTP 410；
- Source B：不同 URL，与 A 字节完全一致，支持 HTTP Range；
- Source C：名称、版本语义和总大小相似，但实际字节与 A/B 不同。

目标资源总大小：`268435456` bytes（256 MiB）。

## 真人验收事实

原任务：

```text
job_id=job_18aa058a5f
asset_id=asset_1
```

Source A 失效后，Runtime 真实诊断：

```text
failure_kind=http_error
http_status=410
action=reacquire_source
reason=source_unavailable
```

公开任务因此进入：

```text
waiting_for_source
→ 一键续取
```

Task Center 发起 `continue-acquisition` 后，浏览器 Recovery Mode 复用页面 Capture，真实 Node B 调用：

```text
model=deepseek-v4-flash
candidates=2
input_tokens=413
output_tokens=109
total_ms=2034
```

Runtime 随后做确定性来源验证：

Source B：

```text
result=verified
method=sample_match
samples=3
remote_total=268435456
```

Source C：

```text
result=mismatch
sample_offset=0
```

因此只有 Source B 获得 Source Switch 执行资格。

切换时磁盘真实 `.part` offset：

```text
105644032 bytes
```

Runtime 保持原 `job_id` / `asset_id` / `.part`，切换 Source A → Source B：

```text
source_switch
job_id=job_18aa058a5f
asset_id=asset_1
offset=105644032
verification=sample_match
```

Source B 随后的真实恢复请求满足 Stage E append 安全条件：

```text
response_status=206
content_range_start=105644032
remote_total=268435456
etag_match=True
range_resume=True
```

也就是说，没有从 0 重新下载，而是从原 `.part` 的磁盘实际 offset 继续。

## 最终文件完整性复核

跨来源完成文件 SHA256：

```text
F17D53B0A0D7968B33C22C7F941C8691C041BE00DD5889F5BE4998341927BE9D
```

单独完整下载 Source B 后的参考文件 SHA256：

```text
F17D53B0A0D7968B33C22C7F941C8691C041BE00DD5889F5BE4998341927BE9D
```

两者完全一致。

因此这次真人验收证明：

```text
Source A 真下载
→ A 永久 HTTP 410
→ deterministic Diagnosis
→ waiting_for_source
→ Task Center 一键续取
→ Browser Reacquisition
→ 真实 Node B
→ Source B 三段 sample_match
→ Source C mismatch 并拒绝
→ 原 ResourceJob / 原 .part / 原 offset Source Switch
→ Source B HTTP 206 Range resume
→ 100%
→ 最终 SHA256 与完整 Source B 一致
```

## Stage F 结论

Stage F 的核心产品定义已经通过真人链路验证：

- `interrupted != waiting_for_source`；
- Node B 只做语义候选判断，不拥有 append 决策权；
- Source Verification 是确定性执行门；
- 不一致来源不会污染旧 `.part`；
- 来源切换不创建第二个 ResourceJob；
- `.part` 的磁盘实际大小仍是 offset source of truth；
- Source Switch 后仍必须经过合法 `206 + Content-Range` 才 append；
- 完成后的跨来源文件与完整可信 Source B 字节一致。

**Stage F 正式标记为完成。**
