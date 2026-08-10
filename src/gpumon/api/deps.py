"""API 共享依赖：Store 单例、使用人打码、窗口校验。"""
from __future__ import annotations

from functools import lru_cache

from ..config import load_settings
from ..db.store import WINDOWS, Store


@lru_cache(maxsize=1)
def get_store() -> Store:
    # Web/API 进程只负责查询。mode=ro + query_only 让代码路径本身也无法修改数据库，
    # 不把安全性只寄托在部署机的文件权限上。
    return Store(read_only=True)


def mask_username(name: str | None) -> str | None:
    """privacy.mask_users 开启时把用户名打码：djr→d*r, Lyle→L**e。"""
    if not name or not load_settings().privacy.mask_users:
        return name
    if len(name) <= 2:
        return name[0] + "*"
    return name[0] + "*" * (len(name) - 2) + name[-1]


def valid_window(window: str) -> str:
    if window not in WINDOWS:
        from fastapi import HTTPException
        raise HTTPException(400, f"未知窗口 {window}，可选 {list(WINDOWS)}")
    return window
