from sqlalchemy import Column, String, DateTime, ForeignKey, Text
from app.models.base import Base, TimestampMixin
import uuid

class SessionRecord(Base, TimestampMixin):
    __tablename__ = "session_records"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    host_id = Column(String, ForeignKey("hosts.id"), nullable=False)
    status = Column(String, default="pending")  # 'pending', 'active', 'closed', 'denied'
    session_type = Column(String, default="ssh")  # 'ssh', 'rdp', 'vnc'
    recording_url = Column(String, nullable=True)
    audit_hash = Column(String, nullable=True)  # For tamper-evident logging
