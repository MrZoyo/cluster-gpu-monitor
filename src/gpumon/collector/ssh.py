"""通过系统 ssh 异步采集一台主机的原始探测输出。

为什么用系统 ssh 而非 paramiko：直接复用 ~/.ssh/config 的别名、ProxyJump、密钥、
known_hosts，代码里不出现任何 IP/端口/key。换部署机只需改 ssh config + inventory。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from ..config import load_settings
from ..models import ProbeResult
from .parse import parse_probe

_PROBE_TEMPLATE = Path(__file__).with_name("remote_probe.sh")


def _build_script(vendor_hint: str | None = None) -> str:
    gap = load_settings().collector.cpu_sample_gap_s
    # vendor 只允许白名单值：这段字符串会被塞进远端 shell 变量赋值，
    # 不做校验等于把 inventory 的任意内容送去远端执行。
    hint = vendor_hint if vendor_hint in ("nvidia", "amd") else ""
    return (_PROBE_TEMPLATE.read_text(encoding="utf-8")
            .replace("__CPU_GAP__", str(int(gap)))
            .replace("__VENDOR_HINT__", hint))


def _ssh_opts() -> list[str]:
    c = load_settings().collector
    return [
        "-o", "BatchMode=yes",
        "-o", f"ConnectTimeout={c.ssh_connect_timeout_s}",
        "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=2",
        "-o", "StrictHostKeyChecking=accept-new",
    ]


async def probe(host_key: str, ssh_alias: str, vendor: str | None = None) -> ProbeResult:
    """采集一台主机；任何失败都收敛成 ok=False 的 ProbeResult，绝不抛给上层。

    vendor 来自 inventory（可选）：给了就跳过远端自动探测，异构机房里更稳。
    """
    script = _build_script(vendor).encode()
    total_timeout = load_settings().collector.ssh_total_timeout_s
    argv = ["ssh", *_ssh_opts(), ssh_alias, "bash", "-s"]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except Exception as e:  # ssh 不存在等
        return ProbeResult(host_key=host_key, ok=False, error=f"启动 ssh 失败: {e}")

    try:
        out, err = await asyncio.wait_for(proc.communicate(script), timeout=total_timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
            await proc.wait()
        except ProcessLookupError:
            pass
        return ProbeResult(host_key=host_key, ok=False, error=f"超时(>{total_timeout}s)")
    except Exception as e:
        return ProbeResult(host_key=host_key, ok=False, error=f"ssh 异常: {e}")

    if proc.returncode != 0:
        msg = (err.decode(errors="replace").strip() or f"ssh 返回码 {proc.returncode}")
        return ProbeResult(host_key=host_key, ok=False, error=msg[:500])

    try:
        return parse_probe(host_key, out.decode(errors="replace"))
    except Exception as e:
        return ProbeResult(host_key=host_key, ok=False, error=f"解析失败: {e}")
