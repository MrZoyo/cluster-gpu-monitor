# cluster-gpu-monitor

简体中文 | [English](README.en.md)

多集群 GPU 服务器的自托管监控：**不装 agent、不要 root、不依赖调度器**，只用一条普通 SSH
把利用率、显存、温度、功耗和"谁在用"持续记进 SQLite，回答的是**"要不要加卡"**，
而不是"现在哪张卡空着"。

核心指标是 GPU 利用率的**滚动平均**（12h / 24h / 48h / 72h / 1 周 / 2 周 / 1 月），
配合按人统计的 GPU 卡时排行和"空占"检测，用来给扩容决策提供依据。

## 为什么又造一个

GPU 监控工具大致分两派，中间留了个空档：

- **"现在谁空着"看板**（gpustat-web、gpuview、ssh-dashboard、nvitop 等）：同样免 agent、
  也能看到每个用户的进程，但**不存历史**——问不出"我们上个月平均利用率多少"。
- **长周期指标栈**（DCGM + Prometheus + Grafana）和 **HPC 作业计费**（各家 jobstats / GCM 类方案）：
  有历史也有人头归属，但代价是**每台机装 agent / daemon**，或者**必须有调度器**
  （Slurm、k8s）才能把用量算到人身上。

这个项目落在中间：免 agent 的采集方式 + 长期历史 + 人头归属三者同时要。

|                    | 免 agent | 持久化历史 | 按用户归属 | 需要调度器 |
| ------------------ | :------: | :--------: | :--------: | :--------: |
| 多机"谁空着"看板   |    是    |     否     |    是      |     否     |
| DCGM + Prometheus  |    否    |     是     |   有限     |     否     |
| HPC 作业计费       |    否    |     是     |    是      |     是     |
| **本项目**         |  **是**  |   **是**   |  **是**    |   **否**   |

具体做法：中心机 SSH 进各台机跑 `nvidia-smi` / `rocm-smi` + `ps`，
用量按 `ps` 解析出的用户名归属到人（不需要 Slurm，也不需要 k8s），
原始样本进 SQLite 并做**两级预聚合**，任意时间窗的平均值都能秒回。

适合的场景：几台到几十台自管 GPU 机，没有统一调度器，需要一份**能拿去做扩容论证的长期数据**。
不适合的场景：上千节点的集群级遥测（那就该上 DCGM exporter），或者需要秒级告警。

## 功能

- **滚动平均利用率**：12h / 24h / 48h / 72h / 1w / 2w / 1m 任选，总览 / 集群 / 单机 / 单卡四级下钻。
- **按用户的 GPU 卡时排行**：同一用户名跨机器聚合，明细按算力域 → 集群 → 机器分组堆叠。
- **空占检测**：占着显存但 GPU 近期利用率 <5% 的卡单独标记，用来抓"占卡不算"的浪费。
- **NVIDIA + AMD (ROCm)**：厂商远端自动探测，也可在清单里写死（见下方 AMD 说明）。
- **多集群 / 算力域分组**：三层拓扑，配色按算力域自动分配色系，无需手工调色。
- **命名与标签全可配**：集群显示名、自定义标签（文字 + 前缀符号 + 悬停说明 + 语义色）都在清单里写。
- **日间 / 夜间双主题**；图表用**本地 ECharts**，不连外网 CDN，内网离线环境可用。
- **离线与掉卡感知**：主机超过在线阈值没采到即判离线，显示"离线"而不是上一次的陈旧占用值，
  也不计入当前均值和满载数；实际发现卡数少于清单期望卡数时在页面上标出。
- **软退役**：机器退租时标 `status: retired`，采集器停止探测、网页隐藏，但历史一行不删，日后可对账。

## 架构

```
被监控节点 (无需安装任何东西)
    ↑ ssh <alias> bash -s        ← 普通用户权限，脚本从 stdin 喂入，远端不落地文件
采集器 (collector)               ← 一次连接取全量：GPU / 进程 / CPU / 内存 / load
    ↓
SQLite (WAL) ─ 原始样本 ─→ 5 分钟聚合 ─→ 1 小时聚合
    ↓
FastAPI (/api/*) ─→ 原生 HTML + JS + 本地 ECharts (无构建步骤)
```

- **采集**：SSH 轮询（pull），默认 30s 一轮，并发上限可配。走系统 `ssh` 而不是 paramiko，
  为的是直接复用 `~/.ssh/config` 的别名、`ProxyJump`、密钥和 known_hosts——
  代码里不出现任何 IP、端口、密码或私钥，换部署机只改 ssh config。
  远端只用到 coreutils、厂商 smi 和 `ps`。
- **存储**：SQLite + WAL。原始样本 + 5 分钟 / 1 小时两级预聚合。查询按窗口选表：
  ≤24h 走 5 分钟桶，>24h 一律走 1 小时桶（见 `src/gpumon/db/store.py` 的
  `WINDOWS` 和 `pick_table()`），所以 1 个月的均值也不会去扫原始表。
  聚合由采集循环增量推进（5 分钟桶每分钟一次、1 小时桶每 5 分钟一次），保留清理每小时一次。
- **后端**：FastAPI，纯 JSON 接口 + 把 `web/` 当静态站点 serve。
- **前端**：原生 HTML/JS，无打包、无 node_modules，改完刷新即生效。

一个有意的取舍：**GPU 卡上的大字是"近期利用率"**（最近 10 分钟均值，附"连续 3 次采样 ≤5%
即置零"），用来抹平训练步之间 0/100 的瞬时抖动，同时任务一停就立刻显示空闲；
小字"均 XX"才是所选时间窗的长期均值。真瞬时值只留在 tooltip 和单卡详情页。

利用率颜色是**语义色**，红满载 → 橙 → 黄 → 绿在用 → 灰空闲固定表意（阈值见
`web/js/components.js` 的 `utilColor`）；算力域和集群用的是**家族色**（`Palette`
的 8 条内置色带：lime / violet / azure / amber / rose / teal / indigo / slate），
只表达"这是哪个域/哪个集群"，两套色不互相干扰。色带用尽后按黄金角生成新色相，
第 9 个域及以后也各不相同、不会撞成灰色。

## 环境要求

- **中心机**：Python 3.12+、`ssh` 客户端。推荐用 [uv](https://docs.astral.sh/uv/) 管理依赖。
- **被监控节点**：`bash`、`nvidia-smi`（或 `rocm-smi` / `amd-smi`）、`ps`、coreutils。
  一个能免密登录的普通账号即可，**不需要 root，不装任何东西**。

## 快速开始

```bash
git clone <this-repo>
cd cluster-gpu-monitor
uv sync

cp config/inventory.example.yaml config/inventory.yaml   # 填你的机器
cp config/settings.example.toml  config/settings.toml    # 采集周期、保留天数等

uv run gpumon config-check     # 校验配置：打印算力域/集群/机器/期望卡数与色带分配
uv run gpumon initdb           # 建库 + 同步拓扑
uv run gpumon collect --once   # 试采一轮（可加 --host <key> 只采一台）
uv run gpumon web              # 起网页 http://127.0.0.1:8848/
```

前提是中心机的 `~/.ssh/config` 里已有 inventory 中 `ssh_alias` 对应的条目，且能免密登录。
先用 `ssh <alias> true` 确认一遍，再跑 `collect --once`。

其余子命令：`gpumon rollup-once` 手动跑一次聚合 + 保留清理（采集器常驻时会自动做）。

生产部署要跑两个进程：`gpumon collect`（常驻轮询）和 `gpumon web`。
`web` 默认只监听 `127.0.0.1`，**自身不带任何认证**——对外暴露请务必在前面放一层反向代理
并加上鉴权（`deploy/` 下有 systemd 与 Caddy 的模板）。

## 配置

两个文件，都不入库（已在 `.gitignore`）：

- `config/inventory.yaml` — 机器清单，**整个系统的唯一事实来源**。
- `config/settings.toml` — 运行参数：采集周期、SSH 超时、并发、保留天数、DB 路径、监听地址、
  是否对用户名打码（`mask_users = true` 时网页显示成 `a***e`）。

逐字段说明、色带清单、标签写法、`status` 语义与保留天数的坑见
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)。

### 三层拓扑

层级固定为三层，网页分组、统计表、排行、配色全部按它自适应，**加机器不用改代码**：

```
算力域 capacity_group      自有 / 租用 / 合作 …… 你自己定义，一个域一套色系
└── 集群 cluster           一批机器 + 集群级标签
    └── 服务器 host        对应 ~/.ssh/config 里一个别名
```

```yaml
capacity_groups:
  - { key: own, name: "自有算力", sort_order: 1, palette: lime }

clusters:
  - key: cluster-a
    name: "A 集群"
    capacity_group: own
    badges:
      - { text: "自建", mark: "◆", tone: cyan, tooltip: "本地装机，账号自助申请" }
      - { text: "InfiniBand", tone: green }
    hosts:
      - { key: node-1, ssh_alias: my-node-1, display_name: "Node-1",
          meta: { gpu_model: "NVIDIA A100 80GB" } }
```

几个关键约定：

- **`key` 一旦上线就别改**，历史数据按它关联；换部署机时只改 `ssh_alias`，
  `key` 不变，历史曲线就是连续的。
- `palette` 可留空，按算力域的 `sort_order` 自动轮转分配色系。
- `gpu_count` 是期望卡数，用于断卡 / 掉线检测，缺省取 `defaults.gpu_count`。
- `vendor` 留空即远端自动探测（`nvidia-smi` → `amd-smi` → `rocm-smi`），只有探测判错才需要写死。
- `status`：`active` / `planned`（待接入，网页显示占位卡）/ `retired`（软退役）。
- `badges` 挂多枚会在集群卡片标题上显示，超过 3 枚折叠成 "+N"；
  `tone` 只接受预设语义色名（cyan / gold / green / violet / neutral）。

改完清单重启采集器即可（自动 upsert 拓扑、首轮发现 GPU）。
`gpumon config-check` 会把最终生效的域、色带、集群、机器和合计卡数打出来，上线前先跑一遍。

### 保留策略

`[retention]` 三个数字，各管一层：

| 项目 | 默认 | 说明 |
| --- | --- | --- |
| `raw_days` | 31 | 原始样本。**必须 ≥ 最长时间窗 + 余量**，否则 1 月的用户排行会少算 |
| `rollup_5m_days` | 30 | 5 分钟聚合，供 ≤24h 窗口 |
| `rollup_1h_days` | 400 | 1 小时聚合，供 >24h 窗口 |

注意**用户排行扫的是原始进程样本**，所以它的覆盖范围受 `raw_days` 限制，
而利用率曲线和均值走聚合表、不受影响。

## AMD (ROCm) 支持状态

需要说清楚：AMD 这条路径是**按 `rocm-smi` / `amd-smi` 的官方文档输出格式实现的，
并用构造样本做了单元测试，但截至目前尚未在真实 AMD 硬件上验证过**。
NVIDIA 路径是长期在线跑的。

已知的实现取舍：远端只把 smi 的原始 JSON 整段转发回来，解析全在 Python 侧做
（`src/gpumon/collector/parse_amd.py`），字段按 key 名在嵌套结构里模糊匹配、
单位统一归一——因为 amd-smi 的字段名和嵌套层级跨 ROCm 小版本改过多次。
`rocm-smi` 的进程 → GPU 映射依赖 `--showpidgpus`，部分版本没有这个选项，
拿不到时进程会关联不上具体卡。

如果你手上有 AMD 机器，欢迎跑一下 `scripts/probe_one.sh <alias>` 把原始输出贴到 issue 里，
或者直接提 PR 修字段名。

## 开发

```bash
uv run --extra dev pytest        # 解析、聚合、清单校验、软退役的单元测试
scripts/probe_one.sh <alias>     # 只看某台机的原始探测输出，排查解析问题
scripts/verify_e2e.sh            # 采一轮 → 聚合 → 校验库内数据与各 API 端点
```

- 后端 `src/gpumon/`：`collector/` 采集与解析、`db/` 存储与聚合、`api/` 接口。
- 前端 `web/`：原生 HTML + JS + 本地 ECharts，无构建步骤。
- 代码注释是中文。

## 部署

systemd + 反向代理的完整步骤、目录布局和运维命令见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)，
模板在 `deploy/`（systemd unit 与 Caddyfile 示例）。

再强调一次：`gpumon web` 自身没有认证，对外一定要经反代加鉴权。

## 许可

[MIT](LICENSE)
