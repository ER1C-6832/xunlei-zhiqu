# ADR 0002: Client Runtime, cloud analysis, and service ports

Status: accepted for Stage E0

## Context

Stage D proved the current Demo path:

```text
Browser Extension -> localhost FastAPI Runtime -> Task Center
```

The production product must later move the long-lived Agent into the 迅雷 client without rewriting Node A, ResourceJob orchestration or frontend product logic. At the same time, a user without the client may still be allowed to obtain a Node-A ResourcePlan through a cloud analysis service.

A naive migration would couple UI code to endpoint discovery, upload the existing `CaptureBatch` to a cloud Runtime, or bind the Runtime directly to one model supplier and one download implementation. Stage E0 freezes replacement seams before real file execution begins.

## Decision

### Full Agent lives in the client Runtime

The long-term owner of ResourceJob state is the 迅雷 client Runtime:

```text
Extension
  -> ZhiquServiceClient
     -> Client Runtime
        -> ResourceDeliveryAgent / ResourceJob
        -> ModelGatewayPort
        -> DownloadExecutorPort
```

The current FastAPI process is the Demo deployment of that Runtime. Runtime hosting the Task Center static bundle remains a convenience, not a logical dependency.

### Cloud fallback is analysis only

No-client fallback is:

```text
Extension -> CloudAnalysisTransport -> Cloud Analysis Service -> AI Gateway
```

It returns a validated Node-A `ResourcePlan`. It does not own a second copy of the local ResourceJob state machine, disk state, download progress, pause/resume state, recovery state or Download Engine.

`CaptureBatch` is therefore **not** the cloud request contract. The explicit `CloudAnalysisRequest` contains only sanitized candidate semantics and safe technical facts. Raw resource URLs, page URLs, cookies, Authorization material, temporary tokens, local paths, full HTML and unrelated page text are excluded before a cloud transport can exist.

### Analysis eligibility is separate from deployment

`ZhiquCapabilities` describes what the current product shape can do. `AnalysisCredential` describes the logical right to use intelligent analysis. They are independent concepts.

A credential can eventually be backed by a client login session, web account session or guest trial token. Stage E0 only provides logical fixture kinds; the public analysis payload does not carry a model-provider API key or raw account token.

### Frontend service boundaries

Browser Extension product code depends on `ZhiquServiceClient`, not localhost or `/v1/*` routes. The current `LocalHttpTransport` owns Demo HTTP details.

Task Center product code depends on `TaskServiceClient` and public `ResourceJobSnapshot` / action semantics. The current `HttpTaskServiceClient` owns Runtime endpoint, routes and optional session header. A future client WebView bridge or native IPC implementation can replace this transport without changing the Task Center pages.

### Model boundary

`ModelGatewayPort` is the Runtime semantic boundary rather than a second parallel class hierarchy. The existing, already-used `ModelProviderAdapter` is the current implementation of that semantic port; the provider-neutral stack from ADR 0001 remains intact.

Production can later add an `XunleiGatewayProviderAdapter` without making CaptureAnalyzer branch on Qwen, DeepSeek, OpenAI or any supplier hostname.

### Model Gateway proximity principle

A future 迅雷 AI Gateway should be placed and routed with model-provider proximity in mind. The intended production path is:

```text
Client Runtime
  -> 迅雷 AI Gateway
     -> regional/provider egress
        -> model supplier
```

The Gateway is the right place for account identity and entitlement, quota/rate limiting, model routing and fallback, shared prompt/cache policy, prompt-version control and cost/latency telemetry. When possible, its provider-facing egress should be regionally close to the selected model supplier so the Gateway does not add an avoidable second long WAN leg.

This does **not** imply that a Gateway can remove the user's Client -> Gateway WAN latency, nor that client-observed TTFT can be labeled as pure model compute. Stage E0 only records the deployment principle; it does not implement a cloud Gateway.

### Download boundary

ResourceJob execution calls `DownloadExecutorPort`:

```text
create / pause / resume / cancel / status / add_source
```

`create` receives a Runtime-internal `DownloadExecutionRequest` containing the public job snapshot plus the confirmed source values needed by a real executor. Those raw sources never become fields on `ResourceJobSnapshot` and never cross the cloud-analysis privacy boundary.

Stage E0 wires a `NoopDownloadExecutor` so current Demo behavior remains unchanged. Stage E can replace it with a real Demo HTTP executor, and a production client can replace that with `XunleiDownloadExecutor`, without moving execution logic into the Agent or UI.

### Runtime client-session seam

Before Stage E writes real files, Runtime HTTP clients need one place to attach client authentication. The shared seam is `X-Zhiqu-Session`.

Current modes are intentionally small:

- `off`: default Demo behavior;
- `static_token`: development verification of the authenticated localhost seam.

The Extension transport and Task Center HTTP client can attach the header uniformly. Runtime validates it through `ClientSessionAuthPort`. This is not OAuth and is not a production account service.

`VITE_RUNTIME_SESSION` exists only as a development fixture for the static-token mode. A production session must be provisioned dynamically by the client/native bridge or authenticated localhost handshake; it must not become a permanent build-time secret in frontend bundles.

A future client may establish the session through Chrome Native Messaging or authenticated localhost IPC. This ADR deliberately does not choose between those transports yet.

## Consequences

- Moving the full Agent into the 迅雷 client is primarily a deployment/adapter change, not a rewrite of product logic.
- Cloud analysis cannot accidentally inherit the privacy properties of local `CaptureBatch`; it must cross an explicit sanitizer contract.
- Task Center no longer assumes it is talking directly to localhost HTTP from page components.
- Node A model suppliers and the future 迅雷 AI Gateway remain behind one Runtime semantic port.
- A production AI Gateway can centralize identity/routing/cache/cost policy without forcing supplier logic back into Runtime; regional provider egress should be benchmarked rather than assumed.
- Real download execution can begin in Stage E behind a frozen port while keeping raw sources Runtime-internal.
- Client-session authentication can be enabled without editing every React request call.

## Deliberately deferred

- real Chrome Native Messaging;
- real 迅雷 account login, OAuth, membership or entitlement service;
- real Cloud Analysis endpoint and AI Gateway;
- a second full cloud Runtime;
- real HTTP/BT/Magnet download execution, Range and persistence;
- Node B and complete reacquisition;
- microservices, Redis, Kafka or distributed queues.
