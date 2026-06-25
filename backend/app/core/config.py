from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = Field(..., env="DATABASE_URL")

    # Solana
    GIGR_PROGRAM_ID: str = Field(..., env=("GIGR_PROGRAM_ID", "BAROS_PROGRAM_ID"))
    SOLANA_RPC_URL: str = Field(..., env="SOLANA_RPC_URL")
    PLATFORM_KEYPAIR: str = Field(..., env="PLATFORM_KEYPAIR")
    WALLET_ENCRYPTION_KEY: str = Field(..., env="WALLET_ENCRYPTION_KEY")
        # USDC Devnet Mint
    USDC_MINT_DEVNET: str = Field(..., env="USDC_MINT_DEVNET")

    # Google OAuth
    GOOGLE_CLIENT_ID: str = Field(..., env="GOOGLE_CLIENT_ID")
    GOOGLE_CLIENT_SECRET: str = Field(..., env="GOOGLE_CLIENT_SECRET")

    # Brevo
    BREVO_API_KEY: str = Field(..., env="BREVO_API_KEY")
    BREVO_SENDER_EMAIL: str = Field(..., env="BREVO_SENDER_EMAIL")

    # Stadia Maps
    STADIA_MAPS_API_KEY: str = Field(..., env="STADIA_MAPS_API_KEY")
    STADIA_MAPS_BASE_URL: str = "https://tiles.stadiamaps.com"

    # Underdog
    UNDERDOG_API_KEY: str = Field(..., env="UNDERDOG_API_KEY")
    UNDERDOG_API_URL: str = Field(..., env="UNDERDOG_API_URL")

    # Cloudinary
    CLOUDINARY_CLOUD_NAME: str = Field(..., env="CLOUDINARY_CLOUD_NAME")
    CLOUDINARY_API_KEY: str = Field(..., env="CLOUDINARY_API_KEY")
    CLOUDINARY_API_SECRET: str = Field(..., env="CLOUDINARY_API_SECRET")

    CLOUDINARY_URL: str | None = Field(default=None, env="CLOUDINARY_URL")

    # Frontend
    FRONTEND_URL: str | None = Field(default=None, env="FRONTEND_URL")

    # App secrets
    SECRET_KEY: str = Field(..., env="SECRET_KEY")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    ALGORITHM: str = "HS256"
    ADMIN_SECRET: str = Field(..., env="ADMIN_SECRET")

    SECURE_COOKIES: bool = Field(default=False, env="SECURE_COOKIES")

    # Auto-release: seconds after a provider submits work before the escrow is
    # automatically released to them (if the client hasn't released or disputed).
    # Defaults to 1 hour. Lower it (e.g. 120) to demo the scanner on devnet.
    AUTO_RELEASE_SECONDS: int = Field(default=3600, env="AUTO_RELEASE_SECONDS")

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()