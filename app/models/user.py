from sqlalchemy import Column, String, Boolean
from app.models.base import Base, TimestampMixin
import uuid

class User(Base, TimestampMixin):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    full_name = Column(String)
    is_active = Column(Boolean, default=True)
    role = Column(String, default="user")  # e.g., 'admin', 'user'
