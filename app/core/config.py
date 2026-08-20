from urllib.parse import quote

from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    APP_NAME: str = "PAM-Control-Plane"
    API_V1_PREFIX: str = "/api/v1"
    SECRET_KEY: str = "change-me-in-production"
    DEBUG: bool = False
    
    POSTGRES_USER: str = "pam_admin"
    POSTGRES_PASSWORD: str = "admin@123"
    POSTGRES_SERVER: str = "localhost"
    POSTGRES_PORT: str = "5433"
    POSTGRES_DB: str = "pam_db"
    
    REDIS_HOST: str = "localhost"
    REDIS_PORT: str = "6380"
    REDIS_DB: int = 0
    
    @property
    def DATABASE_URL(self) -> str:
        return (
            f"postgresql+asyncpg://{quote(self.POSTGRES_USER, safe='')}:"
            f"{quote(self.POSTGRES_PASSWORD, safe='')}@{self.POSTGRES_SERVER}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @property
    def REDIS_URL(self) -> str:
        return f"redis://{self.REDIS_HOST}:{self.REDIS_PORT}"

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=True, extra="ignore")

settings = Settings()
