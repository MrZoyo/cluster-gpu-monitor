# v0.6.6：Pod 内 GPU 编号与物理卡关联

2026-11-13 发布。

本版修复 PAI 物理卡视图的一处关联缺陷。云监控的 GPU 维度是 Pod 内编号（从 0 起），与 Pod 落在
节点的哪几张卡无关；此前只有编号与物理卡号完全相同才关联，凡是不从 0 号卡开始的 Pod，任务页
有完整指标，热力图和节点页上它的卡却一直显示未知。

- **关联规则**：Pod 的指标编号与物理 `GPUIndexes` 相同，或恰好是完整的 `0..n-1` 时，按升序一一
  配对。卡片指标新增 `pod_gpu` 与 `by_order` 说明取值来源。升序对应是推断，平台文档未保证逐卡
  顺序；顺序若不同，只会在同一 Pod 的卡之间交换数值。
- **歧义保持未知**：同一 Pod 出现在多个节点时，只有唯一一处新鲜观测可以关联，否则都不关联；
  落位含无效或无法解析的卡号、两种 Pod 视图冲突、多个 Pod 关联同一张卡时也不关联。
  已分配但没有计算值的卡通过 `metric_gap` 给出原因码。
- **页面**：悬停提示说明数值取自哪个 Pod 内 GPU，并标明物理卡号是按升序推断；未知卡显示具体
  原因。任务页可查看每个 Pod 内 GPU 对应的物理卡；节点格的人名悬停列出各自占用的卡号并区分
  闲时借用；落位陈旧时标注“上次关联”。
- **统计影响**：更多已分配卡获得实测值，`measured_gpus`、`compute_mean`、`cluster_known_gpus`
  和 `cluster_compute_mean` 的覆盖随之提高。任务均值、集群估算、排行和配额记账的口径不变。
  采集器写入的集群历史自升级起采用新的覆盖，历史不回填；应记录切换时间，覆盖率变化不代表
  负载变化。

详见 [PAI 指南](PAI.md)。本版没有数据库结构变化，不增加云接口调用，第三方依赖保持原锁定版本；
同步包版本、锁文件中的本包版本、README 徽章与文档入口。

这是后端变更：采集器与 Web 应先升级到同一版本，核对一轮采集后再发布前端资源。新前端配旧后端
在结构上兼容，但说明文案描述的是新后端的行为。发布标签不会自动升级生产实例。

## English

Released on 2026-11-13.

This release fixes how PAI per-GPU metrics are joined to physical cards. CloudMonitor numbers GPUs
inside the Pod (from 0), wherever the Pod sits on the node. The join used to require metric ids
equal to the physical indexes, so any Pod that did not start at card 0 had complete metrics on its
workload page while its cards stayed unknown on the heatmap and node page.

- **Pairing rule:** when a Pod's metric ids equal its physical `GPUIndexes`, or form a complete
  `0..n-1` set, they are paired in ascending order. Card metrics now carry `pod_gpu` and `by_order`
  to show where a value came from. Ascending order is an inference: the platform does not document
  per-card order, and a different order would only swap values between cards of the same Pod.
- **Ambiguity stays unknown:** a Pod listed under several nodes is paired only on the single
  freshly observed node, otherwise on none. Placements with invalid or unreadable indexes,
  conflicting Pod views and cards shared by several Pods are never paired. An allocated card
  without a compute value reports the reason in `metric_gap`.
- **Pages:** tooltips name the in-Pod GPU behind a value and state that the physical index is
  inferred by ascending order; unknown cards explain why. Workload pages show the physical card
  for each in-Pod GPU. Hovering the names on a node tile lists who holds which cards and marks
  idle-time borrowing. Stale placements are labelled as last seen.
- **Statistics:** more allocated cards receive measured values, so `measured_gpus`, `compute_mean`,
  `cluster_known_gpus` and `cluster_compute_mean` gain coverage. Workload means, the cluster
  estimate, rankings and quota accounting are unchanged. Cluster history written by the collector
  uses the new coverage from the upgrade onward and is not backfilled; record the switch time, and
  do not read the coverage change as a load change.

See the [PAI guide](PAI.en.md). There is no database schema change, no additional cloud API call,
and third-party dependencies retain their locked versions. Package metadata, the local package
entry in the lockfile, README badges and documentation links advance to v0.6.6.

This is a backend change: upgrade the collector and web service to the same revision, check one
collection round, then publish frontend assets. A new frontend against an older backend is
structurally compatible, but its explanatory text describes the new backend's behaviour.
Publishing a tag does not upgrade production instances.
