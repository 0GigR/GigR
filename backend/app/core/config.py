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
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 43200 # 30 days
    ALGORITHM: str = "HS256"
    ADMIN_SECRET: str = Field(..., env="ADMIN_SECRET")

    SECURE_COOKIES: bool = Field(default=False, env="SECURE_COOKIES")

    # Auto-release: seconds after a provider submits work before the escrow is
    # automatically released to them (if the client hasn't released or disputed).
    # Defaults to 1 hour. Lower it (e.g. 120) to demo the scanner on devnet.
    AUTO_RELEASE_SECONDS: int = Field(default=3600, env="AUTO_RELEASE_SECONDS")

    # ── AI Agent ──────────────────────────────────────────────────────────────
    # Master switch — set to false to disable background agent task runner
    AI_AGENT_ENABLED: bool = Field(default=True, env="AI_AGENT_ENABLED")
    # How often (seconds) the background worker polls for queued tasks
    AI_AGENT_POLL_INTERVAL_SECONDS: int = Field(default=30, env="AI_AGENT_POLL_INTERVAL_SECONDS")
    # Max simultaneous running tasks
    AI_AGENT_MAX_CONCURRENT_TASKS: int = Field(default=5, env="AI_AGENT_MAX_CONCURRENT_TASKS")
    # Seconds before a running task is declared timed-out / failed
    AI_AGENT_TASK_TIMEOUT_SECONDS: int = Field(default=300, env="AI_AGENT_TASK_TIMEOUT_SECONDS")
    # Whether the agent is allowed to make payments autonomously
    AI_AUTONOMOUS_PAYMENT_ENABLED: bool = Field(default=False, env="AI_AUTONOMOUS_PAYMENT_ENABLED")

    # ── Web Push Notifications ────────────────────────────────────────────────
    VAPID_PUBLIC_KEY: str = Field(default="", env="VAPID_PUBLIC_KEY")
    VAPID_PRIVATE_KEY: str = Field(default="", env="VAPID_PRIVATE_KEY")
    VAPID_CLAIM_EMAIL: str = Field(default="", env="VAPID_CLAIM_EMAIL")

    # ── Groq (free LLM + Whisper) ─────────────────────────────────────────────
    # Get a free key at https://console.groq.com (no credit card required)
    # Leave blank to use the built-in rule-based NLP fallback instead.
    GROQ_API_KEY: str = Field(default="", env="GROQ_API_KEY")
    GROQ_MODEL: str = Field(default="llama3-8b-8192", env="GROQ_MODEL")
    GROQ_WHISPER_MODEL: str = Field(default="whisper-large-v3-turbo", env="GROQ_WHISPER_MODEL")

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()