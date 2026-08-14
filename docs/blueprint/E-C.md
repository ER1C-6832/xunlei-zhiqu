# Stage E / Wave C — Stable Resume, Persistence & Preflight

Stage E-C turned `.part` into durable local execution state. It did not introduce Node B or cross-source switching; those responsibilities belong to Stage F.

## Completion status

**Stage E / Wave C is complete and human accepted. Stage E is complete.**

The verified real chain was:

```text
JDK real download
→ .part has real bytes
→ Runtime process killed
→ Runtime restarted
→ original ResourceJob restored
→ original .part and original path retained
→ HTTP Range starts at filesystem .part size
→ 206 + matching Content-Range
→ old .part keeps growing
→ final file completes
```

The real run did not reset progress to 0, did not create a duplicate `(1)` filename, and did not delete the retained `.part` during restart recovery.

## Frozen Stage E semantics

- Same-source resume uses `Source A -> Source A`.
- Resume offset is the actual persisted `.part` file size, never only the last database progress value.
- Resume sends `Range: bytes=<offset>-` and, when available, `If-Range` with a strong ETag; `Last-Modified` is the fallback validator. Weak ETags are not treated as strong identity.
- Append is permitted only after `206 Partial Content` with `Content-Range` starting at the requested offset. Known total size and validators must remain compatible.
- A Range request answered with `200 OK` never appends to the existing `.part`.
- `416` may promote `.part` to the final file only when the local part size already equals the confirmed total and validators do not show a remote change.
- Range mismatch, validator change, or known-total change never corrupts the retained `.part`.

## Pause / restart semantics

Pause closes the active transfer/response and retains `.part`; resume always opens a new HTTP request and does not depend on an old TCP connection.

Runtime startup loads persisted jobs without automatically starting network traffic:

- persisted `paused` remains `paused`;
- persisted `queued/downloading` becomes public `interrupted`, with `next_action=resume` when recoverable;
- persisted `failed` remains `interrupted` and exposes resume only when the failure is safe to retry from the retained `.part`;
- persisted `completed` remains completed when its final file still exists;
- completed assets in a multi-asset job are skipped, while incomplete assets reuse their original `final_path` / `part_path`.

## Local persistence

`DownloadStateStore` uses Python stdlib `sqlite3` and a single `jobs` table containing JSON job state. It keeps local-only ResourceJob state, private ResourceJob/manual creation context, CaptureBatch/ResourcePlan/confirmed selection when present, ExecutionRequest/ExecutionAsset facts, source URLs, destination paths, validators, progress metadata, and linked history state.

Default database: `~/.xunlei-zhiqu/runtime.db`. Override with `RUNTIME_STATE_DB`. Runtime database files are ignored by Git.

Progress writes are throttled during streaming and forced on lifecycle transitions. The database preserves task/context metadata; disk `.part` size remains the authoritative resume offset after a crash.

## Lightweight preflight

Normal checks stay silent. Blocking conditions surface actionable messages such as `磁盘空间不足`, `保存位置不可用`, `服务器未找到文件`, or a direct-file/manifest limitation.

The executor checks HTTP/HTTPS source support, writable destination creation, optional HEAD hints, actual GET reachability, known Content-Length, remaining disk space, basic filename safety, HTML-vs-file response shape, and continues to reject M3U8/MPD execution. HEAD failure does not block a real GET.

## Stage F boundary

Stage F now owns deterministic diagnosis, browser reacquisition, Node B semantic matching, deterministic cross-source verification, trusted source replacement, and `Source A -> Source B` continuation.

Stage E remains responsible for ordinary interruption, user Pause, Runtime restart, and same-source Range resume. The invariant remains:

```text
interrupted != waiting_for_source
```
