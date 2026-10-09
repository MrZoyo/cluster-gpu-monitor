"""Bounded read-only CLI transport; never log stdout/stderr or credential material."""
from __future__ import annotations

import json
import subprocess
import time
import threading
from datetime import datetime, timezone
from urllib.parse import quote

from .config import PaiSettings


class CollectionError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class PaiClient:
    def __init__(self, settings: PaiSettings):
        self.settings = settings
        self.calls = 0
        self.deadline = time.monotonic() + settings.round_timeout_s
        self.lock = threading.Lock()
        self.rate_limited = False

    def _call(self, args: list[str]):
        remaining = self.deadline - time.monotonic()
        with self.lock:
            if self.rate_limited:
                raise CollectionError("rate_limited")
            if remaining <= 0 or self.calls >= self.settings.max_calls:
                raise CollectionError("budget_exceeded")
            self.calls += 1
        cmd = [self.settings.cli_path, "--region", self.settings.region, "-o", "json"]
        if self.settings.profile:
            cmd += ["--profile", self.settings.profile]
        try:
            result = subprocess.run(cmd + args, capture_output=True, timeout=min(
                remaining, self.settings.request_timeout_s), check=False)
        except subprocess.TimeoutExpired:
            raise CollectionError("timeout") from None
        except OSError:
            raise CollectionError("cli_unavailable") from None
        # The CLI's error text may contain signed URLs; expose only a fixed code.
        if result.returncode:
            error = (result.stderr + b"\n" + result.stdout).lower()
            if any(k in error for k in (b"throttl", b"429", b"flowcontrol")):
                self.rate_limited = True
                raise CollectionError("rate_limited")
            if any(k in error for k in (b"forbidden", b"accessdenied", b"unauthorized")):
                raise CollectionError("permission_denied")
            raise CollectionError("upstream_error")
        if len(result.stdout) > 8 * 1024 * 1024:
            raise CollectionError("response_too_large")
        try:
            data = json.loads(result.stdout)
        except ValueError:
            raise CollectionError("invalid_response") from None
        if isinstance(data, dict) and data.get("Success") is False:
            code = str(data.get("Code", "")).lower()
            if any(k in code for k in ("throttl", "429", "flowcontrol")):
                self.rate_limited = True
                raise CollectionError("rate_limited")
            raise CollectionError("upstream_error")
        return data

    def _api(self, action, path, params=None, product="paistudio", version="2022-01-12"):
        allowed = {"GetCallerIdentity", "ListNodes", "ListNodePods", "ListQuotaWorkloads",
                   "ListQuotaActiveUserUsages", "DescribeMetricList"}
        if action not in allowed:
            raise ValueError("Only monitoring read operations are allowed")
        endpoint = ("metrics.cn-hangzhou.aliyuncs.com" if product == "cms" else
                    f"sts.{self.settings.region}.aliyuncs.com" if product == "sts" else
                    f"pai.{self.settings.region}.aliyuncs.com")
        args = ["api", product, action, "--method", "GET", "--version", version,
                "--path", path, "--endpoint", endpoint]
        for k, v in (params or {}).items():
            args += ["--param", f"{k}={v}"]
        return self._call(args)

    def identity(self):
        return self._api("GetCallerIdentity", "/", {"Action": "GetCallerIdentity"},
                         "sts", "2015-04-01")

    def quota(self, quota_id):
        return self._call(["resource", "quota", "get", quota_id])

    def pages(self, action, path, key, params=None):
        rows, fingerprints = [], set()
        total = None
        for page in range(1, self.settings.max_pages + 1):
            data = self._api(action, path, {**(params or {}), "PageSize": 100, "PageNumber": page})
            if key not in data or not isinstance(data[key], list):
                raise CollectionError("invalid_response")
            batch = data[key]
            fingerprint = json.dumps(batch, sort_keys=True)
            if batch and fingerprint in fingerprints:
                raise CollectionError("pagination_repeated")
            fingerprints.add(fingerprint)
            rows.extend(batch)
            if data.get("TotalCount") is not None:
                total = int(data["TotalCount"])
                if len(rows) >= total:
                    return rows, total
                if not batch:
                    raise CollectionError("incomplete")
            elif len(batch) < 100 and not data.get("NextToken"):
                return rows, len(rows)
        raise CollectionError("pagination_limit")

    def nodes(self, quota_id=None):
        return self.pages("ListNodes", "/api/v1/nodes", "Nodes",
                          {"QuotaId": quota_id or self.settings.quota_id, "Verbose": "true"})

    def workloads(self):
        return self.pages("ListQuotaWorkloads", f"/api/v1/quotas/{self.settings.quota_id}/workloads",
                          "Workloads", {"ShowOwn": "false", "WorkspaceIds": self.settings.workspace_id})

    def users(self):
        return self.pages("ListQuotaActiveUserUsages",
                          f"/api/v1/quotas/{self.settings.quota_id}/activeuserusages",
                          "QuotaUserUsages", {"WorkspaceId": self.settings.workspace_id})

    def job(self, job_id):
        # Read-only DLC job detail; only whitelisted fields are kept by the collector.
        return self._call(["dlc", "job", "get", job_id])

    def pods(self, node, group):
        return self.pages("ListNodePods", f"/api/v1/nodes/{quote(node, safe='')}/Pods",
                          "NodePodInfos", {"ResourceGroupId": group})

    def metrics(self, kind, workload_id, metric, now):
        cursor, seen, points = None, set(), []
        stamp = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for _ in range(self.settings.max_pages):
            params = {"Action": "DescribeMetricList", "Namespace": "acs_pai_" + kind,
                      "MetricName": metric, "Dimensions": json.dumps([{
                          "jobId": workload_id, "regionId": self.settings.region}]),
                      "StartTime": stamp(now - self.settings.metric_window_s),
                      "EndTime": stamp(now), "Period": 60, "Length": 1440}
            if cursor:
                params["NextToken"] = cursor
            data = self._api("DescribeMetricList", "/", params, "cms", "2019-01-01")
            batch = data.get("Datapoints")
            if isinstance(batch, str):
                batch = json.loads(batch)
            if not isinstance(batch, list):
                raise CollectionError("invalid_response")
            points.extend(batch)
            cursor = data.get("NextToken")
            if not cursor:
                return points
            if cursor in seen:
                raise CollectionError("pagination_repeated")
            seen.add(cursor)
        raise CollectionError("pagination_limit")
