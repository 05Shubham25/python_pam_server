from sqlalchemy import Column, String, Boolean
from app.models.base import Base, TimestampMixin
import uuid

class Host(Base, TimestampMixin):
    __tablename__ = "hosts"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    hostname = Column(String, unique=True, index=True, nullable=False)
    ip_address = Column(String, nullable=False)
    os_type = Column(String, nullable=False)  # 'linux', 'windows', 'macos'
    agent_id = Column(String, unique=True, index=True, nullable=False)
    is_online = Column(Boolean, default=False)
    environment = Column(String, default="dev")  # 'dev', 'staging', 'prod'
