from fastapi import Depends, Header, HTTPException, status
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from app.infrastructure.database import get_db
from app.services.host_service import HostService
from app.services.session_service import SessionService
from app.core.config import settings

# MOCK AUTHENTICATION: Extracts user_id from x-user-id header.
# In dev mode (DEBUG=True), falls back to "dev-user" if header is missing.
# Replace with real JWT verification before going to production.
async def get_current_user(x_user_id: Optional[str] = Header(default=None)) -> str:
    if x_user_id:
        return x_user_id
    if settings.DEBUG:
        return "dev-user"  # Dev fallback — remove in production
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing x-user-id header",
    )

def get_host_service(db: AsyncSession = Depends(get_db)) -> HostService:
    return HostService(db)

def get_session_service(db: AsyncSession = Depends(get_db)) -> SessionService:
    return SessionService(db)
