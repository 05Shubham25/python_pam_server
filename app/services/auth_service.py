from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.user import User
from app.core.security import hash_password, verify_password


class AuthService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def login(self, email: str, password: str) -> User:
        result = await self.db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()

        # First-run bootstrap: an empty users table adopts the login
        # credentials as the initial admin account.
        if user is None:
            count = await self.db.execute(select(User).limit(1))
            if count.scalar_one_or_none() is None:
                user = User(
                    email=email,
                    hashed_password=hash_password(password),
                    full_name=email.split("@")[0].title(),
                    role="admin",
                    is_active=True,
                )
                self.db.add(user)
                await self.db.commit()
                await self.db.refresh(user)
                return user
            raise InvalidCredentialsException()

        if not user.is_active or not verify_password(password, user.hashed_password):
            raise InvalidCredentialsException()
        return user


class InvalidCredentialsException(Exception):
    def __init__(self, detail: str = "Invalid email or password"):
        self.detail = detail
