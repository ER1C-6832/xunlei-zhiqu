# ADR 0002: Client Runtime, cloud analysis, and service ports

Status: accepted; Stage E-A execution seam implemented

## Context

Stage D/E0 proved and then decoupled the Demo path:

```text
Browser Extension -> Runtime -> Task Center
```

The long-lived Agent must remain movable into the 迅雷 client without rewriting Node A, ResourceJob orchestration or frontend product logic. A no-client cloud fallback may still provide Node-A analysis, but must not become a second owner of local disk/download state.

Stage E-A is the first point where that architecture performs real filesystem I/O, so the download boundary also needs a precise execution identity model.

## Decision

### Full Agent lives in the client Runtime

The long-term owner of ResourceJob and local execution state is the 迅雷 client Runtime:

```text
Extension
  -> ZhiquServiceClient
     -> Client Runtime
        -> ResourceJob / Agent
        -> ModelProviderAdapter
        -> DownloadExecutorPort
```

The current FastAPI process is the local Demo deployment of that Runtime. Runtime hosting the Task Center static bundle is a convenience, not a logical dependency.

### Cloud fallback is analysis only

No-client fallback remains:

```text
Extension -> CloudAnalysisTransport -> Cloud Analysis Service -> AI Gateway
```

It may return a validated Node-A `ResourcePlan`; it does not own local disk state, download progress, pause/resume, recovery state or a Download Engine.

`CaptureBatch` is not the cloud request contract. `CloudAnalysisRequest` excludes raw resource URLs, page URLs, cookies, Authorization material, temporary tokens, local paths, full HTML and unrelated page text before any cloud transport exists.

### Frontend service boundaries

Extension product code depends on `ZhiquServiceClient`; current HTTP details remain in `LocalHttpTransport`.

Task Center product code depends on `TaskServiceClient` and public `ResourceJobSnapshot`; current HTTP details remain in `HttpTaskServiceClient`. A future client WebView/native bridge can replace either transport without rewriting product pages.

### Model boundary

The existing `ModelProviderAdapter` is the Runtime's ModelGatewayPort semantic boundary. Provider dialects remain behind `ProviderApiAdapter`; Runtime orchestration does not branch on DeepSeek, Qwen, OpenAI or supplier hostnames.

A future 迅雷 AI Gateway may centralize identity, quota, routing, fallback, shared cache/prompt policy and cost/latency telemetry. Provider-facing egress should be benchmarked for regional proximity rather than assumed.

### Asset-aware download boundary

Stage E-A freezes this internal execution identity:

```text
ResourceJob
  -> DownloadExecutionRequest
     -> DownloadExecutionAsset[]
        -> primary_source
        -> alternate_sources[]
```

Semantics are:

- `ResourceJob` = the user's desired resource goal;
- `DownloadExecutionAsset` = one logical file that must be materialized;
- source = one address for that specific logical file.

The execution compiler is deterministic. Candidates become sources of one asset only when existing capture evidence proves identity, currently the same `normalized_key` or the same canonical URL. Multiple candidate IDs in one model `PlanItem` do **not** by themselves imply mirrors. Distinct identities become distinct assets and are downloaded sequentially.

Manual links are likewise separate assets unless their canonical URLs are identical.

Raw source values remain Runtime-internal. They are not added to public `ResourceJobSnapshot` and do not cross `CloudAnalysisRequest`.

### DownloadExecutorPort

The port is:

```text
create(request)
pause(job_id)
resume(job_id)
cancel(job_id)
status(job_id)
add_source(job_id, asset_id, source)
```

`add_source` is asset-aware so a future recovery controller can attach a newly discovered source to the correct logical file. Stage E-A stores alternate sources but deliberately does not auto-switch to them.

Current adapters:

- `HttpDownloadExecutor`: real Stage E-A local HTTP/HTTPS execution;
- `NoopDownloadExecutor`: fixture/fallback only;
- future `XunleiDownloadExecutor`: production client integration seam.

`HttpDownloadExecutor` is intentionally small: sequential files, streaming response body to `.part`, filename sanitization, duplicate-safe names, live bytes/speed/ETA, in-process cooperative pause/resume, real cancel, and atomic `.part -> final` on successful completion. It is not a reimplementation of the 迅雷 download engine.

Unsupported Stage E-A protocols include Magnet/BT, HLS/DASH orchestration, blob, FTP and external download engines. A local job with no executable HTTP/HTTPS asset fails clearly rather than entering fake progress.

### Execution status truth

For `execution_mode=download_engine`:

```text
JobStore = job metadata / user goal
DownloadExecutor = current execution truth
```

GET job APIs project executor status onto the existing public `ResourceJobSnapshot`. Real jobs never enter the old Demo progress advancement path.

Cloud Demo tasks and explicit `DOWNLOAD_EXECUTOR=noop` fixtures may continue using Demo behavior.

### Runtime shutdown and cancel are different

User cancel first cancels the background task/network response and deletes the current `.part`, then removes the ResourceJob.

Runtime shutdown cancels background work and closes HTTP connections but does **not** delete `.part`; restart recovery is deliberately deferred.

### Runtime client-session seam

`X-Zhiqu-Session` remains the common authenticated-localhost seam. Current `off` and `static_token` modes are development shapes, not production account infrastructure.

## Consequences

- Moving the full Agent into the 迅雷 client remains an adapter/deployment change rather than a product rewrite.
- Real local file execution now fits behind the same DownloadExecutorPort that production can replace.
- Execution identity no longer collapses an unordered list of URLs into ambiguous download semantics.
- Source recovery has a stable `asset_id` target without introducing Node B in Stage E-A.
- Public ResourceJob contracts remain unchanged while real bytes/speed/ETA come from the executor.
- Cloud analysis retains its privacy boundary and cloud Demo delivery is not accidentally routed to local disk.

## Deliberately deferred

- Native Messaging and production account/session infrastructure;
- real Cloud Analysis endpoint / AI Gateway;
- SQLite or other persistent Job Store;
- Runtime restart recovery and HTTP Range resume;
- full preflight / disk-space subsystem / full content verification;
- automatic alternate-source switching;
- Node B / Diagnosis Controller / one-click reacquisition;
- Magnet/BT, HLS/DASH orchestration, aria2/qBittorrent/P2P;
- multi-connection segmented downloads;
- WebSocket/download event bus.
