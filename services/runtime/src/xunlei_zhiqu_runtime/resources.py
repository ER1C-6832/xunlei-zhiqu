from __future__ import annotations

from pathlib import Path
import sys


def runtime_resource_path(*parts: str) -> Path:
    """Resolve packaged resources without leaking PyInstaller checks into business code."""
    if getattr(sys, "frozen", False):
        bundle_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
        return bundle_root.joinpath(*parts)
    project_root = Path(__file__).resolve().parents[4]
    return project_root.joinpath(*parts)


def task_center_dist_path() -> Path:
    if getattr(sys, "frozen", False):
        return runtime_resource_path("task-center")
    return runtime_resource_path("apps", "task-center", "dist")
