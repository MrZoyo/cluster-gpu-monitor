# 配置参考

两个文件，都在 `config/` 下，都**不入库**（`.gitignore` 已排除）：

| 文件 | 管什么 | 改完要做什么 |
| --- | --- | --- |
| `inventory.yaml` | 有哪些机器、怎么分组、怎么显示 | `systemctl restart gpumon-collector`（退役机器再加 `gpumon-web`） |
| `settings.toml` | 采集周期、保留天数、端口、隐私 | 重启对应服务（采集参数→collector，端口→web） |

先从样例复制：

```bash
cp config/inventory.example.yaml config/inventory.yaml
cp config/settings.example.toml config/settings.toml
uv run gpumon config-check          # 任何改动后都先跑这个
```

`config-check` 会把最终生效的算力域、色带分配、每个集群的标签、每台机的期望卡数
全部打印出来。**配错了在这一步就能看见**，不用等网页。

---

## inventory.yaml

### 三层拓扑

层级是固定的三层，只要按这个结构填，网页、统计表、排行、配色全部自适应：

```
算力域 (capacity_group)     ← 最粗的分组，比如"自有" / "租用" / "某合作方"
  └─ 集群 (cluster)          ← 一批机器，通常同机房 / 同一批采购 / 同一个跳板
       └─ 服务器 (host)      ← 一台物理机
            └─ GPU           ← 首轮采集自动发现，不用手写
```

GPU 不需要在配置里声明——采集器第一次连上就会把卡的 UUID、型号、显存写进库。
你只需要填 `gpu_count` 作为**期望值**，用于"掉卡"检测。

### 最小可用配置

```yaml
version: 1

clusters:
  - key: my-cluster
    name: "我的集群"
    hosts:
      - { key: node-1, ssh_alias: node-1, display_name: "节点 1" }
```

没写 `capacity_groups`、没写 `capacity_group` 也能跑——会落到一个中性的兜底域
（默认叫"未分组"，名字可改，见 `defaults`）。

### 顶层字段

```yaml
version: 1                    # 配置格式版本，固定 1

defaults:
  gpu_count: 8                # 主机没写 gpu_count 时用这个
  poll_interval_s: 30         # 兼容字段；实际采集周期以 settings.toml 为准
  fallback_group_key: default     # 集群没写 capacity_group 时归到哪个域
  fallback_group_name: "未分组"    # 该兜底域在网页上的显示名
```

### capacity_groups（算力域）

```yaml
capacity_groups:
  - key: own                  # 稳定标识，集群通过它引用
    name: "自有算力"          # 网页显示名，随便改
    sort_order: 1             # 排序，小的在前
    palette: lime             # 可选：指定色系
    description: "自购自管"   # 可选：显示在域标题下
```

**palette 可以不写。** 不写就按 `sort_order` 从内置色带里轮转分配，
保证每个域都有独立可辨的色系。内置八条：

| 色带 | 色调 | 色带 | 色调 |
| --- | --- | --- | --- |
| `lime` | 黄绿 → 绿 → 青蓝 | `rose` | 玫红 → 紫红 |
| `violet` | 品红 → 紫罗兰 | `teal` | 松绿 → 青 |
| `azure` | 青 → 宝蓝 | `indigo` | 靛蓝 → 群青 |
| `amber` | 琥珀 → 赭橙 | `slate` | 中性灰蓝 |

超过 8 个域也没问题：前端会按黄金角生成新色相，不会退化成一片灰。

色带内部还有两级区分：**同域的不同集群沿色带铺开色相，同集群的不同机器拉明度**。
所以一眼就能看出"这几台是一个集群的"。

> 利用率的红/橙/黄/绿/灰是**语义色**，含义固定，和算力域家族色是两套体系，互不干扰。

### clusters（集群）

```yaml
clusters:
  - key: cluster-a            # 稳定标识，历史按它关联，上线后别改
    name: "A 集群"            # 显示名，随时可改
    sort_order: 1
    capacity_group: own       # 引用上面的域 key；留空 = 兜底域
    status: active            # active / planned / retired
    note: "备注，显示在集群条下方"
    jump: bastion-a           # 仅元数据，记录该集群走哪个跳板，不参与逻辑
    badges: [...]             # 见下节
    hosts: [...]
```

### badges（自定义标签）

挂在集群标题上的小胶囊，用来标注任何你想强调的属性：

```yaml
    badges:
      - text: "自建"                     # 必填
        mark: "◆"                        # 可选：前缀符号
        tone: cyan                       # 可选：cyan/gold/green/violet/neutral
        tooltip: "本地装机，账号自助申请"  # 可选：悬停说明
      - { text: "InfiniBand", tone: green }
      - { text: "ROCm", tone: gold, tooltip: "需要 ROCm 版框架" }
```

- 一个集群可挂任意多枚，**超过 3 枚自动折叠成 `+N`**，悬停展开完整列表。
- `tone` 只接受这五个预设名，不接受任意 CSS 色值——这是有意的，防止标签色和
  利用率语义色/算力域家族色撞在一起。

**兼容写法** `configured_by: "运维组"` 等价于加一枚 `{ mark: "◆", text: "运维组 配置" }`，
老配置不用改也能跑。两种写法可以共存，`configured_by` 合成的那枚排最前。

### hosts（服务器）

```yaml
    hosts:
      - key: node-1                    # 稳定标识，历史按它关联，上线后别改
        ssh_alias: my-node-1           # ~/.ssh/config 里的别名
        display_name: "节点 1"         # 显示名，随时可改
        gpu_count: 8                   # 期望卡数，缺省取 defaults
        status: active                 # active / planned / retired
        vendor: amd                    # 可选，留空=自动探测
        note: "备注"
        meta:
          gpu_model: "AMD Instinct MI300X"   # 待接入占位卡上显示的型号
```

`key` 和 `ssh_alias` 的分工很关键：

- **`key` 是历史的锚点**，库里所有采样都挂在它上面，**永远不要改**。
- **`ssh_alias` 是怎么连上去**，可以随时改。换部署机、加跳板、改 IP，
  只改 ssh config 和这个字段，`key` 不动 → **历史曲线连续不断**。

### status 的三个值

| 值 | 采集器 | 网页 | 数据库 | 用在什么时候 |
| --- | --- | --- | --- | --- |
| `active` | 正常探测 | 正常显示 | 正常写入 | 默认 |
| `planned` | 不探测 | 显示占位卡（灰色 `--`） | 无 | 机器还没到 / 还没拿到权限，先把位置占上 |
| `retired` | 停止探测 | 整台隐去 | **历史一行不删** | 机器退租下架 |

**退役机器不要从 inventory 里删条目。** 删了配置、库里的历史行还在，
网页反而会挂一张永久离线的幽灵卡。标 `retired` 才是正确做法：
采集器不再连它，网页各处（总览 / 集群页 / 主机页 / 健康灯 / 使用人排行）都不再出现它，
但历史数据完整保留，日后要对账随时能查。

标完 `retired` 需要重启**两个**服务：`gpumon-collector`（停止探测）和
`gpumon-web`（清掉 inventory 的缓存）。

### vendor 与 AMD

`vendor` 留空时，远端探测脚本按顺序试 `nvidia-smi` → `amd-smi` → `rocm-smi`，
哪个真能跑通就用哪个。只有自动探测判错时才需要显式写：

```yaml
      - { key: amd-1, ssh_alias: amd-1, display_name: "AMD-1", vendor: amd }
```

典型的需要写死的场景：机器装了 NVIDIA 驱动包但卡是 AMD 的，
或者装了驱动但当前没有可用卡导致探测结果不稳。

> AMD 支持是按 `rocm-smi` / `amd-smi` 的官方输出格式实现并用构造样本做了单测的，
> **尚未在真实 AMD 硬件上验证**。接第一台 AMD 机器时，建议先跑
> `./scripts/probe_one.sh <alias>` 看原始输出，确认 `##VENDOR` / `##AMDSMI_*` 段有内容。

---

## settings.toml

```toml
[collector]
poll_interval_s = 30        # 每轮采集间隔。也是 GPU·小时的计量粒度
ssh_connect_timeout_s = 8   # SSH 建连超时
ssh_total_timeout_s = 20    # 单台机一轮的整体超时（含远端 sleep）
max_concurrency = 8         # 同时 SSH 几台。机器多可以调大，注意跳板机承受能力
cpu_sample_gap_s = 1        # 远端两次读 /proc/stat 的间隔，用于算 CPU 利用率

[retention]
raw_days = 31               # 原始样本保留天数
rollup_5m_days = 30         # 5 分钟聚合保留天数
rollup_1h_days = 400        # 1 小时聚合保留天数

[db]
path = "data/gpumon.db"     # 相对项目根

[web]
host = "127.0.0.1"          # 反代后面就保持 127.0.0.1；要直接访问改 0.0.0.0
port = 8848

[privacy]
mask_users = false          # true 时使用人显示成 a***e
```

### 保留天数怎么定（有个坑）

三张表各管一段时间范围，查询时按窗口自动选表：

- **≤24h 的窗口**走 5 分钟聚合表
- **>24h 的窗口**走 1 小时聚合表（不碰原始表，所以长窗口也很快）
- **使用人排行扫原始 `sample_proc` 表**

最后这条是坑所在：**`raw_days` 必须 ≥ 你想用的最长时间窗 + 余量**。
默认 `raw_days = 31` 刚好覆盖 1 月窗口（30 天）。如果把它调小到比如 7 天，
那么"近 1 月使用人排行"只会统计到最近 7 天的数据，**不报错，但数字偏小**。

`rollup_1h_days` 同理要大于最长窗口，默认 400 天留了充足余量。

### 并发与跳板

`max_concurrency` 是同时发起的 SSH 数。机器多的时候想调大，但要注意：
如果这些机器都走同一个跳板，跳板的 `MaxSessions` / `MaxStartups` 会先成为瓶颈，
表现是部分机器随机超时。稳妥做法是先小步调大（8 → 16），观察
`/api/collector/status` 里有没有新增的超时。

---

## 改完之后

| 改了什么 | 要做什么 |
| --- | --- |
| 加机器 / 加集群 / 改显示名 / 改标签 | `systemctl restart gpumon-collector` |
| 标了 `retired` | `systemctl restart gpumon-collector gpumon-web` |
| 改采集参数（周期 / 超时 / 并发） | `systemctl restart gpumon-collector` |
| 改端口 / 监听地址 / 隐私开关 | `systemctl restart gpumon-web` |
| 改保留天数 | 下次自动清理生效，或 `uv run gpumon rollup-once` |
| 只改了 `web/` 下的前端文件 | 什么都不用做，刷新浏览器即可 |

验证改动生效：

```bash
uv run gpumon config-check                      # 配置层面
curl -s 127.0.0.1:8848/api/collector/status     # 每台机在线 / 卡数 / 最近错误
curl -s 127.0.0.1:8848/api/health               # 最近一次采样多久之前
```
