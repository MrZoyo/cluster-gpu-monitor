# PAI 监控

简体中文 | [English](PAI.en.md) | [文档目录](README.md) | [项目首页](../README.md)

PAI 模块展示阿里云 PAI 配额、节点、DSW/DLC 任务、用户用量和利用率曲线。独立采集进程
通过云 API 读取数据并写入 `pai.db`；Web 只读本地快照，刷新页面不会调用云 API。

## 默认关闭

不创建 `config/pai.toml`，或保持 `enabled = false`，即可使用原有裸金属监控。
此时没有 PAI 导航或双入口首页，`/api/pai/*` 返回普通 404，手动访问 `#/pai...` 会回到总览。
配置缺失或无效也不会注册 PAI 路由。修改启用状态后须重启 Web。

启用后，根页面显示裸金属和 PAI 两个入口，`#/baremetal` 为裸金属总览。既有的集群、主机、
GPU 和用户排行链接继续有效。两类资源的身份和统计口径不同，页面不合并两边的数据。

## 启动

先完成 [README 快速开始](../README.md#快速开始)，准备 Web 所需的 inventory、settings 和
裸金属数据库。另行安装并配置 PAI CLI；适配器已在官方 CLI v1.0.1 及使用该引擎的 `pai-tui`
包装器上验证。`cli_path` 可指向任一兼容可执行文件。采集器使用文件锁，支持 Linux/macOS。

1. 复制 [pai.example.toml](../config/pai.example.toml) 为私有 `config/pai.toml`。
2. 填入账号、地域、工作空间和根配额，设置 `enabled = true` 和正确的 `cli_path`。
3. 在采集进程的 CLI 身份中配置只读权限。凭证不写入 TOML、源码或网页。
4. 先执行一轮采集，再启动常驻采集器和 Web。两个进程使用相同的配置/数据根。

```sh
export GPUMON_ROOT=/absolute/path/to/runtime
export GPUMON_PAI_CONFIG="$GPUMON_ROOT/config/pai.toml"

uv run python -m gpumon.pai.collector --once
uv run python -m gpumon.pai.collector
# 另一个终端设置相同的两个环境变量，再启动 Web
uv run gpumon web --host 127.0.0.1 --port 8848
```

每轮先通过 STS 核实账号；账号不匹配时停止本轮，不继续读取其他资源。采集需要读取配额、
节点、Pod、任务、用户用量、DLC 任务详情和 CloudMonitor 指标。上线前应在专用身份下验证
这些读取权限。验证通过不等于证明该身份没有其他权限；本模块不执行写操作探测。

## 配置

相对 `db_path` 以 `GPUMON_ROOT` 为基准。默认读取该根目录下的 `config/pai.toml`；
`GPUMON_PAI_CONFIG` 可指定其他位置。未知配置字段会校验失败。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 显式启用；开启时账号、工作空间和配额必填 |
| `region` | `cn-hangzhou` | 云资源所在地域 |
| `account_id` / `workspace_id` / `quota_id` | 空 | STS 账号、工作空间、要监控的根配额 |
| `cli_path` / `profile` | `pai-tui` / 空 | CLI 路径和身份配置名；CLI profile 中的凭证优先于环境变量 |
| `db_path` | `data/pai.db` | 独立 PAI 数据库，不与裸金属共用 |
| `baremetal_notice` | 空 | 启用 PAI 后可在裸金属页面显示的说明文字 |
| `poll_interval_s` / `degraded_interval_s` | `120` / `180` | 正常及连续失败后的采集间隔 |
| `topology_interval_s` / `stale_after_s` | `300` / `600` | 配额/节点目录缓存周期及普通来源陈旧阈值 |
| `request_timeout_s` / `round_timeout_s` | `12` / `100` | 单次 CLI 调用与整轮时间预算 |
| `max_calls` / `concurrency` | `120` / `2` | 每轮最大调用数与并发数；小规格宿主可用单路并发 |
| `max_pages` / `max_workloads` / `max_nodes` | `8` / `32` / `64` | 分页、任务指标和节点数量边界 |
| `metric_window_s` / `retention_hours` | `600` / `24` | 重叠回读窗口及原始指标保留时间 |
| `host_metric_interval_s` | `240` | 任务 CPU/内存利用率的刷新周期 |
| `job_refresh_s` / `queued_job_refresh_s` | `21600` / `600` | 运行中/排队 DLC 任务详情缓存周期 |
| `max_job_details` | `8` | 每轮最多刷新多少个 DLC 详情 |

连续两轮失败后降低采集频率，两轮成功后恢复正常。遇到限流停止新请求并至少等待 600 秒，
连续限流继续退避。超出调用或分页预算时标记失败、保留最近成功值，不把部分结果当完整覆盖。
各字段范围的事实来源为 [PaiSettings](../src/gpumon/pai/config.py)。

## 页面与数据口径

| 页面 | 内容 |
| --- | --- |
| 总览 | 配额分配、物理卡热力图、低利用率提醒、排队任务及来源健康 |
| 节点 | 逐卡映射、所属配额、健康状态及任务下钻 |
| 任务 | 搜索/筛选/排序，申请与调度资源、提交策略、单 Pod 规格及近 1 小时曲线 |
| 用户 | Owner / 提交者名下任务、配额内和闲时资源、用量差异 |
| 排行 | 默认本周 Feature / Quota 排行；可切用户、上周和原有滚动窗口，导出 CSV |

- 卡数按节点和卡号去重；父配额包含子配额，不能相加。申请量、调度量、配额分配和物理卡映射分别展示。
- 物理卡仅在 Pod 指标 GPU 索引集合与物理 `GPUIndexes` 一致时关联；多任务共享卡或关联不明时保留未知。
- `UseOversoldResource` 标识已调度任务实际使用的闲时资源，与提交策略和配额共享开关不同。
  隐藏节点不能证明任务位于已列节点之外；闲时任务卡数不与物理卡总数相加。
- 排队提示结合提交策略、配额容量和单 Pod 规格，保留平台原始原因。数据不足时不宣称一定无法调度。
- 利用率曲线按源时间保留任务/Pod/GPU 维度，使用固定 120 秒桶；迟到点可修订已有桶，缺测不计零。
  未关联物理节点的任务仍可展示指标，历史曲线不回填当前物理归属。
- 首页和总览的“计算均值（任务）”按运行任务各 GPU 的最新新鲜计算指标取平均，每张卡等权，
  包含未关联物理节点的闲时任务；未占用卡、缺测和陈旧值不参与。它不是各任务均值的等权平均。
- “集群占用”按全部物理卡取平均，已确认未占用的卡按 0% 计入。确认需要节点、任务和 Pod 映射
  新鲜，且节点请求卡数不超过已关联卡数；已用卡缺测或分配关系不明时显示“—”，不会当作空闲。
  无法关联到物理卡的闲时任务不加入分子或分母。比如 128 张卡中 64 张满载、64 张未占用，结果为 50%。
- 任务和用户详情页可保留上次成功取得的陈旧指标，并明确标注；总览的任务平均只使用新鲜指标。
- 低利用率提醒使用近 10 分钟计算均值，至少 5 个分钟点；陈旧值保留显示，但不参与提醒。
  CPU/内存利用率为任务 Pod limit 的百分比，申请量另列。
- 个人归属来自 RAM Owner / 提交者，不使用 CloudMonitor 的主账号 `userId`，也不识别共享容器内的逐进程使用人。
- GPU·小时只用当轮成功读取、状态为 Running 的任务累计。长间隔最多计两倍降级周期，已知调度量为零时保留零。
  按 UTC 小时汇总，保留 32 天；窗口边缘可能包含不足一小时的额外数据。这是观测估算，不是计费账单。

### Feature 周排行

默认按北京时间（Asia/Shanghai）周一 00:00 至今统计；上周是前一个完整自然周。
滚动窗口仍保留，PAI 的时间窗和维度选择独立于裸金属页面，并在自动刷新时保留。
Feature 使用任务提交时的 `QuotaId` 分组，同一用户可以出现在多个 feature 的任务中。
根配额直接提交的任务单列，不根据用户名猜测算法组；要做算法组周报，需要提交者选择对应配额。

- **任务 GPU·小时**包含配额内和闲时任务；闲时单列。任务只归属提交配额，不向父配额重复累计。
- **当前配额 / 用量 / 占用率**来自最新 Quota 快照，始终表示当前值，即使选择上周也不会变成历史值。
  快照陈旧时显示提示。资源上实际分配及祖先借用卡数可在用量提示中查看，不能当作该 feature 的任务用量。
- **窗口配额占用率**为观测到的 Quota 用量卡秒除以同一时间段的容量卡秒，配额变更按时长加权。
  使用平台 `gpu_used`，不含闲时资源。父配额用量可含子配额，容量和用量均不可跨层级相加。
  缺失、零容量或没有历史分母时占用率未知，不以当前容量倒算历史。
- **计算利用率**为已有任务指标样本均值；有效 GPU·小时沿用按计算利用率加权的估算，并显示指标覆盖。
  它与“占用了多少配额”不同，不能把占用率视为计算效率。
- 配额历史从这次功能上线后首次观测开始累计，使用前一轮快照积分（配额目录约 5 分钟刷新）。
  首次观测不回填，失败快照不延续；长间隔最多累计两倍降级周期。资源池的观测覆盖率显示在汇总中，
  个别配额与资源池明显不同时在该行单独标注。
  部分覆盖时，占用率仅代表已观测部分，任务历史可能更长。保留 32 天，小时边界精度与任务排行相同。
- 页面先给出本窗口汇总：GPU·小时合计、资源池配额占用率、有效 GPU·小时、当前资源池和活跃 feature。
  “接近满额”（窗口配额占用率 ≥ 90%）和“计算偏低”（计算均值 < 10%）只是提示，不改变排序。
  统计口径默认折叠在排行榜下方。
- **导出 CSV**包含窗口、生成时间、任务历史起点、截断标记以及当前返回的全部行。
  Feature 导出包含容量 GPU·小时、用量 GPU·小时、观测小时、覆盖率和计算指标，供周报核查。
  未知值留空；CSV 不触发自动汇报或发送消息。

页面每 120 秒刷新，保留滚动、筛选和展开状态；输入搜索词时推迟刷新。来源列表展示每项数据的
获取时间、源采样时间及失败类别。采集失败不代表云节点宕机，“未见占用”也不等于可立即调度。
节点异常提示只提供处理指引，页面不会重启 DSW、终止 DLC 或修改云资源。

## 生产部署

通用发行包提供采集模块，**不会自动安装云 CLI、创建账号或启用 PAI 服务**。仓库现有 systemd
和 Compose 服务负责裸金属监控；PAI 需要部署方单独配置采集服务及 CLI。部署时应：

- 为 PAI 配置独立无登录服务账号，固定 CLI 版本和校验和。凭证只注入采集进程；Web 无法读取。
  使用环境变量时，确认 CLI profile 不会覆盖专用身份。
- 准备独立数据目录，通过共享组给 Web 读取权限。采集器 UMask 为 0027，新目录/数据库通常为
  0750/0640；现有目录权限须单独检查。长期写连接维护 WAL/SHM，避免只读访问失败。
- 按宿主容量设置服务内存、CPU、进程数和请求上限；用至少一个完整采集周期测量实际消耗。
  配置上限、整轮墙钟时间和实际 CPU/内存占用是不同指标。
- 分别备份裸金属和 PAI 数据库，使用 SQLite 在线备份。升级后重启独立采集服务；回滚到不含 PAI 的
  旧代码时停止 PAI 采集并保留数据库、配置和凭证。
- 使用带认证的 HTTPS 入口。PAI API 不加入匿名 GPU 摘要，也没有“每个用户只能看自己”的应用内 RBAC。

## 只读接口

| 接口 | 内容 |
| --- | --- |
| `/api/pai/status` | 启用状态、来源健康、覆盖摘要 |
| `/api/pai/overview` | 当前完整快照 |
| `/api/pai/nodes` / `/api/pai/workloads` / `/api/pai/users` | 节点、任务或用户子集 |
| `/api/pai/metrics/series?workload_id=...` | 默认近 1 小时，可选 1–6 小时；最多 20,000 源点，超限标记 `truncated` |
| `/api/pai/ranking?window=week` | 默认本周，`last_week` 为上周；兼容原有滚动窗口，返回 `features` 和 `users`，每类最多 200 行 |

总览 `summary` 新增 `task_compute_mean` / `task_measured_gpus` 和 `cluster_compute_mean` /
`cluster_known_gpus` / `cluster_unallocated_gpus`。原 `compute_mean` 继续表示已映射物理卡的新鲜指标均值；
`metric_denominator` 为物理卡数，不是任务平均的分母。

## 验证、演示与边界

运行 `uv run pytest -q tests/test_pai.py` 和 `node tests/frontend_security.js`。
安装 Playwright 后可运行 `node tests/browser_recovery.cjs`；`CHROME_BIN` 指定浏览器，
`SHOT_DIR` 可将截图写到仓库外。测试使用合成数据，不调用云 API。

[在线演示](https://mrzoyo.github.io/cluster-gpu-monitor/)通过 `--with-pai` 生成完全虚构的 PAI 数据，
不读取生产配置、账号或数据库。普通导出不包含 PAI，详见 [Demo 指南](DEMO.md)。

目前没有跨平台统一身份、审计级计费、逐 PID 分账、物理卡精确 GiB 或超过 32 天的 PAI 排行历史。
云监控上报可能迟到或缺失，物理关联也可能不完整；重叠回读不能保证固定延迟后全部数据齐全。

接口参考：[ListQuotaWorkloads](https://help.aliyun.com/zh/pai/developer-reference/api-paistudio-2022-01-12-listquotaworkloads)、
[ListQuotas](https://help.aliyun.com/zh/pai/developer-reference/api-paistudio-2022-01-12-listquotas)、
[DescribeMetricList](https://help.aliyun.com/en/cms/cloudmonitor-1-0/developer-reference/api-cms-2019-01-01-describemetriclist)。
