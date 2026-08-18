from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.session import SessionRecord
from app.models.host import Host
from app.models.user import User
from app.services.host_service import HostService
from app.core.config import settings
from app.core.exceptions import NotFoundException
import uuid

class SessionService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.host_service = HostService(db)

    async def request_session(self, user_id: str, host_id: str, session_type: str) -> SessionRecord:
        # 1. Verify host exists
        host = await self.host_service.get_host(host_id)
        if not host.is_online:
            raise NotFoundException("Host agent is currently offline")

        # 2. TODO: RBAC Check (pycasbin) - Does user have access to this host/env?
        
        # 3. Create session record
        session = SessionRecord(
            id=str(uuid.uuid4()),
            user_id=user_id,
            host_id=host_id,
            status="active",  # For MVP, auto-approve. Later, set to 'pending' for JIT
            session_type=session_type
        )
        self.db.add(session)
        await self.db.commit()
        await self.db.refresh(session)
        
        return session

    async def list_sessions(self, base_url: str = "http://localhost:8000") -> list[dict]:
        stmt = (
            select(SessionRecord, Host, User)
            .join(Host, SessionRecord.host_id == Host.id)
            .join(User, SessionRecord.user_id == User.id)
            .order_by(SessionRecord.created_at.desc())
        )
        result = await self.db.execute(stmt)
        return [self._to_detail(row, base_url) for row in result.all()]

    async def get_session(self, session_id: str, base_url: str = "http://localhost:8000") -> dict:
        stmt = (
            select(SessionRecord, Host, User)
            .join(Host, SessionRecord.host_id == Host.id)
            .join(User, SessionRecord.user_id == User.id)
            .where(SessionRecord.id == session_id)
        )
        result = await self.db.execute(stmt)
        row = result.first()
        if not row:
            raise NotFoundException("Session not found")
        return self._to_detail(row, base_url)

    async def terminate_session(self, session_id: str) -> dict:
        result = await self.db.execute(
            select(SessionRecord).where(SessionRecord.id == session_id)
        )
        session = result.scalar_one_or_none()
        if not session:
            raise NotFoundException("Session not found")
        session.status = "closed"
        await self.db.commit()
        await self.db.refresh(session)
        return await self.get_session(session_id)

    def _to_detail(self, row, base_url: str = "http://localhost:8000") -> dict:
        session, host, user = row
        ws_url = None
        if session.status == "active":
            # Convert http(s) → ws(s) and append the broker path
            ws_base = base_url.replace("https://", "wss://").replace("http://", "ws://").rstrip("/")
            ws_url = f"{ws_base}{settings.API_V1_PREFIX}/ws/browser/{session.id}"
        return {
            "id": session.id,
            "status": session.status,
            "session_type": session.session_type,
            "started_at": session.created_at.isoformat() if session.created_at else None,
            "ended_at": session.updated_at.isoformat() if session.status != "active" and session.updated_at else None,
            "recording_url": session.recording_url,
            "audit_hash": session.audit_hash,
            "user_id": session.user_id,
            "user_name": user.full_name,
            "user_email": user.email,
            "host_id": host.id,
            "host_hostname": host.hostname,
            "host_ip_address": host.ip_address,
            "host_environment": host.environment,
            "websocket_url": ws_url,
        }
