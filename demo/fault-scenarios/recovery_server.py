#!/usr/bin/env python3
"""Controlled Stage F source-failure demo server.

Source A and B expose identical bytes under different URLs and support Range.
Source C has the same length and a similar label but different bytes.
"""
from __future__ import annotations
import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socket
import threading
import time
from urllib.parse import parse_qs, urlsplit

_BLOCK_SIZE = 64 * 1024
_LOCK = threading.Lock()
_SOURCE_A_STATE = "healthy"
_CONTENT_SIZE = 48 * 1024 * 1024
_CHUNK_DELAY = 0.012


def source_bytes(start: int, length: int, *, variant: str) -> bytes:
    salt = 17 if variant == "good" else 93
    return bytes(((start + index) * 31 + salt) & 0xFF for index in range(length))


def source_a_state() -> str:
    with _LOCK:
        return _SOURCE_A_STATE


def set_source_a_state(value: str) -> None:
    global _SOURCE_A_STATE
    with _LOCK:
        _SOURCE_A_STATE = value


class Handler(BaseHTTPRequestHandler):
    server_version = "XunleiZhiquFaultDemo/1.0"
    def do_HEAD(self) -> None: self._serve(head_only=True)
    def do_GET(self) -> None: self._serve(head_only=False)
    def log_message(self, fmt: str, *args: object) -> None: print(f"[fault-demo] {self.address_string()} {fmt % args}")

    def _serve(self, *, head_only: bool) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/control":
            value = parse_qs(parsed.query).get("source_a", [""])[0]
            if value not in {"healthy", "gone"}:
                self.send_error(HTTPStatus.BAD_REQUEST, "source_a must be healthy or gone"); return
            set_source_a_state(value)
            body = f"Source A = {value}\n".encode()
            self.send_response(HTTPStatus.OK); self.send_header("Content-Type", "text/plain; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            if not head_only: self.wfile.write(body)
            return
        if parsed.path in {"/", "/resource"}:
            body = self._page().encode("utf-8")
            self.send_response(HTTPStatus.OK); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            if not head_only: self.wfile.write(body)
            return
        if parsed.path == "/source-a/jdk-21.0.11-windows-x64-installer.exe":
            if source_a_state() == "gone": self.send_error(HTTPStatus.GONE, "Source A has been permanently removed"); return
            self._serve_file(head_only=head_only, variant="good", source="a"); return
        if parsed.path == "/source-b/jdk-21.0.11-windows-x64-installer.exe": self._serve_file(head_only=head_only, variant="good", source="b"); return
        if parsed.path == "/source-c/jdk-21.0.11-windows-x64-installer.exe": self._serve_file(head_only=head_only, variant="wrong", source="c"); return
        self.send_error(HTTPStatus.NOT_FOUND)

    def _page(self) -> str:
        if source_a_state() == "healthy":
            links = '<a href="/source-a/jdk-21.0.11-windows-x64-installer.exe">JDK 21.0.11 Windows x64 installer</a>'
            note = "Source A 正常。先用迅雷智取创建任务并下载到 30%~50%。"
        else:
            links = '<a href="/source-b/jdk-21.0.11-windows-x64-installer.exe">JDK 21.0.11 Windows x64 installer · Mirror B</a><a href="/source-c/jdk-21.0.11-windows-x64-installer.exe">JDK 21.0.11 Windows x64 installer · Mirror C</a>'
            note = "Source A 已永久失效。B 内容相同；C 名称和大小相同但字节不同。"
        return f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Stage F Recovery Demo · JDK 21.0.11</title><style>body{{font:16px system-ui;max-width:760px;margin:48px auto;padding:0 24px}}a{{display:block;margin:18px 0;padding:14px;border:1px solid #ccd;border-radius:10px}}</style><h1>Java SE Development Kit 21.0.11</h1><p>Windows x64 · installer · {_CONTENT_SIZE} bytes</p><p>{note}</p>{links}</html>'

    def _serve_file(self, *, head_only: bool, variant: str, source: str) -> None:
        range_header = self.headers.get("Range")
        start, end = 0, _CONTENT_SIZE - 1; status = HTTPStatus.OK
        if range_header:
            parsed_range = parse_range(range_header, _CONTENT_SIZE)
            if parsed_range is None:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE); self.send_header("Content-Range", f"bytes */{_CONTENT_SIZE}"); self.end_headers(); return
            start, end = parsed_range; status = HTTPStatus.PARTIAL_CONTENT
        length = end - start + 1
        self.send_response(status); self.send_header("Accept-Ranges", "bytes"); self.send_header("Content-Type", "application/vnd.microsoft.portable-executable"); self.send_header("Content-Disposition", 'attachment; filename="jdk-21.0.11-windows-x64-installer.exe"'); self.send_header("Content-Length", str(length)); self.send_header("ETag", f'"stage-f-{source}-{variant}-v1"'); self.send_header("Last-Modified", "Fri, 14 Aug 2026 00:00:00 GMT")
        if status == HTTPStatus.PARTIAL_CONTENT: self.send_header("Content-Range", f"bytes {start}-{end}/{_CONTENT_SIZE}")
        self.end_headers()
        if head_only: return
        position = start
        try:
            while position <= end:
                if source == "a" and source_a_state() == "gone":
                    try: self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
                    self.connection.close(); return
                amount = min(_BLOCK_SIZE, end - position + 1); self.wfile.write(source_bytes(position, amount, variant=variant)); self.wfile.flush(); position += amount
                if _CHUNK_DELAY: time.sleep(_CHUNK_DELAY)
        except (BrokenPipeError, ConnectionResetError): return


def parse_range(value: str, total: int) -> tuple[int, int] | None:
    if not value.startswith("bytes=") or "," in value: return None
    spec = value[6:].strip()
    if "-" not in spec: return None
    left, right = spec.split("-", 1)
    try:
        if not left:
            suffix = int(right)
            if suffix <= 0: return None
            return max(0, total - suffix), total - 1
        start = int(left); end = int(right) if right else total - 1
    except ValueError: return None
    if start < 0 or start >= total or end < start: return None
    return start, min(end, total - 1)


def main() -> None:
    global _CONTENT_SIZE, _CHUNK_DELAY
    parser = argparse.ArgumentParser(); parser.add_argument("--host", default="127.0.0.1"); parser.add_argument("--port", type=int, default=8877); parser.add_argument("--size-mb", type=int, default=48); parser.add_argument("--chunk-delay", type=float, default=0.012); args = parser.parse_args()
    _CONTENT_SIZE = max(1, args.size_mb) * 1024 * 1024; _CHUNK_DELAY = max(0.0, args.chunk_delay)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Stage F recovery page: http://{args.host}:{args.port}/resource"); print(f"Make Source A permanent-gone: http://{args.host}:{args.port}/control?source_a=gone"); print(f"Restore Source A: http://{args.host}:{args.port}/control?source_a=healthy"); server.serve_forever()

if __name__ == "__main__": main()
