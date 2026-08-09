"""聚合层测试：加权聚合必须等于对原始样本的直接平均；窗口选表正确。"""
from gpumon.db.rollup import Rollup
from gpumon.db.store import Store, pick_table


def _setup(tmp_path):
    s = Store(path=tmp_path / "t.db")
    s.init_schema()
    conn = s.write_conn()
    with conn:
        conn.execute("INSERT INTO cluster(id,key,name,sort_order) VALUES(1,'cx','CX',1)")
        conn.execute("INSERT INTO host(id,cluster_id,key,ssh_alias,display_name,gpu_count) "
                     "VALUES(1,1,'hx','a','HX',2)")
        conn.execute("INSERT INTO gpu_card(id,host_id,gpu_index,uuid) VALUES(1,1,0,'U0')")
        conn.execute("INSERT INTO gpu_card(id,host_id,gpu_index,uuid) VALUES(2,1,1,'U1')")
    return s


def _ins(s, gpu_id, ts, util):
    s.write_conn().execute(
        "INSERT OR REPLACE INTO sample_gpu(gpu_id,ts,util_gpu) VALUES(?,?,?)", (gpu_id, ts, util))


def test_pick_table():
    assert pick_table(12 * 3600)[0] == "rollup_gpu_5m"
    assert pick_table(24 * 3600)[0] == "rollup_gpu_5m"
    assert pick_table(48 * 3600)[0] == "rollup_gpu_1h"
    assert pick_table(7 * 24 * 3600)[0] == "rollup_gpu_1h"


def test_weighted_avg_equals_raw_avg(tmp_path):
    s = _setup(tmp_path)
    base = (1_700_000_000 // 300) * 300       # 对齐 5m 桶
    # 桶1 三个样本 10/20/30；桶2 两个样本 100/100。原始 5 样本均值=52
    for i, u in enumerate([10, 20, 30]):
        _ins(s, 1, base + i * 30, u)
    for i, u in enumerate([100, 100]):
        _ins(s, 1, base + 300 + i * 30, u)
    s.write_conn().commit()
    now = base + 3600                          # 推到整点桶封口之后，1h 聚合才会处理

    r = Rollup(s)
    r.roll_gpu_5m(now)
    r.roll_gpu_1h(now)

    # 5m 表（12h 窗）加权均值
    a12 = s.get_avg("12h", "gpu", "util_gpu", now=now)
    got = next(it for it in a12 if it["gpu_id"] == 1)
    assert round(got["avg"]) == 52
    assert round(got["max"]) == 100

    # 1h 表（72h 窗）加权均值，应与原始一致
    a72 = s.get_avg("72h", "gpu", "util_gpu", now=now)
    got72 = next(it for it in a72 if it["gpu_id"] == 1)
    assert round(got72["avg"]) == 52


def test_host_scope_weighted(tmp_path):
    s = _setup(tmp_path)
    base = (1_700_000_000 // 300) * 300
    # 卡1 一个桶 util=20（1 样本）；卡2 一个桶 util=80（3 样本）
    _ins(s, 1, base, 20)
    for i, u in enumerate([80, 80, 80]):
        _ins(s, 2, base + i * 30, u)
    s.write_conn().commit()
    now = base + 600
    Rollup(s).roll_gpu_5m(now)
    # host 加权 = (20*1 + 80*3) / 4 = 65
    items = s.get_avg("12h", "host", "util_gpu", now=now)
    assert round(items[0]["avg"]) == 65
    assert items[0]["n_gpus"] == 2


def test_series_has_points(tmp_path):
    s = _setup(tmp_path)
    base = (1_700_000_000 // 300) * 300
    for i, u in enumerate([10, 20, 30]):
        _ins(s, 1, base + i * 30, u)
    s.write_conn().commit()
    now = base + 600
    Rollup(s).roll_gpu_5m(now)
    pts = s.get_series("gpu", 1, "util_gpu", "12h", now=now)
    assert len(pts) == 1 and round(pts[0][1]) == 20
