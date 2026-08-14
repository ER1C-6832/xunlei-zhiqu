from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import sqlite3
from threading import Lock
from typing import Any


class DownloadStateStore:
    """Thin local SQLite store for long-lived ResourceJob execution state.

    The database is intentionally one table + JSON. It owns local private URLs and
    acquisition context; none of this is a cloud-analysis contract.
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
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        updated_at = datetime.now(UTC).isoformat()
        with self._lock:
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
            try:
                value = json.loads(payload_json)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(value, dict):
                result.append(value)
        return result

    def count_jobs(self) -> int:
        with self._lock:
            row = self._connection.execute("SELECT COUNT(*) FROM jobs").fetchone()
        return int(row[0] if row else 0)

    def close(self) -> None:
        with self._lock:
            self._connection.close()
