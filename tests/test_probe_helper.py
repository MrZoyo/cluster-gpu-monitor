"""The debug helper must render the same protocol placeholders as the collector."""
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_debug_helper_renders_gpu_stage_and_rejects_invalid_inputs(tmp_path):
    ssh = tmp_path/'ssh'
    ssh.write_text('#!/bin/sh\ncat\n')
    ssh.chmod(0o755)
    env = {**os.environ, 'PATH':str(tmp_path)+':'+os.environ['PATH']}
    result = subprocess.run(['bash',str(ROOT/'scripts/probe_one.sh'),'example-node','1','nvidia'],
        env=env,capture_output=True,text=True,timeout=5)
    assert result.returncode == 0
    assert '__GPU_ENABLED__' not in result.stdout and '__GPU_TIMEOUT__' not in result.stdout
    assert '__OUTPUT_LIMIT__' not in result.stdout and 'timeout -k 2 20' in result.stdout
    for args in [['-oProxyCommand=bad'],['host','bad'],['host','1','bad;command']]:
        invalid = subprocess.run(['bash',str(ROOT/'scripts/probe_one.sh'),*args],env=env,
            capture_output=True,text=True,timeout=5)
        assert invalid.returncode == 2 and not invalid.stdout
