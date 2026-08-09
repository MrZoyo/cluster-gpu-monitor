"""数据模型 —— inventory/settings 的结构，以及采集结果的内部 DTO。

这里只放纯数据结构，不含 IO。pydantic 负责校验与默认值。
"""
from __future__ import annotations

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# inventory.yaml 结构
# ---------------------------------------------------------------------------
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


class BadgeCfg(BaseModel):
    """集群卡片上的自定义标签，可挂多枚。text 必填，其余可选。

    tone 是预设的语义色名（cyan/gold/green/violet/neutral），不接受任意 CSS 色值——
    保证标签色不与利用率语义色、算力域家族色互相干扰。

    key 只在「标签库」（Inventory.badge_library）里需要填：填了就能被算力域/集群
    按名字引用，达到一处定义、多处复用。直接内联写在 badges 下的标签不用填 key。
    """
    key: str | None = None
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
    # 算力域也能挂标签：写标签库的 key（复用），或内联一枚 {text:..., tone:...}
    badges: list[str | BadgeCfg] = Field(default_factory=list)


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
    # 每项可以是标签库的 key（字符串，复用）或内联的完整定义
    badges: list[str | BadgeCfg] = Field(default_factory=list)
    hosts: list[HostCfg] = Field(default_factory=list)

    def resolved_badges(self, library: dict[str, BadgeCfg] | None = None) -> list[BadgeCfg]:
        """badges + configured_by 合成的最终标签序列（configured_by 排在最前）。

        badges 里的字符串按标签库查表展开；查不到的 key 会被跳过（load_inventory
        已经在启动时校验过，正常运行时不会出现）。
        """
        out: list[BadgeCfg] = []
        if self.configured_by:
            out.append(BadgeCfg(
                text=f"{self.configured_by} 配置", mark="◆", tone="cyan",
                tooltip=f"由 {self.configured_by} 进行初始化配置",
            ))
        out.extend(_expand_badges(self.badges, library))
        return out


def _expand_badges(items: list[str | BadgeCfg],
                   library: dict[str, BadgeCfg] | None) -> list[BadgeCfg]:
    """把 badges 列表里的「库 key 字符串」换成库里的定义，内联项原样保留。"""
    lib = library or {}
    out: list[BadgeCfg] = []
    for it in items:
        if isinstance(it, str):
            found = lib.get(it)
            if found is not None:
                out.append(found)
        else:
            out.append(it)
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
    # 标签库：一处定义，算力域/集群按 key 引用。每项必须带 key。
    badge_library: list[BadgeCfg] = Field(default_factory=list)

    @property
    def badges_by_key(self) -> dict[str, BadgeCfg]:
        """标签库的 key → 定义索引。没写 key 的条目忽略（校验时已报错）。"""
        return {b.key: b for b in self.badge_library if b.key}

    def group_badges(self, group: CapacityGroupCfg) -> list[BadgeCfg]:
        """算力域的最终标签序列（库引用已展开）。"""
        return _expand_badges(group.badges, self.badges_by_key)

    def cluster_badges(self, cluster: ClusterCfg) -> list[BadgeCfg]:
        """集群的最终标签序列（含 configured_by 合成的那枚，库引用已展开）。"""
        return cluster.resolved_badges(self.badges_by_key)

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
