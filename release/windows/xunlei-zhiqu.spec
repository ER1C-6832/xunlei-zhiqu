from pathlib import Path
import os

from PyInstaller.utils.hooks import collect_submodules


spec_dir = Path(SPECPATH).resolve()
repo_root = spec_dir.parents[1]
runtime_src = repo_root / "services" / "runtime" / "src"
launcher = runtime_src / "xunlei_zhiqu_runtime" / "launcher.py"
task_center_dist = repo_root / "apps" / "task-center" / "dist"
version_file = spec_dir / "version_info.txt"
console_build = os.getenv("XUNLEI_ZHIQU_CONSOLE_BUILD", "0").strip() == "1"

if not task_center_dist.exists():
    raise SystemExit(
        "Task Center dist is missing. Build @xunlei-zhiqu/task-center before PyInstaller."
    )

hiddenimports = [
    "xunlei_zhiqu_runtime.main",
    *collect_submodules("uvicorn"),
]

a = Analysis(
    [str(launcher)],
    pathex=[str(runtime_src)],
    binaries=[],
    datas=[(str(task_center_dist), "task-center")],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="XunleiZhiqu",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=console_build,
    version=str(version_file),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="XunleiZhiqu",
)
