# v0.6.3：Feature 归属、排行详情与无重启前端发布

2026-10-11 发布。

- 直接提交根配额（如 `training`）的任务，可按 RAM UserId 对应的当前工作空间角色，额外归入
  唯一匹配的 Feature。根配额独立显示、不参与排名；全局汇总去重，借用仍是占用的子集。
  角色陈旧、读取失败或匹配不唯一时保留未归属状态，不把未知写成零。
- 历史窗口按当前角色重算，不代表历史角色快照。用户维度继续使用原始提交 Quota，CSV 保留归属依据及分母。
- Feature 整行点击展开详情，箭头支持键盘；常态说明收进折叠面板，异常提示保留。
- 静态资源使用不可变版本和原子指针切换，页面固定引用同一版 JS/CSS，旧资源保留用于已打开的标签页及回滚。
  纯前端更新不重启 Web/采集器、不操作数据库；旧后端首次启用协议仍需单独升级。
- PAI 指标读取使用时间索引约束查询范围，避免扫描保留期内全部指标导致超时。
- README 徽章改为仓库内 SVG，保留可点击链接，消除 Shields.io 访问失败对显示的影响。
  CI 徽章是工作流入口，不是静态伪造的“通过”状态。

升级与权限要求见 [PAI 指南](PAI.md)和[前端发布流程](frontend-releases.md)。
本次标签包含 v0.6.2 之后已验收的累计改动；发布标签和更新 demo 不代表自动升级任何生产实例。
版本元数据参与后端兼容指纹，跨版本不能绕过资源包兼容检查。

## English

Released on 2026-10-11.

- Root-quota submissions can additionally be attributed to a uniquely matched feature using the RAM user's
  current workspace roles. The root quota remains separate and unranked. Global totals are deduplicated;
  borrowing remains a subset of occupied time. Stale, unavailable or ambiguous membership stays unresolved.
- Historical windows use current roles, not historical role snapshots. User accounting retains the original
  submission quota; CSV preserves attribution basis and denominators.
- Click a feature row to expand details, with keyboard support on its arrow. Routine explanations are
  collapsed while anomaly messages remain visible.
- Immutable frontend bundles, version-pinned JS/CSS and atomic activation allow frontend updates without
  restarting Web or collectors or touching the database. Old assets remain available for existing tabs
  and rollback. Older backends need a separate one-time protocol upgrade.
- PAI metric reads use the time index to avoid timeout-causing scans of the full retention window.
- Repository-owned SVG badges replace external Shields.io images. The CI badge links to live workflows;
  it does not claim a permanently passing build.

See the [PAI guide](PAI.en.md) and [frontend release workflow](frontend-releases.en.md).
This tag collects the accepted changes since v0.6.2. Publishing it and updating the demo do not deploy
production instances. Version metadata contributes to backend compatibility, so cross-version asset
bundles must still pass compatibility checks.
