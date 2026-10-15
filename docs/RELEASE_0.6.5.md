# v0.6.5：配额详情、借用定位与后台刷新

2026-10-15 发布。

本版汇总 v0.6.4 标签之后的 PAI 采集与界面改进：配额有独立列表和详情，闲时借用可定位到
节点与 GPU 卡号，页面后台刷新保留当前操作状态。缺测、陈旧和归属不完整继续保留为未知。

- **配额视图**：新增根配额和子配额列表、绑定节点、运行任务、用户及本周统计。任务按提交配额
  和实际所在节点合并去重，区分父配额任务、借入与借出；父子配额统计有重叠，不能相加。
- **借用定位**：分别读取默认与闲时 Pod 视图，按任务、Pod 和卡号去重，展示具体借用任务和用户。
  视图失败、陈旧或冲突时保留未知；只有映射完整且一致时，未分配卡才可按空闲展示。
- **采集预算**：优先获取 Pod 映射和 GPU 指标，任务详情、CPU/内存及成员归属按上次尝试时间轮转。
  预算不足时保留旧值并记录 `round.deferred_sources`；主动延后与云接口失败分别标记。
- **后台刷新**：按稳定标识更新变化的行、数值和图表，保留滚动、筛选、展开状态与图例选择。
  请求失败时保留上次成功数据并提示陈旧；切换页面后，迟到请求不会覆盖新页面。
  独立版本检测在发现新资源时提醒重载，原有加载失败提示继续保留。
- **指标说明与布局**：首页和总览用具体卡数解释保存中、环境准备或缺指标等原因，完整公式与原因
  支持悬停、键盘和触屏查看。估算仍由后端计算，前端不补零或放宽完整性条件。
  排队列表默认收起；紧凑热图只用计算色带，显存留在悬停详情；精简中英文配额及借用标签。
- **局部故障**：配额周统计失败只影响该区块并保留上次结果；成员归属失败或过期时显示降级，
  根配额归入量保持未知。用户占用仅计运行且非排队任务，仍有可信映射的保存/停止任务保留实际占卡。
- **在线示例**：更新纯虚构 PAI 数据，展示已定位的 8 卡闲时借用、父配额任务落点、缺 2 卡指标的原因提示和配额详情；当前快照与历史排行分别保留各自的统计口径。

详见 [PAI 指南](PAI.md)与[前端发布流程](frontend-releases.md)。本版同步包版本、锁文件中的
本包版本、README 徽章与文档入口，第三方依赖保持原锁定版本。

采集器需要额外的闲时 Pod 查询，但仍遵守配置的调用、分页和时间预算；升级前应核对来源健康与
延后来源。发布标签不会自动升级生产实例；按实际后端与前端变更选择部署流程，并保留可回滚版本。

## English

Released on 2026-10-15.

This release collects the PAI changes since the v0.6.4 tag: dedicated quota views, per-card
placement of borrowed workloads, and background refresh that preserves page state. Missing,
stale, and incomplete attribution remain explicit.

- **Quota views:** list root and child quotas, bound nodes, running workloads, users, and weekly
  statistics. Workloads submitted to a quota and workloads placed on its nodes are deduplicated,
  with parent-quota workloads and incoming/outgoing borrowing identified. Parent and child views
  overlap and must not be added together.
- **Borrowed placement:** collect both default and idle-time Pod views and deduplicate by workload,
  Pod, and GPU index. Show the borrowing workload and user. Failed, stale, or conflicting views
  leave placement unknown; unallocated cards appear idle only with complete, consistent mapping.
- **Collection budget:** prioritize Pod placement and GPU metrics, then rotate job details,
  CPU/memory, and membership attribution by their last attempt. Budget deferrals retain snapshots
  and appear in `round.deferred_sources`, separately from cloud API failures.
- **Background refresh:** update changed rows, values, and charts while preserving scroll,
  filters, expanded sections, and chart legends. Failed requests retain the last successful view
  with a stale notice. Late responses cannot overwrite a new route. Independent resource-version
  checks prompt a manual reload; existing load-failure recovery remains available.
- **Metric explanations and layout:** home and overview cards explain unavailable estimates with
  GPU counts for saving, environment preparation, or missing metrics. Full formulas and reasons
  support hover, keyboard, and touch access. The backend still computes estimates; the frontend
  neither fills missing data with zeroes nor relaxes completeness checks. Queues start collapsed;
  compact heatmaps use compute colors, with memory in tooltips. Quota and borrowing labels are shorter.
- **Partial failures:** failed weekly quota statistics affect only that section and retain its
  last successful result. Failed or stale membership attribution shows degraded status and leaves
  root-quota attribution unknown. User occupancy counts running, non-queued workloads; saving or
  stopping workloads with reliable placement retain their actual physical occupancy.
- **Online demo:** refreshed fictional PAI data shows eight borrowed GPUs with confirmed placement,
  parent-quota workload placement, explanations for two GPUs missing metrics, and quota details.
  Current snapshots and historical rankings retain their own measurement context.

See the [PAI guide](PAI.en.md) and [frontend release workflow](frontend-releases.en.md). Package
metadata, the local package entry in the lockfile, README badges, and documentation links advance
to v0.6.5; third-party dependencies retain their locked versions.

The collector makes additional idle-time Pod queries within the configured call, pagination, and
time limits. Check source health and deferrals when upgrading. Publishing a tag does not upgrade
production instances; choose the deployment workflow for the actual backend/frontend changes and
retain a rollback version.
