from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.dependencies import get_db
from app.broker.manager import broker_manager
from app.models.host import Host
from app.models.session import SessionRecord

router = APIRouter()

# A host is shown online while its agent heartbeats at least this often.
AGENT_ONLINE_WINDOW_SECONDS = 45


class HeartbeatRequest(BaseModel):
    agent_id: str


@router.post("/agent/heartbeat")
async def agent_heartbeat(
    request: HeartbeatRequest,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        update(Host)
        .where(Host.agent_id == request.agent_id)
        .values(is_online=True, updated_at=datetime.now(timezone.utc))
    )
    if result.rowcount == 0:
        return {"ok": False, "detail": "unknown agent_id"}
    await db.commit()
    return {"ok": True}


@router.post("/agent/offline")
async def agent_offline(
    request: HeartbeatRequest,
    db: AsyncSession = Depends(get_db),
):
    await db.execute(
        update(Host)
        .where(Host.agent_id == request.agent_id)
        .values(is_online=False, updated_at=datetime.now(timezone.utc))
    )
    await db.commit()
    return {"ok": True}


@router.get("/agent/sessions")
async def agent_sessions(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Active sessions on this agent's host that a browser is waiting on.

    Filtering by live browser connections keeps agents from spawning
    workers (and capture threads) for orphaned sessions nobody watches.
    """
    result = await db.execute(
        select(SessionRecord)
        .join(Host, SessionRecord.host_id == Host.id)
        .where(Host.agent_id == agent_id, SessionRecord.status == "active")
        .order_by(SessionRecord.created_at.asc())
    )
    watched = set(broker_manager.active_browsers.keys())
    return {
        "sessions": [
            {
                "id": s.id,
                "host_id": s.host_id,
                "session_type": s.session_type,
                "status": s.status,
            }
            for s in result.scalars()
            if s.id in watched
        ]
    }
