from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.dependencies import get_db
from app.services.auth_service import AuthService, InvalidCredentialsException
from app.models.user import User

router = APIRouter()


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    user_id: str
    email: str
    full_name: str | None
    role: str


@router.post("/auth/login", response_model=LoginResponse)
async def login(
    request: LoginRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        user: User = await AuthService(db).login(request.email, request.password)
    except InvalidCredentialsException as e:
        raise HTTPException(status_code=401, detail=e.detail)

    return LoginResponse(
        user_id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
    )
