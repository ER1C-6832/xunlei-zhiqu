from datetime import UTC, datetime, timedelta

from xunlei_zhiqu_runtime.models import ResourceJobSnapshot


def fixture_jobs() -> list[ResourceJobSnapshot]:
    """Small stage-B fixture set for the task center.

    Fixtures cover the visible task states only. Dynamic jobs created from the
    extension are kept by job_store and are placed ahead of these examples.
    """
    now = datetime.now(UTC)
    return [
        ResourceJobSnapshot(
            job_id="job_zhiqu_001",
            title="Example App 5.2.1",
            subtitle="Windows x64 便携版 · 中文语言包 · 校验文件",
            kind="zhiqu",
            status="downloading",
            progress=68.4,
            downloaded_bytes=1_842_000_000,
            total_bytes=2_692_000_000,
            speed_bytes_per_second=12_600_000,
            eta_seconds=68,
            stage_label="正在下载主资源",
            next_action="pause",
            source_count=3,
            excluded_count=15,
            created_at=now - timedelta(minutes=18),
            destination="D:/Downloads/Example App 5.2.1",
            delivery_target="local",
        ),
        ResourceJobSnapshot(
            job_id="job_zhiqu_002",
            title="Open Media Course · 1080p",
            subtitle="12 个视频 · 中文字幕 · 2 个备用来源",
            kind="zhiqu",
            status="waiting_for_source",
            progress=42.0,
            downloaded_bytes=3_210_000_000,
            total_bytes=7_643_000_000,
            speed_bytes_per_second=0,
            eta_seconds=None,
            stage_label="云盘来源失效，等待继续获取",
            issue="主来源返回 503，原页面、候选与 42% 进度均已保留。",
            next_action="continue_acquisition",
            source_count=2,
            excluded_count=8,
            created_at=now - timedelta(hours=1, minutes=12),
            destination="迅雷云盘/智取下载/Open Media Course",
            delivery_target="cloud",
        ),
        ResourceJobSnapshot(
            job_id="job_normal_001",
            title="sample-dataset.zip",
            subtitle="普通下载 · ZIP 压缩包",
            kind="normal",
            status="completed",
            progress=100,
            downloaded_bytes=482_000_000,
            total_bytes=482_000_000,
            speed_bytes_per_second=0,
            eta_seconds=None,
            stage_label="已完成",
            next_action="open",
            source_count=1,
            excluded_count=0,
            created_at=now - timedelta(days=1),
            destination="D:/Downloads/sample-dataset.zip",
            delivery_target="local",
        ),
        ResourceJobSnapshot(
            job_id="job_zhiqu_003",
            title="Open Tools Pack 2026.08",
            subtitle="Windows x64 安装包 · 文档 · SHA-256 校验文件",
            kind="zhiqu",
            status="completed",
            progress=100,
            downloaded_bytes=734_000_000,
            total_bytes=734_000_000,
            speed_bytes_per_second=0,
            eta_seconds=None,
            stage_label="已保存到云盘",
            next_action="open",
            source_count=2,
            excluded_count=6,
            created_at=now - timedelta(days=2, hours=3),
            destination="迅雷云盘/智取下载/Open Tools Pack 2026.08",
            delivery_target="cloud",
        ),
    ]
