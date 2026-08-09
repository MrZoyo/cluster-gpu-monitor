"""数据模型 —— inventory/settings 的结构，以及采集结果的内部 DTO。

这里只放纯数据结构，不含 IO。pydantic 负责校验与默认值。
"""
from __future__ import annotations

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# inventory.yaml 结构
# ---------------------------------------------------------------------------
class LabelCfg(BaseModel):
    """标签库定义 —— 集中管理可复用的说明标签。"""
    key: str                       # 标签唯一标识，如 "best-gpu"
    name: str                      # 显示名称，如 "顶级算力"
    content: str                   # 标签正文内容
    # 可选的自定义样式（未来扩展）
    color: str | None = None       # 自定义颜色，留空则继承家族色
    icon: str | None = None        # 前缀图标 emoji
    type: str = "info"             # info / warning / success（控制视觉样式）


class HostCfg(BaseModel):
    key: str                       # 稳定标识，历史按它关联
    ssh_alias: str                 # ~/.ssh/config 别名，采集用
    display_name: str
    gpu_count: int | None = None   # 缺省时取 cluster/defaults
    status: str = "active"
    note: str | None = None
    # GPU 厂商：留空 = 远端自动探测（先 nvidia-smi 再 rocm-smi）。
    # 只有自动探测判错时才需要显式写 nvidia / amd。
    vendor: str | None = None
    meta: dict = Field(default_factory=dict)
    labels: list[str] = Field(default_factory=list)  # 引用标签 key 列表


class BadgeCfg(BaseModel):
    """集群卡片上的自定义标签，可挂多枚。text 必填，其余可选。

    tone 是预设的语义色名（cyan/gold/green/violet/neutral），不接受任意 CSS 色值——
    保证标签色不与利用率语义色、算力域家族色互相干扰。
    """
    text: str
    mark: str | None = None        # 前缀符号，如 "◆"；留空则不显示
    tooltip: str | None = None
    tone: str = "cyan"


class CapacityGroupCfg(BaseModel):
    key: str
    name: str
    sort_order: int = 0
    description: str | None = None
    # 色带名（lime/violet/azure/amber/rose/teal/indigo/slate）。
    # 留空则按 sort_order 自动轮转分配，不会撞成灰色。
    palette: str | None = None
    labels: list[str] = Field(default_factory=list)  # 引用标签 key 列表


class ClusterCfg(BaseModel):
    key: str
    name: str
    sort_order: int = 0
    # 留空 = 落到 defaults.fallback_group_key
    capacity_group: str = ""
    status: str = "active"
    note: str | None = None
    jump: str | None = None        # 仅元数据
    # 兼容糖：填了等于加一枚 {mark:"◆", text:"<名字> 配置"} 标签。新配置建议直接写 badges。
    configured_by: str | None = None
    badges: list[BadgeCfg] = Field(default_factory=list)
    labels: list[str] = Field(default_factory=list)  # 引用标签 key 列表
    hosts: list[HostCfg] = Field(default_factory=list)

    def resolved_badges(self) -> list[BadgeCfg]:
        """badges + configured_by 合成的最终标签序列（configured_by 排在最前）。"""
        out: list[BadgeCfg] = []
        if self.configured_by:
            out.append(BadgeCfg(
                text=f"{self.configured_by} 配置", mark="◆", tone="cyan",
                tooltip=f"由 {self.configured_by} 进行初始化配置",
            ))
        out.extend(self.badges)
        return out


class Defaults(BaseModel):
    gpu_count: int = 8
    poll_interval_s: int = 30
    # 集群未声明 capacity_group、或引用了不存在的域时兜底用的域。
    fallback_group_key: str = "default"
    fallback_group_name: str = "未分组"


# 内置色带名，顺序即自动轮转顺序。见 web/js/components.js 的 BANDS。
PALETTES = ["lime", "violet", "azure", "amber", "rose", "teal", "indigo", "slate"]


class Inventory(BaseModel):
    version: int = 1
    defaults: Defaults = Field(default_factory=Defaults)
    # 不预置任何机构名——没声明就由 resolved_groups() 兜一个中性的"未分组"。
    capacity_groups: list[CapacityGroupCfg] = Field(default_factory=list)
    clusters: list[ClusterCfg]
    labels: list[LabelCfg] = Field(default_factory=list)  # 标签库

    def get_label(self, key: str) -> LabelCfg | None:
        """根据 key 查找标签定义。"""
        for label in self.labels:
            if label.key == key:
                return label
        return None

    def resolve_labels(self, label_keys: list[str]) -> list[LabelCfg]:
        """将标签 key 列表展开为完整的标签对象列表（跳过不存在的 key）。"""
        return [lb for key in label_keys if (lb := self.get_label(key))]

    def group_key_of(self, cluster: ClusterCfg) -> str:
        """集群实际归属的算力域 key：没写或写了不存在的域，都落到兜底域。"""
        declared = {g.key for g in self.capacity_groups}
        if cluster.capacity_group and cluster.capacity_group in declared:
            return cluster.capacity_group
        return cluster.capacity_group or self.defaults.fallback_group_key

    def resolved_groups(self) -> list[CapacityGroupCfg]:
        """最终算力域列表：显式声明的 + 集群引用到但未声明的 + 兜底域，按 sort_order 排序。

        palette 未指定时按位置轮转分配，保证第 3、4、5… 个域也有独立色系，
        不会像旧版那样全部掉进灰色 FALLBACK。
        """
        out = list(self.capacity_groups)
        known = {g.key for g in out}
        for c in self.clusters:
            k = self.group_key_of(c)
            if k in known:
                continue
            known.add(k)
            is_fallback = k == self.defaults.fallback_group_key
            out.append(CapacityGroupCfg(
                key=k,
                name=self.defaults.fallback_group_name if is_fallback else k,
                sort_order=999,
            ))
        out.sort(key=lambda g: (g.sort_order, g.key))
        for i, g in enumerate(out):
            if not g.palette:
                g.palette = PALETTES[i % len(PALETTES)]
        return out

    def iter_hosts(self):
        """展开成 (cluster, host, gpu_count) 三元组，gpu_count 已套用默认值。"""
        for c in sorted(self.clusters, key=lambda x: x.sort_order):
            for h in c.hosts:
                yield c, h, (h.gpu_count or self.defaults.gpu_count)


# ---------------------------------------------------------------------------
# settings.toml 结构
# ---------------------------------------------------------------------------
class CollectorSettings(BaseModel):
    poll_interval_s: int = 30
    ssh_connect_timeout_s: int = 8
    ssh_total_timeout_s: int = 20
    max_concurrency: int = 8
    cpu_sample_gap_s: int = 1


class RetentionSettings(BaseModel):
    raw_days: int = 14
    rollup_5m_days: int = 30
    rollup_1h_days: int = 400   # 1 小时聚合保留天数；须 > 最长时间窗(1m=30d)，留足余量


class DbSettings(BaseModel):
    path: str = "data/gpumon.db"


class WebSettings(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8848


class PrivacySettings(BaseModel):
    mask_users: bool = False


class Settings(BaseModel):
    collector: CollectorSettings = Field(default_factory=CollectorSettings)
    retention: RetentionSettings = Field(default_factory=RetentionSettings)
    db: DbSettings = Field(default_factory=DbSettings)
    web: WebSettings = Field(default_factory=WebSettings)
    privacy: PrivacySettings = Field(default_factory=PrivacySettings)


# ---------------------------------------------------------------------------
# 采集结果 DTO（采集器解析 remote_probe 输出后产出，再交给 store 写库）
# ---------------------------------------------------------------------------
class GpuSample(BaseModel):
    index: int
    uuid: str
    name: str | None = None
    vendor: str | None = None      # nvidia / amd，仅用于展示与排障，不参与历史关联
    util_gpu: int | None = None
    util_mem: int | None = None
    mem_used_mib: int | None = None
    mem_total_mib: int | None = None
    temp_c: int | None = None
    power_w: float | None = None


class ProcSample(BaseModel):
    gpu_uuid: str
    pid: int
    username: str | None = None
    comm: str | None = None
    mem_used_mib: int | None = None


class HostSample(BaseModel):
    ncpu: int | None = None
    load1: float | None = None
    load5: float | None = None
    load15: float | None = None
    cpu_util_pct: float | None = None
    mem_total_mib: int | None = None
    mem_avail_mib: int | None = None
    mem_used_mib: int | None = None


class ProbeResult(BaseModel):
    """一台机器一轮采集的完整结果。ok=False 表示该机本轮失败（超时/SSH错误）。"""
    host_key: str
    ok: bool
    error: str | None = None
    vendor: str | None = None      # 远端实际探测到的厂商（nvidia/amd/none）
    remote_hostname: str | None = None
    gpus: list[GpuSample] = Field(default_factory=list)
    procs: list[ProcSample] = Field(default_factory=list)
    host: HostSample | None = None
