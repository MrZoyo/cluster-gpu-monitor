"""FastAPI 应用：挂载 /api 路由 + 把 web/ 作为静态站点 serve。

只监听 127.0.0.1（见 settings/web）。对外访问经 Caddy 反代；可仅为近期摘要配置匿名例外，其余路径使用 Basic Auth。
"""
from __future__ import annotations

from fastapi import FastAPI

from .. import __version__
from ..config import CODE_ROOT, ROOT
from .frontend import FrontendFiles
from .routes import router
from .public_summary import router as public_router, SummaryService
from .pai import pai_enabled, router as pai_router


def create_app(*, enable_docs: bool = False) -> FastAPI:
    docs_url = "/docs" if enable_docs else None
    openapi_url = "/openapi.json" if enable_docs else None
    redoc_url = "/redoc" if enable_docs else None
    application = FastAPI(
        title="GPU 集群占用监控",
        version=__version__,
        docs_url=docs_url,
        redoc_url=redoc_url,
        openapi_url=openapi_url,
    )
    application.state.gpu_summary = SummaryService()
    application.include_router(public_router)
    application.include_router(router)
    # PAI 默认关闭：未在 pai.toml 中明确启用时不注册任何 /api/pai 路由（一律 404），启用后需重启 Web 生效。
    if pai_enabled():
        application.include_router(pai_router)

    # web/ 目录作为静态站点；html=True 让 / 返回 index.html。必须在 API 路由之后挂载。
    web_dir = CODE_ROOT / "web"
    if web_dir.exists():
        frontend = FrontendFiles(CODE_ROOT, ROOT / "frontend")
        application.add_api_route("/api/frontend-release", frontend.status, methods=["GET"])
        application.mount(
            "/", frontend, name="static"
        )
    return application


# 模块级 app 保持安全默认，供测试和通用 ASGI 导入；CLI 会按 settings 创建实例。
app = create_app()
