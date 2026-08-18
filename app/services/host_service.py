from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.host import Host
from app.schemas.host import HostCreate
from app.core.exceptions import NotFoundException

# Hosts whose agent has not heartbeat within this window display as offline.
AGENT_ONLINE_WINDOW_SECONDS = 45

class HostService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def register_host(self, host_data: HostCreate) -> Host:
        # Upsert: update the existing host if agent_id already exists.
        result = await self.db.execute(
            select(Host).where(Host.agent_id == host_data.agent_id)
        )
        host = result.scalar_one_or_none()

        if host:
            # Update mutable fields on re-registration.
            host.hostname = host_data.hostname
            host.ip_address = host_data.ip_address
            host.os_type = host_data.os_type
            host.environment = host_data.environment
            host.is_online = True  # agent is online since it just re-registered
            host.updated_at = datetime.now(timezone.utc)
        else:
            host = Host(**host_data.model_dump())
            self.db.add(host)

        await self.db.commit()
        await self.db.refresh(host)
        return host

    async def get_host(self, host_id: str) -> Host:
        result = await self.db.execute(select(Host).where(Host.id == host_id))
        host = result.scalar_one_or_none()
        if not host:
            raise NotFoundException("Host not found")
        return host

    async def list_hosts(self) -> list[Host]:
        result = await self.db.execute(select(Host))
        hosts = result.scalars().all()
        now = datetime.now(timezone.utc)
        for h in hosts:
            if h.is_online:
                last_seen = h.updated_at or h.created_at
                fresh = (
                    last_seen is not None
                    and (now - last_seen).total_seconds() < AGENT_ONLINE_WINDOW_SECONDS
                )
                h.is_online = fresh
        return hosts

    async def delete_host(self, host_id: str) -> None:
        host = await self.get_host(host_id)
        await self.db.delete(host)
        await self.db.commit()
