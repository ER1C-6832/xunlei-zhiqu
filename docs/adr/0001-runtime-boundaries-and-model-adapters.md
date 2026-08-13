# ADR 0001: Runtime boundaries and model-provider adapters

Status: accepted for the current prototype

## Context

The product keeps the three frozen layers from the blueprint:

1. Browser Extension (Lens): capture, local discovery, explicit user actions and lightweight confirmation UI.
2. Runtime: EvidencePack compilation, Node A orchestration, deterministic validation, task state and execution boundary.
3. Task Center: consumes Runtime job/library APIs and presents user-visible state; it does not decide resources or call models.

The Demo may serve Task Center static assets from Runtime, but static hosting is a deployment convenience rather than an application dependency.

The previous Node-A implementation mixed three independent concerns in one factory/provider path:

- our prompt/transport A/B profile (`quality`, `wire2`, `pipeline`);
- OpenAI-compatible HTTP transport;
- supplier/model quirks such as DashScope `enable_thinking`.

This made model/provider swaps look like Runtime behavior changes and made HTTP latency hard to attribute.

## Decision

### Product-layer boundary

```text
Browser Extension -- HTTP /v1 contracts --> Runtime <-- HTTP /v1 contracts -- Task Center
```

Neither frontend imports Runtime implementation code or holds model credentials. Both depend only on the versioned HTTP/data contracts in `packages/contracts` / FastAPI schemas.

Runtime origin is deployment configuration:

- Task Center: `VITE_RUNTIME_URL`, with production same-origin fallback.
- Extension: `VITE_RUNTIME_URL` at build time; local default stays `http://127.0.0.1:8765`.
- Runtime CORS origins: `RUNTIME_CORS_ORIGINS`.

The Extension manifest already permits HTTP/HTTPS hosts, so moving the Runtime endpoint does not require moving model credentials into the extension.

### Model boundary

```text
CaptureAnalyzer
  -> ModelProviderAdapter              # sanitized EvidencePack -> ResourcePlan
     -> EvidenceWireProvider           # optional Runtime-owned lossless compaction
        -> StructuredChatProvider      # generic OpenAI-compatible transport
           -> ProviderApiAdapter       # supplier/model dialect only
              -> OpenAIProviderAdapter
              -> DashScopeProviderAdapter
              -> GenericOpenAICompatibleAdapter
```

`NODE_A_PROFILE` is owned by our Node-A protocol. It cannot select a supplier or model.

`MODEL_PROVIDER`, `MODEL_BASE_URL` and `MODEL_NAME` select the API supplier/dialect and model independently.

Supplier-only request fields, response metadata and error parsing must stay inside `ProviderApiAdapter`. Analyzer and business services must never branch on `qwen`, `deepseek`, `aliyuncs.com`, or other supplier/model names.

Fixture remains a development-only `ModelProviderAdapter` implementation.

### HTTP latency attribution

The generic transport records these client-observable phases using HTTPX/HTTPCore trace events:

- dispatch / connection-pool wait before first transport event;
- TCP connect;
- TLS handshake;
- request headers;
- request body upload;
- wait for response headers (`upstream_wait_ms`);
- response body download;
- response close;
- unattributed transport remainder;
- JSON parsing, output normalization and ResourcePlan validation.

`upstream_wait_ms` is deliberately not called pure model time. From the client it contains WAN propagation plus provider gateway/queue/model processing until response headers arrive. If the provider supplies `Server-Timing`, its reported duration is logged separately.

This lets us distinguish:

```text
Runtime local work
+ client/network transport work
+ externally observable upstream wait
+ provider-reported server duration (when available)
```

without pretending that client code can infer hidden provider queue/model time.

## Consequences

- Swapping OpenAI/DashScope/another compatible supplier should not change Runtime orchestration.
- Swapping Qwen/DeepSeek should be a model configuration change unless the supplier adapter needs a model-specific wire quirk.
- `pipeline` remains an A/B profile of our protocol, not a supplier profile.
- The local Demo deployment is preserved.
- Moving Task Center or Runtime to another host becomes configuration work rather than a business-logic rewrite.

## Deliberately deferred

- A real cloud AI Gateway and model router.
- OpenAPI-generated TypeScript client code. Current TS contracts and Pydantic schemas are still maintained in parallel and should be generated later when API churn slows.
- Microservices, service discovery and distributed queues.
- Node B, download-engine work, SQLite and WebSocket work that belong to later stages.
