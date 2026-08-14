from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import sqlite3
from threading import Lock
from typing import Any


class DownloadStateStore:
    """Thin local SQLite store for long-lived ResourceJob execution state.

    Stage F keeps recovery context/history inside the same per-job JSON document.
    `upsert_job` merges keys so the Stage E job-store writer cannot erase recovery
    facts that it does not know about.
    """

    def __init__(self, path: Path) -> None:
        self.path = path.expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._connection = sqlite3.connect(self.path, check_same_thread=False)
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=NORMAL")
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        self._connection.commit()

    def upsert_job(self, job_id: str, payload: dict[str, Any]) -> None:
        with self._lock:
            current = self._load_job_locked(job_id) or {}
            current.update(payload)
            self._write_job_locked(job_id, current)

    def patch_job(self, job_id: str, patch: dict[str, Any]) -> None:
        with self._lock:
            current = self._load_job_locked(job_id)
            if current is None:
                return
            current.update(patch)
            self._write_job_locked(job_id, current)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._load_job_locked(job_id)

    def delete_job(self, job_id: str) -> None:
        with self._lock:
            self._connection.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))
            self._connection.commit()

    def load_jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT payload_json FROM jobs ORDER BY updated_at DESC"
            ).fetchall()
        result: list[dict[str, Any]] = []
        for (payload_json,) in rows:
            value = _decode_payload(payload_json)
            if value is not None:
                result.append(value)
        return result

    def count_jobs(self) -> int:
        with self._lock:
            row = self._connection.execute("SELECT COUNT(*) FROM jobs").fetchone()
        return int(row[0] if row else 0)

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def _load_job_locked(self, job_id: str) -> dict[str, Any] | None:
        row = self._connection.execute(
            "SELECT payload_json FROM jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
        return _decode_payload(row[0]) if row else None

    def _write_job_locked(self, job_id: str, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        updated_at = datetime.now(UTC).isoformat()
        self._connection.execute(
            """
            INSERT INTO jobs(job_id, payload_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at
            """,
            (job_id, encoded, updated_at),
        )
        self._connection.commit()


def _decode_payload(payload_json: object) -> dict[str, Any] | None:
    try:
        value = json.loads(payload_json) if isinstance(payload_json, str) else None
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None
