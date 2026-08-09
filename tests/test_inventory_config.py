"""配置层的自适应能力：任意命名、算力域自动补齐、色带轮转、自定义标签。

这些用例的意义：只要按 算力域→集群→服务器 三层填清单，不管名字叫什么、
声明了几个域，后端都要给出完整且不含硬编码机构名的元数据。
"""
from __future__ import annotations

import pytest

from gpumon.models import PALETTES, BadgeCfg, CapacityGroupCfg, ClusterCfg, Defaults, HostCfg, Inventory


def _host(key: str) -> HostCfg:
    return HostCfg(key=key, ssh_alias=f"alias-{key}", display_name=key.upper())


def test_group_declared_explicitly_keeps_name_and_palette():
    inv = Inventory(
        capacity_groups=[CapacityGroupCfg(key="lab", name="实验室算力", sort_order=1,
                                          palette="violet")],
        clusters=[ClusterCfg(key="c1", name="集群一", capacity_group="lab", hosts=[_host("h1")])],
    )
    groups = inv.resolved_groups()
    assert [g.key for g in groups] == ["lab"]
    assert groups[0].name == "实验室算力"
    assert groups[0].palette == "violet"
    assert inv.group_key_of(inv.clusters[0]) == "lab"


def test_cluster_without_group_falls_back_to_neutral_domain():
    """没写 capacity_group：落到兜底域，名字取 defaults，不出现任何机构名。"""
    inv = Inventory(clusters=[ClusterCfg(key="c1", name="集群一", hosts=[_host("h1")])])
    groups = inv.resolved_groups()
    assert [g.key for g in groups] == ["default"]
    assert groups[0].name == "未分组"
    assert groups[0].palette  # 兜底域也分到了色带


def test_fallback_domain_name_is_configurable():
    inv = Inventory(
        defaults=Defaults(fallback_group_key="misc", fallback_group_name="Other Capacity"),
        clusters=[ClusterCfg(key="c1", name="c1", hosts=[_host("h1")])],
    )
    groups = inv.resolved_groups()
    assert [(g.key, g.name) for g in groups] == [("misc", "Other Capacity")]


def test_palette_auto_rotates_and_never_repeats_within_builtin_range():
    """8 个域各拿到不同的内置色带——旧版第 3 个域起会全掉进灰色。"""
    inv = Inventory(
        capacity_groups=[CapacityGroupCfg(key=f"g{i}", name=f"域{i}", sort_order=i)
                         for i in range(8)],
        clusters=[ClusterCfg(key="c1", name="c1", capacity_group="g0", hosts=[_host("h1")])],
    )
    palettes = [g.palette for g in inv.resolved_groups()]
    assert len(set(palettes)) == 8
    assert set(palettes) == set(PALETTES)


def test_more_domains_than_builtin_palettes_still_resolves():
    """12 个域：内置 8 条用尽后仍要每个域都有 palette（前端会按域名生成新色相）。"""
    inv = Inventory(
        capacity_groups=[CapacityGroupCfg(key=f"g{i}", name=f"域{i}", sort_order=i)
                         for i in range(12)],
        clusters=[ClusterCfg(key="c1", name="c1", capacity_group="g0", hosts=[_host("h1")])],
    )
    groups = inv.resolved_groups()
    assert len(groups) == 12
    assert all(g.palette for g in groups)


def test_badges_and_configured_by_compose():
    """configured_by 合成的标签排在自定义 badges 之前，两种写法可共存。"""
    c = ClusterCfg(key="c1", name="c1", configured_by="运维组",
                   badges=[BadgeCfg(text="ROCm", tone="gold"),
                           BadgeCfg(text="IB", tone="green")])
    badges = c.resolved_badges()
    assert [b.text for b in badges] == ["运维组 配置", "ROCm", "IB"]
    assert badges[0].mark == "◆"
    assert badges[0].tone == "cyan"


def test_no_badges_yields_empty_list():
    assert ClusterCfg(key="c1", name="c1").resolved_badges() == []


def test_unknown_palette_rejected():
    from gpumon.config import _validate_unique_keys

    inv = Inventory(
        capacity_groups=[CapacityGroupCfg(key="g", name="g", palette="chartreuse")],
        clusters=[ClusterCfg(key="c1", name="c1", capacity_group="g", hosts=[_host("h1")])],
    )
    with pytest.raises(ValueError, match="不是内置色带"):
        _validate_unique_keys(inv)


def test_typo_in_declared_group_still_rejected():
    """声明了域却把 key 拼错 → 报错，而不是静默多出一个孤儿域。"""
    from gpumon.config import _validate_unique_keys

    inv = Inventory(
        capacity_groups=[CapacityGroupCfg(key="lab", name="lab")],
        clusters=[ClusterCfg(key="c1", name="c1", capacity_group="labb", hosts=[_host("h1")])],
    )
    with pytest.raises(ValueError, match="不存在的算力域"):
        _validate_unique_keys(inv)
