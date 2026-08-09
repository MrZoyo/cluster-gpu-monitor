"""FastAPI 应用：挂载 /api 路由 + 把 web/ 作为静态站点 serve。

只监听 127.0.0.1（见 settings/web）。对外访问一律经 Caddy 反代 + Basic Auth（阶段二）。
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from ..config import ROOT
from .routes import router

app = FastAPI(title="GPU 集群占用监控", version="0.1.0")
app.include_router(router)

# web/ 目录作为静态站点；html=True 让 / 返回 index.html。必须在 API 路由之后挂载。
_web_dir = ROOT / "web"
if _web_dir.exists():
    app.mount("/", StaticFiles(directory=str(_web_dir), html=True), name="static")
