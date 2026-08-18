from pydantic import BaseModel
from typing import Optional
from datetime import datetime

class HostBase(BaseModel):
    hostname: str
    ip_address: str
    os_type: str
    environment: str = "dev"

class HostCreate(HostBase):
    agent_id: str

class HostResponse(HostBase):
    id: str
    agent_id: str
    is_online: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True
