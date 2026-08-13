from __future__ import annotations

from dataclasses import dataclass
import re
import time

import httpx


_SERVER_TIMING_DUR_RE = re.compile(r"(?:^|[,;\s])dur=([0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class HttpTimingBreakdown:
    http_total_ms: int
    dispatch_ms: int
    tcp_connect_ms: int
    tls_handshake_ms: int
    request_headers_ms: int
    request_body_ms: int
    upstream_wait_ms: int
    response_body_ms: int
    response_close_ms: int
    transport_unattributed_ms: int
    provider_reported_ms: int | None
    server_timing: str | None
    connection_reused: bool
    http_version: str
    response_bytes: int

    @property
    def client_transport_ms(self) -> int:
        return (
            self.dispatch_ms
            + self.tcp_connect_ms
            + self.tls_handshake_ms
            + self.request_headers_ms
            + self.request_body_ms
            + self.response_body_ms
            + self.response_close_ms
            + self.transport_unattributed_ms
        )


class HttpTraceRecorder:
    """Collect low-level httpcore timing events for a single HTTPX request.

    `upstream_wait_ms` is the wait from entering receive-response-headers until
    response headers arrive. It contains WAN RTT + provider gateway/queue/model
    time. Unless the provider returns Server-Timing, a client cannot truthfully
    split those remote components further.
    """

    def __init__(self) -> None:
        self.started_at = time.perf_counter()
        self._starts: dict[str, float] = {}
        self._durations: dict[str, int] = {}
        self._first_event_at: float | None = None

    async def __call__(self, event_name: str, info: dict[str, object]) -> None:
        del info
        now = time.perf_counter()
        if self._first_event_at is None:
            self._first_event_at = now

        if event_name.endswith(".started"):
            phase = event_name[: -len(".started")]
            self._starts[phase] = now
            return

        if event_name.endswith(".complete") or event_name.endswith(".failed"):
            suffix = ".complete" if event_name.endswith(".complete") else ".failed"
            phase = event_name[: -len(suffix)]
            started = self._starts.get(phase)
            if started is not None:
                duration = max(0, int((now - started) * 1000))
                # Proxy CONNECT/TLS flows may repeat the same httpcore phase. Sum
                # them instead of silently keeping only the final occurrence.
                self._durations[phase] = self._durations.get(phase, 0) + duration

    def finish(self, response: httpx.Response, *, http_total_ms: int) -> HttpTimingBreakdown:
        dispatch_ms = 0
        if self._first_event_at is not None:
            dispatch_ms = max(0, int((self._first_event_at - self.started_at) * 1000))

        tcp_ms = self._duration("connection.connect_tcp")
        tls_ms = self._duration("connection.start_tls")
        request_headers_ms = self._duration_any(
            "http11.send_request_headers",
            "http2.send_request_headers",
        )
        request_body_ms = self._duration_any(
            "http11.send_request_body",
            "http2.send_request_body",
        )
        upstream_wait_ms = self._duration_any(
            "http11.receive_response_headers",
            "http11.receive_response",
            "http2.receive_response_headers",
        )
        response_body_ms = self._duration_any(
            "http11.receive_response_body",
            "http2.receive_response_body",
        )
        response_close_ms = self._duration_any(
            "http11.response_closed",
            "http2.response_closed",
        )

        known = (
            dispatch_ms
            + tcp_ms
            + tls_ms
            + request_headers_ms
            + request_body_ms
            + upstream_wait_ms
            + response_body_ms
            + response_close_ms
        )
        unattributed_ms = max(0, http_total_ms - known)
        server_timing = response.headers.get("server-timing")
        provider_reported_ms = _single_server_timing_ms(server_timing)
        response_bytes = len(response.content)
        http_version = response.http_version or "unknown"
        connection_reused = tcp_ms == 0 and tls_ms == 0

        return HttpTimingBreakdown(
            http_total_ms=http_total_ms,
            dispatch_ms=dispatch_ms,
            tcp_connect_ms=tcp_ms,
            tls_handshake_ms=tls_ms,
            request_headers_ms=request_headers_ms,
            request_body_ms=request_body_ms,
            upstream_wait_ms=upstream_wait_ms,
            response_body_ms=response_body_ms,
            response_close_ms=response_close_ms,
            transport_unattributed_ms=unattributed_ms,
            provider_reported_ms=provider_reported_ms,
            server_timing=server_timing,
            connection_reused=connection_reused,
            http_version=http_version,
            response_bytes=response_bytes,
        )

    def _duration(self, phase: str) -> int:
        return self._durations.get(phase, 0)

    def _duration_any(self, *phases: str) -> int:
        return sum(self._durations.get(phase, 0) for phase in phases)


def _single_server_timing_ms(value: str | None) -> int | None:
    if not value:
        return None
    durations = [float(match) for match in _SERVER_TIMING_DUR_RE.findall(value)]
    # Multiple Server-Timing metrics may overlap. Do not add them and pretend the
    # total is model compute. Preserve the raw header instead.
    if len(durations) != 1:
        return None
    return int(durations[0])
