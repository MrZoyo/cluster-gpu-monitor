#!/usr/bin/env bash
# Stream completed host/GPU/process sections independently; only a private lock
# file is retained on the target. No telemetry, script or credentials are stored.
export LC_ALL=C

echo "##META"
date +%s
hostname
nproc

echo "##LOADAVG"
cat /proc/loadavg

echo "##MEMINFO"
grep -E '^(MemTotal|MemAvailable):' /proc/meminfo   # 单位 kB

echo "##CPU1"
grep '^cpu ' /proc/stat
sleep __CPU_GAP__
echo "##CPU2"
grep '^cpu ' /proc/stat

echo "##HOST_END"


if [ "__GPU_ENABLED__" != "1" ]; then
  echo "##GPU_SKIPPED"
  echo "##END"
  exit 0
fi

gpu_probe() {
  local VENDOR="__VENDOR_HINT__" PIDS="" APPS="" rc=0
  # Detection runs only until a vendor is confirmed. Later probes reuse it.
  if [ -z "$VENDOR" ]; then
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then VENDOR=nvidia
    elif command -v amd-smi >/dev/null 2>&1 && amd-smi list >/dev/null 2>&1; then VENDOR=amd
    elif command -v rocm-smi >/dev/null 2>&1 && rocm-smi --showid >/dev/null 2>&1; then VENDOR=amd
    else VENDOR=none; fi
  fi
  echo "##VENDOR"
  echo "$VENDOR"
  if [ "$VENDOR" = none ]; then return 69; fi
  if [ "$VENDOR" = nvidia ]; then
    echo "##GPU"
    nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw \
      --format=csv,noheader,nounits
    rc=$?
    echo "##GPU_END"
    echo "$rc"
    if [ "$rc" != 0 ]; then return "$rc"; fi
    # Reuse this result for PID mapping. Bound the remote shell variable as well.
    APPS=$(set -o pipefail; nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits | head -c __OUTPUT_LIMIT__)
    rc=$?
    echo "##APPS"
    printf '%s\n' "$APPS"
    if [ "$rc" != 0 ] || [ "${#APPS}" -ge __OUTPUT_LIMIT__ ]; then return 70; fi
    PIDS=$(printf '%s\n' "$APPS" | cut -d, -f2 | tr -d ' ' | grep -E '^[0-9]+$' | sort -u | paste -sd,)
else
  # amd-smi（ROCm 6+，rocm-smi 的继任者）优先；两者都吐原始 JSON 给 Python 解析。
  # static 拿 uuid/型号，metric 拿利用率/显存/温度/功耗，process 拿每卡进程。
  if command -v amd-smi >/dev/null 2>&1; then
    echo "##AMDSMI_STATIC"
    amd-smi static --json 2>/dev/null
    echo "##AMDSMI_METRIC"
    amd-smi metric --json 2>/dev/null
    echo "##AMDSMI_PROCESS"
    amd-smi process --json 2>/dev/null
  fi
  if command -v rocm-smi >/dev/null 2>&1; then
    # 老 ROCm 的回退路径。--showmeminfo vram 给的是字节，Python 侧换算成 MiB。
    echo "##ROCMSMI_JSON"
    rocm-smi --showid --showproductname --showuniqueid --showuse --showmemuse \
      --showmeminfo vram --showtemp --showpower --json 2>/dev/null
    # 进程→GPU 的映射：--showpidgpus 在部分版本才有，拿不到就只能留空（见 parse.py 注释）
    echo "##ROCMSMI_PIDS"
    rocm-smi --showpids --json 2>/dev/null
    echo "##ROCMSMI_PIDGPUS"
    rocm-smi --showpidgpus 2>/dev/null
  fi

  PIDS=$( { amd-smi process --json 2>/dev/null; rocm-smi --showpids 2>/dev/null; } \
    | grep -oE '"?(pid|PID)"?[":= ]+[0-9]+' | grep -oE '[0-9]+$' | sort -u | paste -sd,)
fi

echo "##PSMAP"
if [ -n "$PIDS" ]; then
  # user:32 —— 必须显式给宽度：`user=` 默认列宽 8，超长用户名会被 ps 截成
  # "superno+"（+ 是 ps 自己加的截断标记），落库后同一个人被当成两个用户。
  # -w/-ww 只放宽整行（对 args 列有效），不影响 user 列宽，不能替代此写法。
  ps -o pid=,user:32=,comm= -p "$PIDS" 2>/dev/null
fi


  echo "##APPS_END"
  echo "0"
}

# flock is nonblocking. The inherited FD stays locked even when a driver call
# outlives its SSH session; a later probe must not pile another query onto it.
rc=0
if ! command -v timeout >/dev/null || ! command -v flock >/dev/null; then
  rc=69
else
  lock_dir="${XDG_RUNTIME_DIR:-/tmp}/gpumon-${UID}"
  if ! (umask 077; mkdir -p -- "$lock_dir") || [ -L "$lock_dir" ] ||
     [ ! -O "$lock_dir" ] || [ "$(stat -c %a -- "$lock_dir")" != 700 ]; then
    rc=73
  elif ! exec 9>"$lock_dir/gpu-probe.lock"; then
    rc=73
  elif ! flock -n 9; then
    rc=75
  fi
fi

echo "##GPU_BEGIN"
started=$(date +%s%N)
if [ "$rc" = 0 ]; then
  # Separate process group; TERM then KILL, including our query children.
  timeout -k 2 __GPU_TIMEOUT__ bash -c "$(declare -f gpu_probe); gpu_probe"
  rc=$?
fi
elapsed_ms=$(( ($(date +%s%N) - started) / 1000000 ))
[ "$elapsed_ms" -ge 0 ] || elapsed_ms=0
echo "##GPU_DONE"
printf '%s %s.%03d\n' "$rc" "$((elapsed_ms / 1000))" "$((elapsed_ms % 1000))"
echo "##END"
