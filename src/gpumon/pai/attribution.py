"""Reporting attribution from current workspace roles; never changes scheduling quotas."""
from __future__ import annotations

import json

from .client import CollectionError


def feature_memberships(members, configs, quotas, root_id):
    """Require complete inputs. Only explicit custom-role bindings identify a feature.

    Permissions (e.g. workspace admin) are not organization membership. An absent,
    ambiguous, or unrestricted binding must never turn into an inferred feature.
    Keep just IDs/candidates in the snapshot, not the raw member/config response.
    """
    valid = {q["quota_id"] for q in quotas} - {root_id}
    bindings = {}
    for config in configs:
        if not isinstance(config, dict):
            raise CollectionError("invalid_response")
        if config.get("IsDeleted") is True or config.get("ConfigKey") != "allowedRoles":
            continue
        entries = json.loads(config["ConfigValue"])
        if not isinstance(entries, list):
            raise CollectionError("invalid_response")
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("Type") != "Quota":
                raise CollectionError("invalid_response")
            qid, value = entry.get("Key"), entry.get("Value")
            if not isinstance(qid, str) or not qid or not isinstance(value, str):
                raise CollectionError("invalid_response")
            if qid in valid:
                roles = {r.strip() for r in value.split(",") if r.strip() and not r.strip().startswith("PAI.")}
                if qid in bindings and bindings[qid] != roles:
                    raise CollectionError("conflicting_role_config")
                bindings[qid] = roles
    users = {}
    for member in members:
        if not isinstance(member, dict):
            raise CollectionError("invalid_response")
        uid, roles = member.get("UserId"), member.get("Roles")
        if not isinstance(uid, str) or not uid or not isinstance(roles, list) or not all(isinstance(r, str) for r in roles):
            raise CollectionError("invalid_response")
        users.setdefault(uid, set()).update(roles)
    return [{"user_id": uid, "quota_ids": sorted(q for q, allowed in bindings.items() if allowed.intersection(roles))}
            for uid, roles in sorted(users.items())]


def membership_status(sources, cfg, now):
    source = sources.get("feature_memberships", {})
    fresh = source.get("state") == "ok" and now - (source.get("fetched_at") or 0) <= cfg.stale_after_s
    rows = source.get("payload") or []
    mapping = {r["user_id"]: r["quota_ids"] for r in rows} if fresh else {}
    return mapping, {"basis": "current_workspace_roles", "historical_role_membership": False,
                     "fresh": fresh, "fetched_at": source.get("fetched_at"),
                     "state": "stale" if source.get("state") == "ok" and not fresh else source.get("state", "unknown"),
                     "error": source.get("error")}
