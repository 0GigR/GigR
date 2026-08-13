from pydantic_settings import BaseSettings
from pydantic import Field, field_validator


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
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24 hours; refresh token handles longer sessions
    ALGORITHM: str = "HS256"
    ADMIN_SECRET: str = Field(..., env="ADMIN_SECRET")

    SECURE_COOKIES: bool = Field(default=True, env="SECURE_COOKIES")

    # Auto-release: seconds after a provider submits work before the escrow is
    # automatically released to them (if the client hasn't released or disputed).
    # Defaults to 1 hour. Lower it (e.g. 120) to demo the scanner on devnet.
    AUTO_RELEASE_SECONDS: int = Field(default=3600, env="AUTO_RELEASE_SECONDS")

    # Startup duplicate-cleanup is heuristic (DISTINCT ON title/price/description)
    # and can DELETE legitimate records — opt-in, OFF by default.
    RUN_STARTUP_CLEANUP: bool = Field(default=False, env="RUN_STARTUP_CLEANUP")

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

    # ── Follow-up nudges (unanswered applications) ─────────────────────────────
    # Background loop reminds clients that providers are waiting and reminds
    # applicants their application hasn't been replied to.
    NUDGE_ENABLED: bool = Field(default=True, env="NUDGE_ENABLED")
    NUDGE_INTERVAL_SECONDS: int = Field(default=1800, env="NUDGE_INTERVAL_SECONDS")
    # Fire only after an application has sat this long with no client reply.
    NUDGE_AFTER_HOURS: int = Field(default=12, env="NUDGE_AFTER_HOURS")
    # Don't re-send the same nudge for this long (per user + job).
    NUDGE_COOLDOWN_HOURS: int = Field(default=72, env="NUDGE_COOLDOWN_HOURS")

    # ── Groq (free LLM + Whisper) ─────────────────────────────────────────────
    # Get a free key at https://console.groq.com (no credit card required)
    # Leave blank to use the built-in rule-based NLP fallback instead.
    GROQ_API_KEY: str = Field(default="", env="GROQ_API_KEY")
    GROQ_API_KEYS: str = Field(default="", env="GROQ_API_KEYS")
    GROQ_MODEL: str = Field(default="llama-3.1-8b-instant", env="GROQ_MODEL")  # llama3-8b-8192 was decommissioned by Groq
    GROQ_WHISPER_MODEL: str = Field(default="whisper-large-v3-turbo", env="GROQ_WHISPER_MODEL")

    @property
    def groq_keys_list(self) -> list[str]:
        keys = []
        if self.GROQ_API_KEY:
            keys.append(self.GROQ_API_KEY)
        if self.GROQ_API_KEYS:
            keys.extend([k.strip() for k in self.GROQ_API_KEYS.split(",") if k.strip()])
        return list(dict.fromkeys(keys))

    TURNSTILE_SECRET_KEY: str | None = Field(default=None, env="TURNSTILE_SECRET_KEY")

    # ── Twilio Voice Calls ────────────────────────────────────────────────────
    # Outbound phone calls from the AI agent (e.g. "your item was found").
    # Get credentials at https://console.twilio.com. Leave blank to disable calling.
    TWILIO_ACCOUNT_SID: str = Field(default="", env="TWILIO_ACCOUNT_SID")
    TWILIO_AUTH_TOKEN: str = Field(default="", env="TWILIO_AUTH_TOKEN")
    # The Twilio number calls are placed FROM (E.164, e.g. +14787805138).
    # Use the SAME number for the same user so they can save it as a contact.
    TWILIO_FROM_NUMBER: str = Field(default="", env="TWILIO_FROM_NUMBER")
    # Master switch for the calling feature (independent of per-user prefs).
    TWILIO_VOICE_ENABLED: bool = Field(default=True, env="TWILIO_VOICE_ENABLED")
    # Validate the X-Twilio-Signature header on public webhook endpoints.
    # Keep True in production; only disable for local testing without a signature.
    TWILIO_VALIDATE_SIGNATURE: bool = Field(default=True, env="TWILIO_VALIDATE_SIGNATURE")
    # Voice used for text-to-speech in the TwiML <Say> verb.
    TWILIO_VOICE: str = Field(default="Polly.Joanna", env="TWILIO_VOICE")

    # Public base URL of THIS backend, reachable by Twilio's servers, with no
    # trailing slash (e.g. https://api.gigr.app or an ngrok URL in dev). Twilio
    # fetches the dynamic TwiML from {PUBLIC_BASE_URL}/api/v1/voice/twiml/{token}.
    PUBLIC_BASE_URL: str | None = Field(default=None, env="PUBLIC_BASE_URL")

    @field_validator("PUBLIC_BASE_URL")
    @classmethod
    def _normalise_public_base_url(cls, v: str | None) -> str | None:
        """Ensure the URL Twilio receives is absolute.

        Twilio's ``Url`` / ``StatusCallback`` params require a scheme; a value like
        ``foo.ngrok-free.dev`` (easy to paste from ngrok) silently breaks every call.
        Prepend ``https://`` when missing and drop any trailing slash.
        """
        if not v:
            return v
        v = v.strip().rstrip("/")
        if not v:
            return None
        if not v.startswith(("http://", "https://")):
            v = "https://" + v
        return v

    @property
    def twilio_enabled(self) -> bool:
        """True only when Twilio is fully configured and switched on."""
        return bool(
            self.TWILIO_VOICE_ENABLED
            and self.TWILIO_ACCOUNT_SID
            and self.TWILIO_AUTH_TOKEN
            and self.TWILIO_FROM_NUMBER
            and self.PUBLIC_BASE_URL
        )

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()