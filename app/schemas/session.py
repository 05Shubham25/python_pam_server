from pydantic import BaseModel
from typing import Optional

class SessionRequest(BaseModel):
    host_id: str
    session_type: str = "ssh"

class SessionResponse(BaseModel):
    session_id: str
    status: str
    websocket_url: Optional[str] = None

class SessionDetail(BaseModel):
    id: str
    status: str
    session_type: str
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    recording_url: Optional[str] = None
    audit_hash: Optional[str] = None
    user_id: str
    user_name: Optional[str] = None
    user_email: Optional[str] = None
    host_id: str
    host_hostname: Optional[str] = None
    host_ip_address: Optional[str] = None
    host_environment: Optional[str] = None
    websocket_url: Optional[str] = None

    class Config:
        from_attributes = True
