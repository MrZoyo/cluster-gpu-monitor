"""Derive a current view; historical metric points keep only source dimensions."""
from __future__ import annotations

from .values import number


def source_status(source, now, stale_after):
    age = now - source["fetched_at"] if source.get("fetched_at") is not None else None
    state = source["state"]
    if state in ("ok", "no_data", "partial") and (age is None or age > stale_after):
        state = "stale"
    metric_meta = (source.get("payload") or [{}])[0] if source["name"].startswith("metric:") else {}
    return {k: source.get(k) for k in ("name", "fetched_at", "attempted_at", "total", "error")} | {
        "sampled_at": metric_meta.get("sampled_at"),
        "point_count": metric_meta.get("points"),
        "state": state, "age_s": age, "retained": source["state"] == "error" and source.get("payload") is not None}


def overview(store, cfg, now):
    sources = store.sources()
    payload = lambda name, default: sources.get(name, {}).get("payload") or default
    round_info = payload("round", {})
    names = set(round_info.get("active_sources", sources)) | {"round"}
    # Job details are cached on purpose (strategy and specs rarely change); judge them by their own cadence.
    stale_limit = lambda name: (cfg.job_refresh_s + 2 * cfg.degraded_interval_s) if name.startswith("job:") else cfg.stale_after_s
    statuses = [source_status(s, now, stale_limit(name)) for name, s in sources.items() if name in names]
    by_status = {s["name"]: s for s in statuses}
    fresh = lambda name: by_status.get(name, {}).get("state") == "ok"
    observed_identity = payload("identity", {})
    if observed_identity and observed_identity.get("AccountId") != cfg.account_id:
        raise ValueError("PAI database belongs to a different account")
    workloads = payload("workloads", [])
    workloads = list({w["WorkloadId"]: dict(w) for w in workloads}.values())
    by_workload = {w["WorkloadId"]: w for w in workloads}
    metrics = store.latest_metrics(now)
    recent = store.recent_means(now)
    metric_lookup = {}
    gpu_sets = {}
    for m in metrics:
        source_name = "metric:" + m["workload_id"] + ":" + m["metric"]
        m["fresh"] = fresh(source_name) and now - m["ts"] <= cfg.stale_after_s
        # 10-minute mean beside the latest point: low-utilization flags use it to avoid one-minute noise.
        m["recent_mean"], m["recent_n"] = recent.get(m["series_id"], (None, 0))
        metric_lookup[(m["workload_id"], m["pod"], m["gpu"], m["metric"])] = m
        gpu_sets.setdefault((m["workload_id"], m["pod"], m["metric"]), set()).add(m["gpu"])
    nodes, physical = [], {}
    for node in payload("nodes", []):
        name = node["NodeName"]
        count = number(node["GPU"])
        # Unbounded/unparseable topology must not generate arbitrary cards.
        count = int(count) if count is not None and count <= 128 and count.is_integer() else 0
        cards = [{"index": i, "assignments": [], "compute": None, "memory": None} for i in range(count)]
        for pod in payload("pods:" + name, []):
            indices = pod.get("GPUIndexes") or []
            for i in indices:
                if not isinstance(i, int) or not 0 <= i < count:
                    continue
                w = by_workload.get(pod.get("WorkloadId"), {})
                assignment = {"workload_id": pod.get("WorkloadId"), "pod": pod.get("PodName"),
                              "owner_id": w.get("UserId"), "owner_name": w.get("UserName"),
                              "phase": pod.get("Phase"),
                              "observed_at": sources.get("pods:" + name, {}).get("fetched_at"),
                              "fresh": fresh("pods:" + name) and fresh("workloads")}
                cards[i]["assignments"].append(assignment)
                # Only join when the observed metric index set equals the physical assignment set.
                # Otherwise local/container GPU indices may differ: leave physical values unknown.
                for metric in ("compute", "memory"):
                    key = (pod.get("WorkloadId"), pod.get("PodName"), metric)
                    if gpu_sets.get(key) == {str(j) for j in indices}:
                        m = metric_lookup.get((key[0], key[1], str(i), metric))
                        if m:
                            cards[i][metric] = {"value": m["value"], "sampled_at": m["ts"],
                                "recent": m["recent_mean"], "recent_n": m["recent_n"],
                                "fresh": m["fresh"] and assignment["fresh"] and fresh("nodes")}
        for card in cards:
            if len(card["assignments"]) > 1:
                card["compute"] = card["memory"] = None
            physical[(name, card["index"])] = card
        nodes.append({**node, "cards": cards, "mapping_state": by_status.get("pods:" + name, {}).get("state", "unknown")})
    for w in workloads:
        w["job"] = payload("job:" + w["WorkloadId"], None)
        w["cards"] = [{"node": n, "index": i} for (n, i), c in physical.items()
                      if any(a["workload_id"] == w["WorkloadId"] for a in c["assignments"])]
        w["metrics"] = [m for m in metrics if m["workload_id"] == w["WorkloadId"]]
    users = []
    for u in payload("users", []):
        own = [w for w in workloads if w.get("UserId") == u["UserId"]]
        running = sum(w["WorkloadStatus"] == "Running" for w in own)
        users.append({**u, "running_workloads": running, "workload_ids": [w["WorkloadId"] for w in own],
                      # Oversold workloads run outside the quota, so zero quota usage is expected for them.
                      "conflict": u["used_gpu"] == 0 and running > 0 and any(
                          (w["requested_gpu"] or 0) > 0 and not w.get("oversold")
                          for w in own if w["WorkloadStatus"] == "Running")})
    measured = [c["compute"]["value"] for c in physical.values() if c["compute"] and c["compute"]["fresh"]]
    assigned = sum(bool(c["assignments"]) for c in physical.values())
    # Task mean is per observed GPU, including idle-time jobs without physical mapping.
    running_ids = {w["WorkloadId"] for w in workloads if w["WorkloadStatus"] == "Running"
                   and w.get("scheduled") is not False}
    task_values = [m["value"] for m in metrics if m["metric"] == "compute" and m["fresh"]
                   and m["workload_id"] in running_ids and fresh("workloads")]
    # Only confirmed unallocated cards contribute zero. Missing allocated metrics and
    # uncertain allocation remain unknown, never silently reducing the cluster mean.
    cluster_values = []
    unallocated = 0
    for node in nodes:
        node_assigned = sum(bool(c["assignments"]) for c in node["cards"])
        requested = number(node.get("RequestGPU"))
        free_known = (fresh("nodes") and fresh("workloads") and fresh("pods:" + node["NodeName"])
                      and requested is not None and requested <= node_assigned)
        for card in node["cards"]:
            if card["compute"] and card["compute"]["fresh"]:
                cluster_values.append(card["compute"]["value"])
            elif not card["assignments"] and free_known:
                cluster_values.append(0)
                unallocated += 1
    cluster_complete = bool(physical) and len(cluster_values) == len(physical) and fresh("nodes")
    state = "ok"
    if not round_info:
        state = "waiting"
    elif any(s["state"] in ("error", "partial", "stale") for s in statuses):
        state = "partial" if fresh("round") or by_status.get("round", {}).get("state") == "partial" else "stale"
    return {"enabled": True, "state": state, "now": now,
            "baremetal_notice": cfg.baremetal_notice,
            "region": cfg.region, "workspace_id": cfg.workspace_id, "quota_id": cfg.quota_id,
            "poll_interval_s": round_info.get("next_interval_s", cfg.poll_interval_s),
            "stale_after_s": cfg.stale_after_s, "sources": statuses, "round": round_info,
            "quotas": payload("quotas", []), "nodes": nodes, "workloads": workloads, "users": users,
            "summary": {"physical_gpus": len(physical) if fresh("nodes") else None,
                "mapped_gpus": assigned if fresh("nodes") and all(fresh("pods:" + n["NodeName"]) for n in nodes) else None,
                "measured_gpus": len(measured), "metric_denominator": len(physical),
                "compute_mean": sum(measured) / len(measured) if measured else None,
                "task_compute_mean": sum(task_values) / len(task_values) if task_values else None,
                "task_measured_gpus": len(task_values),
                "cluster_compute_mean": sum(cluster_values) / len(physical) if cluster_complete else None,
                "cluster_known_gpus": len(cluster_values), "cluster_unallocated_gpus": unallocated}}
