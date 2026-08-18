import asyncio
from app.infrastructure.database import engine
from app.models.base import Base  # the declarative base the models register on
from app.models.user import User
from app.models.host import Host
from app.models.session import SessionRecord

async def init():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    print("Tables created successfully.")

if __name__ == "__main__":
    asyncio.run(init())
