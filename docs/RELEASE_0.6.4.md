# v0.6.4：按配额存在时段计算覆盖率

2026-10-14 发布。

配额删除后再创建时，原先按完整窗口计算的覆盖率会把不存在的时间算成缺测。
本版将成功、完整采集确认配额不存在的时间从分母排除，采集失败和未知时段仍计缺测。

- 覆盖率为“有效观测时长 ÷（窗口时长 − 确认不存在时长）”；不增加观测时长，也不补零容量或用量。
- 采集器新增小时级存在性记录，失败打断连续性，长间隔受 `max_gap` 限制，保留期为 32 天。
- API、详情和 CSV 提供应观测时长、排除时长及口径；全窗口确认不存在时覆盖率为 `null`。
- 旧库缺少存在性历史时保留原窗口分母。有证据的历史停用期可独立记录，原始用量和容量保持不变。
- 中英文文档说明多 quota 归属：子配额任务按任务 QuotaId；根配额仅归入当前角色唯一匹配的
  Feature，多重匹配留为未归属。历史窗口使用当前角色关系，这套归属规则本版未改动。
- 同名配额不自动合并；人工历史修复必须核对身份、时间范围与证据并保留备份。

详见 [PAI 覆盖率口径](PAI.md#配额时间覆盖率)。本版同步包版本、锁文件中的本包版本、
README 徽章与文档入口，不升级第三方依赖。该修复已通过核心 324 项、私有部署 35 项及
4 个子测试，并完成浏览器详情与 CSV 回归；版本发布前另核验元数据和构建产物。

升级采集器会追加存在性表，部署前分别备份 PAI 与裸金属库。发布标签不会自动升级生产实例；
版本元数据参与后端兼容指纹，前端资源仍须通过版本兼容检查。

## English

Released on 2026-10-14.

After a quota is deleted and recreated, full-window coverage can incorrectly treat its absence as
missing observations. This release excludes time when successful, complete collection confirmed
absence. Collection failures and unknown intervals still count as missing.

- Coverage is valid observed time divided by window time minus confirmed absence. It does not add
  observations or fill capacity and usage with zeroes.
- The collector records hourly quota presence, breaks continuity on failure, bounds long intervals
  with `max_gap`, and retains 32 days of history.
- API responses, details and CSV expose expected time, excluded time and the coverage basis.
  A quota confirmed absent throughout the window has `null` coverage.
- Older databases without presence history retain the window denominator. Evidence-backed historical
  exclusions are separate from original usage and capacity records.
- Both language guides explain the unchanged multi-quota rule: child submissions follow the task's
  QuotaId; root submissions require a unique current-role feature match. Ambiguous matches stay
  unattributed, and historical windows use current roles.
- Matching quota names do not automatically merge history. Manual corrections require identity and
  interval checks, evidence and backups.

See [quota time coverage](PAI.en.md#quota-time-coverage). Package metadata, the local package entry in
the lockfile, README badges and documentation links advance to v0.6.4; third-party dependencies do not
change. The fix passed 324 core tests, 35 private deployment tests and 4 subtests, plus browser detail
and CSV checks. Release validation also checks version metadata and built artifacts.

Collector upgrades add presence tables. Back up PAI and bare-metal databases separately before
deployment. Publishing a tag does not upgrade production instances. Version metadata contributes to
the backend fingerprint, so frontend compatibility checks still apply.
