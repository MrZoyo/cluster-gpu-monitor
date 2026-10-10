# v0.6.1：PAI 任务平均与集群占用

> 历史发布记录。2026-10-10 已修正隐藏借用卡不能判空闲，并新增时间维度审计；当前口径见 [PAI 指南](PAI.md)。
> Historical release notes: hidden borrowing and time-based audit semantics were corrected on 2026-10-10; see the [current PAI guide](PAI.en.md).

- 总览原“显存均值”改为“集群占用”：全部物理卡参与平均，已确认未占用的卡按 0% 计入。
  已用卡缺测或分配关系不明时显示“—”，避免把未知算为空闲；首页也展示这一指标。
- “计算均值（任务）”平均运行任务各 GPU 的新鲜指标，每卡等权，包含闲时任务。
  提示说明实际参与卡数；它不代表全资源池利用率。
- 闲时任务显示申请卡数，不将未知物理位置的申请量算作额外物理容量。
- 修复首页没有排队任务时右上角显示 `null`。

PAI 仍默认关闭。本版没有数据库结构、采集频率或权限变更。API 新增统计字段，保留原
`compute_mean`（已映射物理卡的新鲜指标均值）以兼容旧客户端。口径见 [PAI 指南](PAI.md)。

## English

- Replace the overview memory mean with cluster utilization, including confirmed unallocated physical
  GPUs at 0%. Missing allocated metrics or uncertain allocation shows “—”. Home displays it as well.
- Label the running-task GPU mean explicitly, with equal weight per fresh GPU metric, including idle-time
  tasks. Show the measured count and distinguish this from whole-cluster utilization.
- Clarify that idle-time GPU requests are not additional confirmed physical capacity.
- Fix literal `null` on home when no workloads are queued.

PAI remains opt-in. No schema, collection cadence or permission changes. New API fields are additive;
legacy `compute_mean` retains its mapped-physical-GPU meaning. See the [PAI guide](PAI.en.md).
