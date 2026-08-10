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


def test_inline_badges_keep_declared_order():
    """内联标签按声明顺序原样输出，字段不被改写。"""
    c = ClusterCfg(key="c1", name="c1",
                   badges=[BadgeCfg(text="ROCm", tone="gold", mark="◆"),
                           BadgeCfg(text="IB", tone="green")])
    badges = c.resolved_badges()
    assert [b.text for b in badges] == ["ROCm", "IB"]
    assert badges[0].mark == "◆"
    assert badges[0].tone == "gold"


def test_no_badges_yields_empty_list():
    assert ClusterCfg(key="c1", name="c1").resolved_badges() == []


# ---------------------------------------------------------------------------
# 标签库：一处定义、多处引用。改库里的文案，所有引用处一起变 —— 这是该功能的重点。
# ---------------------------------------------------------------------------
def _inv_with_library(**kw) -> Inventory:
    return Inventory(
        badge_library=[
            BadgeCfg(key="self-built", text="自建", mark="◆", tone="cyan",
                     tooltip="自己装的机"),
            BadgeCfg(key="liquid", text="液冷", tone="violet"),
        ],
        **kw,
    )


def test_cluster_badge_reference_expands_from_library():
    inv = _inv_with_library(
        clusters=[ClusterCfg(key="c1", name="c1", badges=["self-built", "liquid"],
                             hosts=[_host("h1")])],
    )
    badges = inv.cluster_badges(inv.clusters[0])
    assert [b.text for b in badges] == ["自建", "液冷"]
    assert badges[0].mark == "◆"
    assert badges[0].tooltip == "自己装的机"


def test_same_badge_reused_across_domain_and_cluster():
    """同一枚标签挂到算力域和集群上，两边拿到的是同一份定义。"""
    inv = _inv_with_library(
        capacity_groups=[CapacityGroupCfg(key="g", name="G", badges=["self-built"])],
        clusters=[ClusterCfg(key="c1", name="c1", capacity_group="g",
                             badges=["self-built"], hosts=[_host("h1")])],
    )
    from_group = inv.group_badges(inv.capacity_groups[0])
    from_cluster = inv.cluster_badges(inv.clusters[0])
    assert [b.text for b in from_group] == ["自建"]
    assert from_group[0].model_dump() == from_cluster[0].model_dump()


def test_library_reference_and_inline_can_mix():
    """库引用与内联混写时，顺序按声明顺序，不因来源不同而重排。"""
    inv = _inv_with_library(
        clusters=[ClusterCfg(key="c1", name="c1",
                             badges=[BadgeCfg(text="ROCm", tone="gold"),
                                     "self-built", "liquid"],
                             hosts=[_host("h1")])],
    )
    assert [b.text for b in inv.cluster_badges(inv.clusters[0])] == \
        ["ROCm", "自建", "液冷"]


def test_configured_by_is_gone():
    """configured_by 已移除：老配置里残留这个字段不该被静默当成标签。"""
    c = ClusterCfg.model_validate({"key": "c1", "name": "c1", "configured_by": "运维组"})
    assert not hasattr(c, "configured_by")
    assert c.resolved_badges() == []


def test_stale_configured_by_in_yaml_is_rejected():
    """老配置直接跑要报错并给出迁移写法，不能让那枚标签无声消失。"""
    from gpumon.config import _reject_removed_fields

    data = {"clusters": [{"key": "c1", "name": "c1", "configured_by": "运维组"}]}
    with pytest.raises(ValueError, match="已移除的 configured_by"):
        _reject_removed_fields(data)


def test_clean_yaml_passes_removed_field_check():
    from gpumon.config import _reject_removed_fields

    _reject_removed_fields({"clusters": [{"key": "c1", "badges": ["x"]}]})
    _reject_removed_fields({})
    _reject_removed_fields({"clusters": None})


def test_unknown_badge_reference_rejected():
    """引用打错字要当场报错——静默跳过的话标签只是'不见了'，很难查。"""
    from gpumon.config import _validate_unique_keys

    inv = _inv_with_library(
        clusters=[ClusterCfg(key="c1", name="c1", badges=["liqiud"], hosts=[_host("h1")])],
    )
    with pytest.raises(ValueError, match="不存在的标签"):
        _validate_unique_keys(inv)


def test_domain_badge_reference_also_validated():
    from gpumon.config import _validate_unique_keys

    inv = _inv_with_library(
        capacity_groups=[CapacityGroupCfg(key="g", name="G", badges=["nope"])],
        clusters=[ClusterCfg(key="c1", name="c1", capacity_group="g", hosts=[_host("h1")])],
    )
    with pytest.raises(ValueError, match="不存在的标签"):
        _validate_unique_keys(inv)


def test_library_entry_without_key_rejected():
    from gpumon.config import _validate_unique_keys

    inv = Inventory(
        badge_library=[BadgeCfg(text="没 key 的标签")],
        clusters=[ClusterCfg(key="c1", name="c1", hosts=[_host("h1")])],
    )
    with pytest.raises(ValueError, match="缺 key"):
        _validate_unique_keys(inv)


def test_duplicate_library_key_rejected():
    from gpumon.config import _validate_unique_keys

    inv = Inventory(
        badge_library=[BadgeCfg(key="dup", text="一"), BadgeCfg(key="dup", text="二")],
        clusters=[ClusterCfg(key="c1", name="c1", hosts=[_host("h1")])],
    )
    with pytest.raises(ValueError, match="重复的标签 key"):
        _validate_unique_keys(inv)


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
