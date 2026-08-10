"""SSH 子进程 IO 边界：stdout/stderr 共用预算，异常与超时都必须回收进程。"""
from __future__ import annotations

import asyncio
import sys

import pytest

from gpumon.collector.ssh import OutputLimitExceeded, _communicate_limited


async def _spawn_python(code: str) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        code,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


def test_communicate_limited_collects_normal_stdout_and_stderr():
    async def run():
        proc = await _spawn_python(
            "import sys; data=sys.stdin.buffer.read(); "
            "sys.stdout.buffer.write(data.upper()); sys.stderr.write('warning')"
        )
        out, err = await _communicate_limited(proc, b"probe", 64 * 1024)
        assert out == b"PROBE"
        assert err == b"warning"
        assert proc.returncode == 0

    asyncio.run(run())


def test_stdout_and_stderr_share_one_budget_and_excess_process_is_reaped():
    async def run():
        proc = await _spawn_python(
            "import sys; "
            "sys.stdout.buffer.write(b'x' * 50000); sys.stdout.buffer.flush(); "
            "sys.stderr.buffer.write(b'y' * 50000); sys.stderr.buffer.flush()"
        )
        with pytest.raises(OutputLimitExceeded):
            await _communicate_limited(proc, b"", 64 * 1024)
        assert proc.returncode is not None

    asyncio.run(run())


def test_cancellation_reaps_subprocess():
    async def run():
        proc = await _spawn_python("import time; time.sleep(60)")
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(
                _communicate_limited(proc, b"", 64 * 1024), timeout=0.1
            )
        assert proc.returncode is not None

    asyncio.run(run())
