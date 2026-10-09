from __future__ import annotations

import os
import tomllib
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from ..config import ROOT


class PaiSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    region: str = Field(default="cn-hangzhou", pattern=r"^[a-z0-9-]+$")
    workspace_id: str = Field(default="", pattern=r"^[a-zA-Z0-9_-]*$")
    quota_id: str = Field(default="", pattern=r"^[a-zA-Z0-9_-]*$")
    account_id: str = Field(default="", pattern=r"^[0-9]*$")
    cli_path: str = "pai-tui"
    profile: str = ""
    db_path: str = "data/pai.db"
    baremetal_notice: str = ""
    poll_interval_s: int = Field(default=120, ge=120, le=3600)
    degraded_interval_s: int = Field(default=180, ge=180, le=7200)
    topology_interval_s: int = Field(default=300, ge=300, le=3600)
    stale_after_s: int = Field(default=600, ge=300, le=7200)
    request_timeout_s: int = Field(default=12, ge=1, le=30)
    round_timeout_s: int = Field(default=100, ge=10, le=110)
    max_calls: int = Field(default=120, ge=1, le=300)
    concurrency: int = Field(default=2, ge=1, le=4)
    max_pages: int = Field(default=8, ge=1, le=20)
    max_workloads: int = Field(default=32, ge=1, le=128)
    max_nodes: int = Field(default=64, ge=1, le=256)
    metric_window_s: int = Field(default=600, ge=120, le=1800)
    retention_hours: int = Field(default=24, ge=1, le=72)
    # Pod-level CPU/RAM utilization is fetched every other round; the 10-minute overlapping
    # window still covers every minute. Job details (strategy, worker specs) are cached.
    host_metric_interval_s: int = Field(default=240, ge=120, le=1800)
    job_refresh_s: int = Field(default=6 * 3600, ge=600, le=86400)
    queued_job_refresh_s: int = Field(default=600, ge=120, le=3600)
    max_job_details: int = Field(default=8, ge=0, le=32)


def load_pai_settings() -> PaiSettings:
    path = Path(os.environ.get("GPUMON_PAI_CONFIG", ROOT / "config/pai.toml"))
    if not path.exists():
        return PaiSettings()
    settings = PaiSettings.model_validate(tomllib.loads(path.read_text()))
    if settings.enabled and not all((settings.quota_id, settings.workspace_id, settings.account_id)):
        raise ValueError("Enabled PAI requires account_id, workspace_id and quota_id")
    if not Path(settings.db_path).is_absolute():
        settings.db_path = str(ROOT / settings.db_path)
    return settings
