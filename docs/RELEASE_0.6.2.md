# v0.6.2：PAI 原配额空闲展示与借用统计

2026-10-10 发布。

- “已分配 GPU”显示运行任务总占用 / 物理池容量，包含借用一次；同一卡片以紫色标注“其中借用 × 卡”。
  物理映射数量另标为“已定位占用”，不再冒充全部已分配卡数。
- 物理卡热力图中，原配额未占用、仅因借用任务无法定位的卡显示 `0` 和“可能被借用”。
  原配额可申请这些资源并享有优先权；借用任务会被回收、释放资源并重新排队。
- 展示的 `0` 表示原配额空闲，不是实测 GPU 利用率。已关联任务继续显示真实指标；
  采集失败、陈旧数据、请求量不一致和普通任务映射缺失仍保留未知。
- 任务计算均值包含借用任务的新鲜单卡指标；集群计算估算使用自有物理池容量作为分母。
  借用不增加物理容量，未定位卡的展示值不写入计算、效率或历史统计。
- 本次发布也包含 v0.6.1 标签之后累计的 Feature/用户周排行、可配置周界、GPU 时间与效率审计、指标覆盖率和 CSV。
  默认周界仍为北京时间周一 00:00；历史审计从启用后累计，不回填未知时段。
- PAI 仍为可选功能，使用独立只读采集和数据库。本次热力图修正不改变采集频率、凭证或数据库结构；
  此前的审计更新已新增历史汇总表，旧版本回滚可以忽略这些附加表。

详细口径见 [PAI 指南](PAI.md)。

## English

Released on 2026-10-10.

- “Allocated GPUs” shows total running workload allocation / physical pool capacity, including borrowing once.
  A purple “Including N borrowed GPUs” label stays in the same card. Physical mappings are labeled separately.
- GPUs idle for their original quota display `0` and “Possibly borrowed” when only borrowing workloads lack
  physical mapping. The original quota has priority; borrowing is reclaimed and the borrower requeues.
- This display zero denotes quota availability, not measured GPU utilization. Mapped workloads retain real
  metrics. Failed or stale sources, inconsistent requests and unmapped regular workloads remain unknown.
- Task compute means include fresh borrowed-GPU metrics. Pool estimates use owned physical capacity once;
  display zeros never fill compute, efficiency or history metrics.
- Cumulative updates include feature/user weekly rankings, configurable reporting boundaries, GPU-time and
  efficiency audits, coverage and CSV export. The default week starts Monday at 00:00 Asia/Shanghai.
- PAI remains optional with a separate read-only collector and database. This heatmap correction changes no
  polling, credentials or schema. Earlier audit updates added history tables that older
  releases can ignore on rollback; unknown history is not backfilled.

See the [PAI guide](PAI.en.md).
