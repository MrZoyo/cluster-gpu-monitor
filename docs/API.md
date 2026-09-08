# GPU 近期利用率 API

简体中文 | [English](API.en.md) | [文档目录](README.md)

`GET /api/v1/gpu-summary` 一次返回所有未退役机器的近期 GPU 利用率，供脚本和 agent 查询。
接口没有查询参数。运维人员可以按下文只将这个 GET 端点开放为匿名访问；默认的带认证反向
代理配置仍会保护它。

```bash
curl --fail-with-body --silent --show-error --max-time 15 \
  "https://YOUR_MONITOR_DOMAIN/api/v1/gpu-summary"
```

以下是虚构示例，所有时间均为 Unix epoch 秒，GPU 下标从 0 开始：

```json
{
  "as_of": 1788850000,
  "server_time": 1788850004,
  "window_s": 600,
  "poll_interval_s": 30,
  "cache_ttl_s": 30,
  "hosts": [{
    "name": "Node A",
    "online": true,
    "gpus": [
      {"index": 0, "model": "Example GPU", "util_recent_pct": 0.0, "sampled_at": 1788849980},
      {"index": 1, "model": "Example GPU", "util_recent_pct": 82.5, "sampled_at": 1788849980},
      {"index": 2, "model": null, "util_recent_pct": null, "sampled_at": null}
    ]
  }]
}
```

## 指标与时间

- `util_recent_pct` 与网页 GPU 卡片使用同一个计算函数：最近 600 秒有效原始样本的均值；
  最近连续 3 个有效样本均 ≤5% 时直接归零。它不是显存占用率，也不表示 GPU 已可分配。
- `as_of` 是本次共享快照的计算时间；`server_time` 是当前响应时间。`sampled_at` 是
  对应 GPU 最新采样时间。采样周期可能与轮次实际耗时不同。
- 所有客户端共用最多 30 秒的进程内缓存。缓存命中不查询数据库；刷新只查拓扑、GPU 样本
  时间、10 分钟利用率和采集状态，不查询进程或长期历史聚合。
- 主机仅在 active 且最近成功采集不超过 120 秒时为 `online=true`。GPU 样本需同时不超过
  `max(120, 4 × poll_interval_s)` 秒，否则利用率为 `null`。每次响应都会重新检查时效，
  即使快照仍在缓存期内。
- `null` 表示未知、过期或尚未采到，不是 0%。预期但未探测到的 GPU 也保留未知条目；
  退役机器按网页的拓扑规则移除。非 active 机器不下发当前利用率。
- 响应字段按白名单构造，不包含用户、进程、显存、SSH alias、地址、硬件 UUID、备注或错误详情。
  机器显示名和 GPU 型号属于公开内容。

## 限流与重试

每个来源 IP，两次成功响应至少间隔 10 秒。超限返回 HTTP 429 和剩余等待秒数
`Retry-After`；被拒绝的请求不会延长冷却期。同一出口的多个 agent 共享额度。

所有响应禁止 HTTP 共享缓存，以确保请求经过限流检查；这里的 30 秒缓存位于应用进程内。
缓存刷新并发合并为一次查询，等待最多 1 秒。查询失败、等待超时或 4096 个未过期 IP 名额
已满时，返回不含内部细节的 HTTP 503 和 `Retry-After: 10`；失败不消耗成功请求额度，
也不会退回已过期的快照。未知参数为 HTTP 400，非 GET 请求为 HTTP 405（反向代理可能先
要求认证）。

该限流和缓存在 `gpumon web` 的单个进程内生效；进程重启后重置。不要为这个入口启动多个
独立 Web worker，否则无法保证跨 worker 的间隔。IPv4 及其 IPv4-mapped IPv6 表示共用额度。
实际客户端应按采集周期查询，并在 429/503 时遵守 `Retry-After`。

## 开放匿名摘要

先部署支持该接口的代码，再有选择地调整 Caddy。以下示例适用于后端监听
`127.0.0.1:8848` 的原生部署。将 [public-summary.caddy](../deploy/caddy/public-summary.caddy)
放在 Caddy 可读位置，在全局选项块之后、站点块之外导入，然后修改目标站点：

```caddyfile
import /etc/caddy/public-summary.caddy

YOUR_MONITOR_DOMAIN {
    import gpumon_summary_access
    basic_auth @gpumon_private {
        team {$GPUMON_BASIC_HASH}
    }
    import gpumon_summary_proxy
}
```

保留站点已有的 HTTPS、安全头、日志和 `Cache-Control: no-store` 配置。Caddy 2.6/2.7
将 `basic_auth` 写成 `basicauth`。只有精确路径 `GET /api/v1/gpu-summary` 豁免认证，
网页和其他 API 仍需认证；不要对整个 `/api/*` 豁免。

代理片段会先覆盖客户端提供的来源头，仅在 TCP 对端属于列出的 Cloudflare 网段时采用
`CF-Connecting-IP`，然后向 Uvicorn 传递一个确定的来源地址。`gpumon web` 只信任来自
loopback 的代理头。后端端口必须保持仅本机可达；其他代理拓扑需另外核验可信跳点。
Cloudflare 网段来自其官方 IPv4/IPv6 列表，变动时需更新片段。

若 Cloudflare 另有拦截规则，需确认这个精确端点可供普通 HTTP 客户端访问，并在边缘保留
适当的流量保护。Cloudflare 的计数可能有延迟，应用负责执行 10 秒间隔。发布后串行验证：
首次匿名请求为 200，立即重复为 429，按 `Retry-After` 等待后恢复 200；其他 API 仍拒绝
未认证访问。还需测试伪造转发头不会改变请求者身份。

开放匿名接口意味着任何人都能持续获取这份摘要。公开核心和文档只保存通用代码与虚构例子；
真实域名、显示名称和发布记录应由部署方管理。
