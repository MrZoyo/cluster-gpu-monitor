# v0.6.0 — 可选 PAI 监控与页面恢复提示

本版在原有裸金属监控之外增加可选 PAI 模块，展示配额、节点、DSW/DLC 任务、单卡曲线和
用户用量。不使用 PAI 的安装保持原来的页面与启动流程，无需增加云凭证或配置。

## 变更

- PAI 默认关闭：只有显式启用 `pai.toml` 才注册接口和显示入口。独立采集进程写入独立 SQLite，Web 只读快照。
- PAI 页面区分物理卡、配额分配、任务申请/调度及闲时资源；提供排队原因、提交策略、Pod 规格、来源新鲜度和小时排行。
- 采集设置请求、轮次、分页和并发边界，失败时保留上次成功值。未知值保持未知，失败旧快照不继续累计运行时长。
- 初始化、脚本加载、视图读取或未捕获异常时显示恢复提示：Mac 使用 Command+Shift+R，Windows/Linux 使用 Ctrl+Shift+R；仍失败时联系管理员。
- 窄屏导航支持多位数计数，中英文标签均可访问。裸金属离线时长显示随最近成功心跳更新。
- Pages demo 增加虚构 PAI 节点、运行/排队/闲时任务、曲线与排行。通过 `--with-pai` 显式导出，不读取生产 PAI 数据。
- 中英文 README、文档目录及 PAI 指南统一更新。旧 `PAI_PROTOTYPE.md` 入口保留并指向新指南。

## 升级与回滚

从 v0.5.1 升级，裸金属配置和数据库结构无需新增变更。按现有流程备份、校验配置并更新
collector 与 Web。PAI 是独立进程，不会由普通裸金属服务自动启动；启用前按 [PAI 指南](PAI.md)
准备 CLI、专用身份、独立数据库与服务资源边界，并验证读取权限。

已启用 PAI 时，分别备份两套数据库并随代码升级重启 PAI 采集器。回滚到不含 PAI 的旧版本时
停止该采集器，保留 PAI 数据、配置与凭证。不要把私有部署配置或真实快照加入公开 demo。

已打开且尚未加载新恢复脚本的旧标签页，需要先刷新一次，才能在后续错误中显示新增提示。
GPU·小时是观测估算，不是账单；历史从采集开始积累，云监控延迟和映射缺口仍会影响覆盖率。

## 验证

本次功能发布已通过 255 项 Linux 核心测试、前端安全/语法检查及 60 项合成浏览器检查，
覆盖 PAI 开关、接口/脚本失败、系统快捷键、中英文和 320/390/430px 多位数标签。
静态 demo 的下钻、曲线、排行与移动布局经过浏览器验证。版本整理另核对了文档链接、
Python 包版本、锁文件一致性及发布提交的 GitHub CI。

完整说明：[PAI 指南](PAI.md) · [配置参考](CONFIGURATION.md) · [原生部署](DEPLOYMENT.md) · [Demo](DEMO.md)。

## English

v0.6.0 adds optional Alibaba Cloud PAI monitoring alongside the existing bare-metal dashboard.
Installations without PAI retain their existing UI and startup flow and require no cloud credentials.

- PAI is disabled by default. A separate bounded collector writes a separate SQLite snapshot; Web only reads it.
- Quotas, physical GPUs, requested/scheduled resources and idle-time capacity remain distinct. Pages include
  workload charts, queue reasons, submission policies, pod specs, freshness and hourly user rankings.
- Failed reads retain the last successful snapshot without accruing additional running time from that failed snapshot.
  Unknown values remain unknown.
- Page failures show force-reload guidance using Command+Shift+R on Mac or Ctrl+Shift+R on Windows/Linux,
  followed by contacting an administrator if the problem persists.
- Narrow-screen tabs accommodate multi-digit counts in both languages. Bare-metal host status includes offline duration.
- The Pages demo adds fictional PAI data through `--with-pai`; it never reads production PAI settings or snapshots.
- English and Chinese entry points, documentation indexes and PAI guides are aligned. The former prototype URL remains valid.

Upgrading from v0.5.1 requires no additional bare-metal configuration or schema changes. Follow the usual
backup, validation and collector/Web update procedure. Configure and verify the separate PAI service
explicitly using the [PAI guide](PAI.en.md). Back up both databases when PAI is enabled; stop the PAI collector
when rolling back to code without the module, while retaining its data and credentials.

Tabs opened before the recovery script was deployed need one refresh to receive it. Observed GPU hours
are not billing records; history begins when collection starts and remains subject to reporting delays
and incomplete mappings.

Validation covers 255 Linux core tests, frontend checks and 60 synthetic browser checks, including disabled
PAI, loading failures, OS-specific shortcuts, languages and narrow-screen tabs. Static demo navigation,
charts and responsive layout were browser-checked. Release preparation also checks documentation links,
package/lockfile version consistency and CI on the published commit.
