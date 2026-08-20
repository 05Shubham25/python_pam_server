from fastapi import Depends, Header, HTTPException, status
from typing import Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.infrastructure.database import get_db
from app.models.user import User
from app.services.host_service import HostService
from app.services.session_service import SessionService
from app.core.config import settings

# MOCK AUTHENTICATION: Extracts user_id from x-user-id header.
# In dev mode (DEBUG=True), falls back to the first real user when the header
# is missing or unknown — session rows have a foreign key into users, so the
# resolved id must exist there.
# Replace with real JWT verification before going to production.
async def get_current_user(
    x_user_id: Optional[str] = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> str:
    if x_user_id:
        found = await db.execute(select(User.id).where(User.id == x_user_id))
        if found.first():
            return x_user_id
    if settings.DEBUG:
        first = await db.execute(select(User.id).limit(1))
        row = first.first()
        if row:
            return row[0]
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing or unknown x-user-id header",
    )

def get_host_service(db: AsyncSession = Depends(get_db)) -> HostService:
    return HostService(db)

def get_session_service(db: AsyncSession = Depends(get_db)) -> SessionService:
    return SessionService(db)
