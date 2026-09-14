# v0.5.0 — 主机心跳与 GPU 慢查询保护

GPU 查询明显延迟时，主机继续显示在线，并以“疑似过载”提示采集降级。默认 GPU 阶段达到
10 秒或失败后，仅该机改为至少 60 秒一次；连续 3 次有效查询小于 5 秒后恢复正常频率。

## 变更

- 主机心跳、GPU 指标、进程结果独立保存，远端查询增加超时与互斥保护。
- 常规 NVIDIA 查询减少至每轮两次，冷却和厂商识别结果可跨 collector 重启恢复。
- 页面与摘要 API 统一正常、过载、恢复、采集异常、离线和未知状态；旧值不计入空闲。
- 使用采样权重计算均值、覆盖率与 GPU·小时，保留原始样本数和缺失区间。
- 合成 demo 包含慢查询、超时、恢复与离线示例，导出时钟与状态一致。
- 修复窄屏卡片裁切、时间轴标签重叠和单机调试脚本的新协议占位符，同步中英文文档。

## 升级注意

目标节点需要 `timeout` 与 `flock`。旧 settings 可直接使用默认值。新 Web 启动前先备份，
用新代码执行 `gpumon initdb`；数据库仅添加表和可空列。摘要新增 `health`，`online` 表示
主机心跳仍有效，不能等同于 GPU 数据有效或 GPU 空闲。

完整配置、锁文件、统计和回滚说明：[中文](ADAPTIVE_PROBING.md) · [English](ADAPTIVE_PROBING.en.md)。

## 验证

209 项核心回归通过，包含本地故障注入、变频统计、真实 Caddy 代理集成、demo 导出和调试
脚本；保留 1 条既有依赖弃用警告。所有故障注入与 demo 数据均为合成，不依赖真实 GPU。

## English

Hosts remain online when GPU telemetry stalls. Slow queries enter per-host cooldown (60 seconds by
default), with orange UI indicators and three fast successes required for recovery. Host, GPU and
process results are independent; unknown observations are never counted as idle. Sampling weights
preserve variable-cadence statistics, and the synthetic demo exercises the real status paths.

Upgrade the additive schema before starting the new read-only Web process. Targets require timeout
and flock. The summary adds `health`; `online` now describes host reachability independently of GPU
query success. See the linked guide for timing, dependencies and rollback semantics.
