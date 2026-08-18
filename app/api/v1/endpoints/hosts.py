from fastapi import APIRouter, Depends
from app.schemas.host import HostCreate, HostResponse
from app.services.host_service import HostService
from app.api.dependencies import get_host_service, get_current_user
from typing import List

router = APIRouter()

@router.post("/hosts", response_model=HostResponse)
async def register_host(
    host_data: HostCreate, 
    service: HostService = Depends(get_host_service),
    user_id: str = Depends(get_current_user)
):
    return await service.register_host(host_data)

@router.get("/hosts", response_model=List[HostResponse])
async def list_hosts(
    service: HostService = Depends(get_host_service),
    user_id: str = Depends(get_current_user)
):
    return await service.list_hosts()

@router.delete("/hosts/{host_id}", status_code=204)
async def delete_host(
    host_id: str,
    service: HostService = Depends(get_host_service),
    user_id: str = Depends(get_current_user)
):
    await service.delete_host(host_id)
