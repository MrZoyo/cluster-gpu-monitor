#!/usr/bin/env bash
# 调试：对单台机器跑一次远端探测，打印原始分段输出。
# 拿到新机器（尤其 AMD）时先跑这个，确认 ##VENDOR / ##GPU / ##APPS 段有内容再接入 inventory。
# 用法: scripts/probe_one.sh <ssh别名> [cpu间隔秒] [vendor:nvidia|amd]
set -euo pipefail
alias="${1:?用法: probe_one.sh <ssh别名> [cpu间隔秒] [vendor]}"
gap="${2:-1}"
vendor="${3:-}"          # 留空 = 让远端自动探测
[[ "$alias" =~ ^[A-Za-z0-9][A-Za-z0-9._:@%+-]*$ ]] || { echo '非法 SSH alias' >&2; exit 2; }
[[ "$gap" =~ ^[0-9]+$ && "$gap" -ge 1 && "$gap" -le 60 ]] || { echo 'CPU 间隔须为 1..60 秒' >&2; exit 2; }
[[ -z "$vendor" || "$vendor" == nvidia || "$vendor" == amd ]] || { echo '非法 GPU 厂商' >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sed -e "s/__CPU_GAP__/$gap/g" -e "s/__VENDOR_HINT__/$vendor/g" \
  -e "s/__GPU_ENABLED__/1/g" -e "s/__GPU_TIMEOUT__/20/g" -e "s/__OUTPUT_LIMIT__/4194304/g" \
  "$ROOT/src/gpumon/collector/remote_probe.sh" \
  | timeout -k 2 "$((8 + 10#$gap + 25))" ssh -o BatchMode=yes -o ConnectTimeout=8 "$alias" bash -s
