from __future__ import annotations

import ctypes
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import socket
import subprocess
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


def _disable_ai(reason: str) -> None:
    os.environ["MODEL_PROVIDER"] = "unavailable"
    os.environ["MODEL_NAME"] = "competition-ai-unavailable"
    os.environ.pop("MODEL_API_KEY", None)
    logging.getLogger(__name__).warning("competition_ai_unavailable reason=%s", reason)


def _apply_release_defaults() -> None:
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
        _disable_ai("release_config_invalid")
        return

    ai_mode = str(payload.get("ai_mode") or "").strip().lower()
    profile = str(payload.get("node_a_profile") or "pipeline_v3").strip()

    if ai_mode == "embedded_supplier":
        provider = str(payload.get("model_provider") or "").strip().lower()
        base_url = str(payload.get("model_base_url") or "").strip().rstrip("/")
        model = str(payload.get("model_name") or "").strip()
        api_key = str(payload.get("model_api_key") or "").strip()
        if (
            provider not in {"openai", "dashscope", "openai_compatible"}
            or not base_url.startswith("https://")
            or not model
            or not api_key
        ):
            _disable_ai("embedded_supplier_config_invalid")
            return

        os.environ["MODEL_PROVIDER"] = provider
        os.environ["MODEL_BASE_URL"] = base_url
        os.environ["MODEL_NAME"] = model
        os.environ["MODEL_API_KEY"] = api_key
        os.environ["NODE_A_PROFILE"] = profile
        logging.getLogger(__name__).warning(
            "embedded_supplier_credential_active provider=%s model=%s profile=%s",
            provider,
            model,
            profile,
        )
        return

    base_url = str(payload.get("gateway_base_url") or "").strip().rstrip("/")
    model = str(payload.get("gateway_model") or "").strip()
    token = str(payload.get("gateway_token") or "").strip()

    if not base_url or not model:
        _disable_ai("competition_gateway_not_configured")
        return

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


def _show_message(title: str, message: str, flags: int) -> None:
    if os.name == "nt":
        try:
            ctypes.windll.user32.MessageBoxW(None, message, title, flags)
            return
        except Exception:
            pass
    print(f"{title}: {message}", file=sys.stderr)


def _show_error(message: str) -> None:
    logging.getLogger(__name__).error("launcher_error message=%s", message)
    _show_message("迅雷智取启动失败", message, 0x10)


def _show_info(title: str, message: str) -> None:
    _show_message(title, message, 0x40)


def _open_when_ready() -> None:
    if _wait_for_health(20.0):
        _open_task_center()
        return
    _show_error(f"迅雷智取 Runtime 启动超时。\n\n日志：{_log_path()}")


def _extension_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "browser-extension"
    return Path(__file__).resolve().parents[4] / "apps" / "extension" / "dist"


def _browser_candidates(browser: str) -> list[Path]:
    local_app_data = os.getenv("LOCALAPPDATA", "")
    program_files = os.getenv("ProgramFiles", "")
    program_files_x86 = os.getenv("ProgramFiles(x86)", "")
    roots = [Path(value) for value in (local_app_data, program_files, program_files_x86) if value]
    if browser == "chrome":
        suffix = Path("Google") / "Chrome" / "Application" / "chrome.exe"
    else:
        suffix = Path("Microsoft") / "Edge" / "Application" / "msedge.exe"
    return [root / suffix for root in roots]


def _find_browser_executable(browser: str) -> Path | None:
    return next((path for path in _browser_candidates(browser) if path.exists()), None)


def _preferred_browser() -> str:
    if os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice",
            ) as key:
                prog_id = str(winreg.QueryValueEx(key, "ProgId")[0]).lower()
                if "chromehtml" in prog_id:
                    return "chrome"
                if "msedgehtm" in prog_id:
                    return "edge"
        except OSError:
            pass

    if _find_browser_executable("chrome") is not None:
        return "chrome"
    if _find_browser_executable("edge") is not None:
        return "edge"
    return "chrome"


def _copy_extension_path_to_clipboard(path: Path) -> None:
    if os.name != "nt":
        return
    try:
        subprocess.run(
            ["clip.exe"],
            input=str(path),
            text=True,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError:
        return


def _open_extension_install_helper(browser: str) -> int:
    if browser == "auto":
        browser = _preferred_browser()
    if browser not in {"chrome", "edge"}:
        _show_error("未知浏览器类型；扩展安装助手仅支持 Chrome / Edge。")
        return 2

    extension_dir = _extension_dir()
    if not (extension_dir / "manifest.json").exists():
        _show_error(f"没有找到浏览器扩展文件。\n\n目录：{extension_dir}")
        return 2

    browser_exe = _find_browser_executable(browser)
    browser_url = "chrome://extensions/" if browser == "chrome" else "edge://extensions/"
    browser_name = "Chrome" if browser == "chrome" else "Edge"

    try:
        subprocess.Popen(["explorer.exe", str(extension_dir)])
    except OSError:
        pass
    _copy_extension_path_to_clipboard(extension_dir)

    if browser_exe is not None:
        try:
            subprocess.Popen([str(browser_exe), browser_url])
        except OSError:
            browser_exe = None

    if browser_exe is None:
        _show_info(
            "迅雷智取浏览器扩展",
            f"扩展已经随迅雷智取安装到：\n{extension_dir}\n\n"
            f"没有自动找到 {browser_name}。请手动打开 {browser_url}，开启开发者模式，"
            "点击“加载已解压的扩展程序”，选择上面的目录。\n\n扩展目录路径已复制到剪贴板。",
        )
        return 0

    _show_info(
        "迅雷智取浏览器扩展",
        f"已经打开 {browser_name} 扩展管理页和迅雷智取扩展目录。\n\n"
        "浏览器安全策略不允许普通安装器静默加载未上架扩展，因此还需要你确认一次：\n"
        "1. 开启“开发者模式”\n"
        "2. 点击“加载已解压的扩展程序”\n"
        f"3. 选择：{extension_dir}\n\n扩展目录路径已复制到剪贴板。",
    )
    return 0


def _handle_command_line() -> int | None:
    if len(sys.argv) < 2:
        return None
    if sys.argv[1] != "--install-extension":
        return None
    browser = sys.argv[2].strip().lower() if len(sys.argv) >= 3 else "auto"
    return _open_extension_install_helper(browser)


def main() -> int:
    try:
        _stabilize_packaged_working_directory()
    except OSError as exc:
        _show_error(f"迅雷智取无法进入安装目录。\n\n{exc}")
        return 2

    _configure_logging()
    command_result = _handle_command_line()
    if command_result is not None:
        return command_result

    _apply_release_defaults()
    logger = logging.getLogger(__name__)

    if _health_ready():
        logger.info("existing_runtime_detected")
        _open_task_center()
        return 0

    if _port_in_use():
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
