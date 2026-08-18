from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.exceptions import NotFoundException
from app.core.monitor import MonitorMiddleware
from app.api.v1.router import api_router
from app.infrastructure.redis_client import redis_client
import uvicorn

# ── logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
# Show all broker + monitor traffic at INFO
logging.getLogger("pam.monitor").setLevel(logging.DEBUG)
logging.getLogger("broker").setLevel(logging.DEBUG)
# Keep SQLAlchemy query noise out unless debugging DB
logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await redis_client.ping()
    yield
    await redis_client.close()

app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)

# Order matters: Monitor → CORS → routes
app.add_middleware(MonitorMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.API_V1_PREFIX)


@app.exception_handler(NotFoundException)
async def not_found_handler(request: Request, exc: NotFoundException):
    return JSONResponse(status_code=404, content={"detail": exc.detail})


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

