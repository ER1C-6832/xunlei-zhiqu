from __future__ import annotations

import ctypes
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import socket
import sys
import threading
import time
from urllib.error import URLError
from urllib.request import Request, urlopen
import webbrowser

import uvicorn

from xunlei_zhiqu_runtime import __version__


HOST = "127.0.0.1"
PORT = 8765
HEALTH_URL = f"http://{HOST}:{PORT}/v1/health"
TASK_CENTER_URL = f"http://{HOST}:{PORT}/app/"


def _user_state_dir() -> Path:
    return Path.home() / ".xunlei-zhiqu"


def _log_path() -> Path:
    return _user_state_dir() / "logs" / "runtime.log"


def _stabilize_packaged_working_directory() -> None:
    """Prevent a frozen build from accidentally consuming an unrelated cwd .env."""
    if not getattr(sys, "frozen", False):
        return
    os.chdir(Path(sys.executable).resolve().parent)


def _configure_logging() -> None:
    log_path = _log_path()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        log_path,
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()
    root.addHandler(handler)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.setLevel(logging.INFO)
        logger.handlers.clear()
        logger.addHandler(handler)
        logger.propagate = False


def _release_config_path() -> Path | None:
    explicit = os.getenv("XUNLEI_ZHIQU_RELEASE_CONFIG", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().with_name("release-config.json")
    return None


def _apply_release_defaults() -> None:
    # The packaged Runtime always stays on localhost. Environment/.env keeps its
    # existing role in source development, but cannot move a competition build
    # onto a LAN-facing address.
    if getattr(sys, "frozen", False):
        os.environ["RUNTIME_HOST"] = HOST
        os.environ["RUNTIME_PORT"] = str(PORT)

    path = _release_config_path()
    if path is None or not path.exists():
        return

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logging.getLogger(__name__).warning("release_config_invalid path=%s error=%s", path, exc)
        return

    base_url = str(payload.get("gateway_base_url") or "").strip().rstrip("/")
    model = str(payload.get("gateway_model") or "").strip()
    token = str(payload.get("gateway_token") or "").strip()
    profile = str(payload.get("node_a_profile") or "pipeline_v3").strip()

    if not base_url or not model:
        # Packaging without a Competition Gateway must still be installable and
        # usable for local task/download acceptance. Fail only semantic model
        # calls; never fall back to a supplier default or a fake fixture model.
        os.environ["MODEL_PROVIDER"] = "unavailable"
        os.environ["MODEL_NAME"] = "competition-gateway-unavailable"
        os.environ.pop("MODEL_API_KEY", None)
        logging.getLogger(__name__).warning("competition_gateway_not_configured ai_disabled=true")
        return

    # A frozen release is governed by release-config.json, not by inherited
    # developer/supplier environment variables on the machine that launches it.
    os.environ["MODEL_PROVIDER"] = "openai_compatible"
    os.environ["MODEL_BASE_URL"] = base_url
    os.environ["MODEL_NAME"] = model
    os.environ["NODE_A_PROFILE"] = profile
    if token:
        os.environ["MODEL_API_KEY"] = token
    else:
        os.environ.pop("MODEL_API_KEY", None)

    logging.getLogger(__name__).info(
        "competition_gateway_configured model=%s profile=%s token_present=%s",
        model,
        profile,
        bool(token),
    )


def _health_ready(timeout: float = 0.8) -> bool:
    request = Request(HEALTH_URL, headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read().decode("utf-8"))
            return (
                payload.get("status") == "ok"
                and payload.get("version") == __version__
                and isinstance(payload.get("provider"), str)
                and bool(payload.get("provider"))
            )
    except (OSError, URLError, ValueError):
        return False


def _wait_for_health(timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if _health_ready():
            return True
        time.sleep(0.2)
    return False


def _port_in_use() -> bool:
    try:
        with socket.create_connection((HOST, PORT), timeout=0.35):
            return True
    except OSError:
        return False


def _open_task_center() -> None:
    webbrowser.open(TASK_CENTER_URL, new=2)


def _show_error(message: str) -> None:
    logging.getLogger(__name__).error("launcher_error message=%s", message)
    if os.name == "nt":
        try:
            ctypes.windll.user32.MessageBoxW(None, message, "迅雷智取启动失败", 0x10)
            return
        except Exception:
            pass
    print(message, file=sys.stderr)


def _open_when_ready() -> None:
    if _wait_for_health(20.0):
        _open_task_center()
        return
    _show_error(f"迅雷智取 Runtime 启动超时。\n\n日志：{_log_path()}")


def main() -> int:
    try:
        _stabilize_packaged_working_directory()
    except OSError as exc:
        _show_error(f"迅雷智取无法进入安装目录。\n\n{exc}")
        return 2

    _configure_logging()
    _apply_release_defaults()
    logger = logging.getLogger(__name__)

    if _health_ready():
        logger.info("existing_runtime_detected")
        _open_task_center()
        return 0

    if _port_in_use():
        # A concurrently launched copy may still be completing startup.
        if _wait_for_health(2.5):
            logger.info("concurrent_runtime_detected")
            _open_task_center()
            return 0
        _show_error(
            "端口 8765 已被其他程序占用。\n\n"
            f"请关闭占用该端口的程序后重试。\n日志：{_log_path()}"
        )
        return 2

    ready_opener = threading.Thread(
        target=_open_when_ready,
        name="zhiqu-open-task-center",
        daemon=True,
    )
    ready_opener.start()

    config = uvicorn.Config(
        "xunlei_zhiqu_runtime.main:app",
        host=HOST,
        port=PORT,
        log_config=None,
        access_log=True,
        server_header=False,
    )
    server = uvicorn.Server(config)
    try:
        server.run()
    except SystemExit:
        # A near-simultaneous launcher can win the bind race. If it became a
        # healthy 迅雷智取 Runtime, treat this copy as the secondary launcher.
        if _wait_for_health(2.5):
            _open_task_center()
            return 0
        _show_error(
            "迅雷智取无法启动本地 Runtime。\n\n"
            f"请查看日志：{_log_path()}"
        )
        return 2
    except Exception:
        logger.exception("runtime_launcher_failed")
        _show_error(
            "迅雷智取启动失败。\n\n"
            f"请查看日志：{_log_path()}"
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
