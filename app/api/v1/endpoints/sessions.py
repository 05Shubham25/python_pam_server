from fastapi import APIRouter, Depends, Request
from typing import List
from app.schemas.session import SessionRequest, SessionResponse, SessionDetail
from app.services.session_service import SessionService
from app.api.dependencies import get_session_service, get_current_user
from app.core.config import settings

router = APIRouter()

@router.post("/sessions", response_model=SessionResponse)
async def request_session(
    request: Request,
    body: SessionRequest,
    service: SessionService = Depends(get_session_service),
    user_id: str = Depends(get_current_user)
):
    session = await service.request_session(
        user_id=user_id,
        host_id=body.host_id,
        session_type=body.session_type
    )
    base = str(request.base_url).rstrip("/")
    ws_url = f"{base.replace('https://', 'wss://').replace('http://', 'ws://')}{settings.API_V1_PREFIX}/ws/browser/{session.id}"

    return SessionResponse(
        session_id=session.id,
        status=session.status,
        websocket_url=ws_url if session.status == "active" else None
    )

@router.get("/sessions", response_model=List[SessionDetail])
async def list_sessions(
    request: Request,
    service: SessionService = Depends(get_session_service),
    user_id: str = Depends(get_current_user)
):
    base = str(request.base_url).rstrip("/")
    return await service.list_sessions(base_url=base)

@router.get("/sessions/{session_id}", response_model=SessionDetail)
async def get_session(
    request: Request,
    session_id: str,
    service: SessionService = Depends(get_session_service),
    user_id: str = Depends(get_current_user)
):
    base = str(request.base_url).rstrip("/")
    return await service.get_session(session_id, base_url=base)

@router.post("/sessions/{session_id}/terminate", response_model=SessionDetail)
async def terminate_session(
    request: Request,
    session_id: str,
    service: SessionService = Depends(get_session_service),
    user_id: str = Depends(get_current_user)
):
    base = str(request.base_url).rstrip("/")
    return await service.terminate_session(session_id)

