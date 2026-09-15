# v0.5.1 — 延迟容忍与窄屏顶栏修复

短暂采集失败时，卡片保留最近数值和所选时间窗均值，用黄色边框与斜纹提示，避免一次
连接抖动就让整机卡片变成“延迟”。顶栏按可用宽度分组换行，在线状态保持完整可见。

## 变更

- SSH 建连默认等待由 8 秒增至 15 秒，GPU 慢查询阈值由 10 秒增至 15 秒。
- 恢复条件由连续 3 次低于 5 秒改为连续 2 次低于 10 秒。GPU 超时仍为 20 秒，降频间隔仍为 60 秒。
- 主机在线且最近一次完整采样不超过 180 秒时，卡片可显示最近数值；掉卡、离线和过期数据
  不适用。卡片保留均值，悬停可查上次采样时间；18×18 像素的“过载 / 延迟”图例解释黄色样式。
- `now`、实时忙闲统计、当前使用人和匿名摘要仍将失败数据视为未知。显示回退不补写历史样本或权重。
- 1180px 及以下顶栏将操作控件移至下一行；手机上在线数量与数据时间分行，长路径省略并保留悬停全文。
- 合成演示增加短暂中断后保留数值的例子，并继续展示超过时限的延迟和离线状态。

## 升级

从 v0.5.0 升级无需新增数据库结构。沿用现有备份、配置校验和原子 release 部署流程，
更新 collector 与 Web。显式设置的旧值优先于新默认值：尤其需要核对
`ssh_connect_timeout_s`、`gpu_slow_s`、`gpu_recover_s`、`gpu_recover_count`。
若只配置了部分 GPU 时间参数，也应检查最终组合满足
`gpu_recover_s < gpu_slow_s <= gpu_timeout_s`，再运行 `gpumon config-check`。

默认完整 SSH 采集预算为 41 秒，主机心跳仍为 30 秒，心跳过期规则保持不变。
新配置项没有增加；回滚 v0.5.0 时可恢复部署前 settings 与旧 release。

详细语义：[采集保护](ADAPTIVE_PROBING.md) · [配置参考](CONFIGURATION.md)。

## 验证

- 核心回归、前端渲染与语法、配置校验和演示导出检查。
- 浏览器覆盖 320–1440px 的 12 种宽度、中英文、长短路径，以及普通、大集群和服务不可达状态，
  共 144 组，在线状态及操作控件无裁切。
- 保留短暂失败、180 秒边界、未来时间戳、掉卡、离线、零值与恢复后的数值语义检查。

## English

Cards retain recent values and their window averages through brief collection failures, with yellow
borders and stripes indicating delay. The fallback requires a reachable host and its latest complete
sample within 180 seconds. It never populates current statistics, users, anonymous summaries or history.
The utilization legend explains the status cue; tooltips retain the last observation time.

Default SSH connection timeout rises from 8 to 15 seconds, and the slow-GPU threshold from 10 to 15.
Recovery requires two valid queries below 10 seconds instead of three below 5. The GPU timeout and
cooldown stay at 20 and 60 seconds. Explicit settings override defaults; validate partially configured
timing values before restarting. The complete default SSH budget is 41 seconds.

The header groups controls onto another row at widths up to 1180px. On phones, online counts and data
age use separate lines, while long breadcrumbs truncate with the full text available on hover.
Browser checks cover 144 combinations of width, language, path length and service state.

No schema change is required from v0.5.0. Back up, validate configuration, and update both collector
and Web using the normal release workflow. See [adaptive probing](ADAPTIVE_PROBING.en.md) and
[configuration](CONFIGURATION.en.md) for details.
