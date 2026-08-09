"""解析层测试：覆盖正常字段、[N/A]、进程映射、CPU 差分、截断输出。"""
from pathlib import Path

from gpumon.collector.parse import parse_probe

FIXTURE = (Path(__file__).parent / "fixtures" / "probe_sample.txt").read_text()


def test_parse_basic():
    r = parse_probe("hx", FIXTURE)
    assert r.ok is True
    assert r.remote_hostname == "node-test"
    assert r.host.ncpu == 192
    assert r.host.load1 == 12.0
    # MemTotal 2097152kB=2048MiB, avail 1048576kB=1024MiB, used=1024
    assert r.host.mem_total_mib == 2048
    assert r.host.mem_avail_mib == 1024
    assert r.host.mem_used_mib == 1024


def test_parse_cpu_util():
    # idle_a=1020 tot_a=1175 ; idle_b=1730 tot_b=2040 ; util=100*(1-710/865)=17.9
    r = parse_probe("hx", FIXTURE)
    assert abs(r.host.cpu_util_pct - 17.9) < 0.2


def test_parse_gpus_and_na():
    r = parse_probe("hx", FIXTURE)
    assert len(r.gpus) == 2
    g0, g1 = r.gpus
    assert g0.uuid == "GPU-aaa" and g0.util_gpu == 100 and g0.power_w == 350.5
    assert g0.mem_used_mib == 81000 and g0.mem_total_mib == 81559 and g0.temp_c == 65
    assert g1.power_w is None          # [N/A] -> None
    assert g1.util_gpu == 0


def test_parse_proc_user_mapping():
    r = parse_probe("hx", FIXTURE)
    assert len(r.procs) == 1
    p = r.procs[0]
    assert p.gpu_uuid == "GPU-aaa" and p.pid == 12345
    assert p.username == "alice" and p.comm == "python" and p.mem_used_mib == 80000


def test_parse_long_username_padded():
    """remote_probe 用 `user:32=` 定宽输出，长用户名后跟大量空格填充。
    split(None, 2) 必须吸掉填充，且不能把用户名截短（历史 bug：ps 默认列宽 8
    → "superno+"）。"""
    raw = FIXTURE.replace("12345 alice python",
                          "  12345 supernove" + " " * 24 + "python")
    r = parse_probe("hx", raw)
    assert r.procs[0].username == "supernove"
    assert r.procs[0].comm == "python"


def test_parse_truncated_is_not_ok():
    raw = "\n".join(FIXTURE.splitlines()[:-1])   # 去掉 ##END
    r = parse_probe("hx", raw)
    assert r.ok is False and "截断" in r.error


def test_parse_empty_apps():
    raw = FIXTURE.replace("GPU-aaa, 12345, 80000\n", "").replace(
        "12345 alice python\n", "")
    r = parse_probe("hx", raw)
    assert r.ok is True and len(r.procs) == 0 and len(r.gpus) == 2
