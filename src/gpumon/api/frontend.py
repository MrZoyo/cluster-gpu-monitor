"""Request-pinned frontend assets; an atomic pointer switch never restarts Web."""
from pathlib import Path
import json
import re

from starlette.exceptions import HTTPException
from starlette.responses import HTMLResponse, JSONResponse
from starlette.staticfiles import StaticFiles

from ..frontend_release import VERSION, manifest, pointer_version


class FrontendFiles(StaticFiles):
    def __init__(self, source: Path, store: Path):
        super().__init__(directory=str(source / "web"), html=True)
        self.source, self.store = source, store
        self.baseline = manifest(source)

    def bundle(self, version):
        if version == self.baseline["version"]:
            return self.source / "web"
        if not VERSION.fullmatch(version):
            raise HTTPException(404)
        directory = self.store / "releases" / version
        try:
            info = json.loads((directory / "manifest.json").read_text())
            if info["backend"] != self.baseline["backend"] or info["version"] != version:
                raise HTTPException(404)
            return directory / "web"
        except (OSError, ValueError, KeyError):
            raise HTTPException(404)

    def current(self):
        version = pointer_version(self.store)
        if version:
            try:
                self.bundle(version)
                return version
            except HTTPException:
                pass
        return self.baseline["version"]

    def status(self):
        return JSONResponse({"protocol": 1, "backend": self.baseline["backend"], "version": self.current()},
                            headers={"Cache-Control": "no-store"})

    async def get_response(self, path, scope):
        if scope["method"] not in ("GET", "HEAD"):
            raise HTTPException(405)
        pinned = path.startswith("_frontend/")
        if pinned:
            parts = path.split("/", 2)
            if len(parts) != 3:
                raise HTTPException(404)
            _, version, path = parts
        else:
            version = self.current()
        directory = self.bundle(version)  # Snapshot the immutable directory once per request.
        if path in (".", "", "index.html"):
            html = (directory / "index.html").read_text()
            html = re.sub(r'((?:src|href)=["\'])(?:\./|/)?(js/|css/|icons/|vendor/)',
                          rf'\g<1>/_frontend/{version}/\2', html)
            response = HTMLResponse(html, headers={"Cache-Control": "no-cache"})
        else:
            response = await StaticFiles(directory=str(directory)).get_response(path, scope)
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if pinned else "no-cache"
        response.headers["X-Gpumon-Frontend"] = version
        return response
