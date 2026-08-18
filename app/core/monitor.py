"""
monitor.py — lightweight request/response logger middleware.

Logs every HTTP request with timing, status, and body size.
WebSocket upgrades are logged separately (no response body).

Usage: app.add_middleware(MonitorMiddleware)
"""
import logging
import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

log = logging.getLogger("pam.monitor")


class MonitorMiddleware(BaseHTTPMiddleware):
    """Log every request: method path → status, duration, bytes."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:
        start = time.perf_counter()
        client = request.client.host if request.client else "?"
        method = request.method
        path = request.url.path
        qs = f"?{request.url.query}" if request.url.query else ""

        # WebSocket upgrades don't return normal responses
        if request.headers.get("upgrade", "").lower() == "websocket":
            log.info("WS  OPEN  %s  %s%s", client, path, qs)
            try:
                response = await call_next(request)
            except Exception as exc:
                log.error("WS  ERROR %s  %s%s  %s", client, path, qs, exc)
                raise
            elapsed = (time.perf_counter() - start) * 1000
            log.info("WS  DONE  %s  %s%s  %.0fms", client, path, qs, elapsed)
            return response

        try:
            response = await call_next(request)
        except Exception as exc:
            elapsed = (time.perf_counter() - start) * 1000
            log.error(
                "HTTP  ERR  %s  %s %s%s  %.0fms  %s",
                client, method, path, qs, elapsed, exc,
            )
            raise

        elapsed = (time.perf_counter() - start) * 1000
        size = int(response.headers.get("content-length", 0))
        size_str = f"  {size}B" if size else ""
        level = logging.WARNING if response.status_code >= 400 else logging.INFO
        log.log(
            level,
            "HTTP  %s  %s  %s %s%s  %.0fms%s",
            response.status_code,
            client,
            method,
            path,
            qs,
            elapsed,
            size_str,
        )
        return response
