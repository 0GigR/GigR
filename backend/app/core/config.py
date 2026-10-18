from pydantic_settings import BaseSettings
from pydantic import Field, field_validator, model_validator
from typing import Optional


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = Field(..., env="DATABASE_URL")

    # ── Payment rail ──────────────────────────────────────────────────────────
    # The DEFAULT escrow rail, used when a caller hasn't picked one. Both rails run
    # side by side: whichever has credentials configured is offered, and the
    # frontend toggle sends the user's choice in the X-Payment-Rail header (see
    # core/rail.py). Left empty it resolves to "solana" if the Solana settings are
    # present (the original app), otherwise "paypal".
    PAYMENT_RAIL: str = Field(default="", env="PAYMENT_RAIL")

    # ── PayPal (REST API v2 Orders + Payments + v1 Payouts + Webhooks) ────────
    # Create a sandbox REST app at https://developer.paypal.com/dashboard/applications
    PAYPAL_CLIENT_ID: str = Field(default="", env="PAYPAL_CLIENT_ID")
    PAYPAL_CLIENT_SECRET: str = Field(default="", env="PAYPAL_CLIENT_SECRET")
    # "sandbox" (default, free test money) or "live".
    PAYPAL_ENV: str = Field(default="sandbox", env="PAYPAL_ENV")
    # Webhook id from the PayPal dashboard; webhook signatures are verified with it.
    PAYPAL_WEBHOOK_ID: str = Field(default="", env="PAYPAL_WEBHOOK_ID")
    # Percentage of every released escrow that Gigr keeps (0 = no fee).
    PLATFORM_FEE_PERCENT: float = Field(default=0.0, env="PLATFORM_FEE_PERCENT")

    # Solana (only required when PAYMENT_RAIL=solana — see _require_rail_config)
    GIGR_PROGRAM_ID: str = Field(default="", env=("GIGR_PROGRAM_ID", "BAROS_PROGRAM_ID"))
    SOLANA_RPC_URL: str = Field(default="", env="SOLANA_RPC_URL")
    PLATFORM_KEYPAIR: str = Field(default="", env="PLATFORM_KEYPAIR")
    WALLET_ENCRYPTION_KEY: str = Field(default="", env="WALLET_ENCRYPTION_KEY")
        # USDC Devnet Mint
    USDC_MINT_DEVNET: str = Field(default="", env="USDC_MINT_DEVNET")

    # Google OAuth
    GOOGLE_CLIENT_ID: str = Field(default="", env="GOOGLE_CLIENT_ID")
    GOOGLE_CLIENT_SECRET: str = Field(default="", env="GOOGLE_CLIENT_SECRET")

    # Brevo
    BREVO_API_KEY: str = Field(default="", env="BREVO_API_KEY")
    BREVO_SENDER_EMAIL: str = Field(default="", env="BREVO_SENDER_EMAIL")

    # ── Free OpenStreetMap geo stack — no API keys, no billing ───────────────
    # Nominatim does forward/reverse geocoding, OSRM does routing/ETA, and the
    # raster tiles come straight from OSM. Nominatim's usage policy REQUIRES a
    # descriptive User-Agent that identifies the deployment, so set
    # GEO_USER_AGENT to something with a contact (email or URL) before launch.
    NOMINATIM_BASE_URL: str = Field(
        default="https://nominatim.openstreetmap.org", env="NOMINATIM_BASE_URL"
    )
    OSRM_BASE_URL: str = Field(
        default="https://router.project-osrm.org", env="OSRM_BASE_URL"
    )
    # Raster tile template, served to the client so tile URLs are not hardcoded
    # in six places. `{s}` is the OSM subdomain placeholder.
    TILE_LIGHT_URL: str = Field(
        default="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        env="TILE_LIGHT_URL",
    )
    GEO_USER_AGENT: str = Field(
        default="Gigr/1.0 (hyperlocal services marketplace)",
        env="GEO_USER_AGENT",
    )
    GEO_HTTP_TIMEOUT_SECONDS: float = Field(default=8.0, env="GEO_HTTP_TIMEOUT_SECONDS")
    # Geocoding results are effectively permanent; routing is not (traffic-free
    # but roads change). Cache both in-process to stay well inside the free
    # services' rate limits.
    GEO_GEOCODE_CACHE_TTL_SECONDS: int = Field(default=86400, env="GEO_GEOCODE_CACHE_TTL_SECONDS")
    GEO_ROUTE_CACHE_TTL_SECONDS: int = Field(default=300, env="GEO_ROUTE_CACHE_TTL_SECONDS")

    # ── Deprecated: Stadia Maps is no longer used ────────────────────────────
    # The Stadia integration was replaced by the free OSM stack above. These are
    # accepted-but-ignored purely so a stale .env or hosting environment that
    # still defines them cannot fail settings validation (pydantic-settings
    # forbids unknown dotenv keys, which would otherwise crash startup). Delete
    # once the keys are gone from every environment.
    STADIA_MAPS_API_KEY: Optional[str] = Field(default=None, env="STADIA_MAPS_API_KEY")
    STADIA_MAPS_BASE_URL: Optional[str] = Field(default=None, env="STADIA_MAPS_BASE_URL")

    # Underdog (compressed-NFT vouches — Solana rail only)
    UNDERDOG_API_KEY: str = Field(default="", env="UNDERDOG_API_KEY")
    UNDERDOG_API_URL: str = Field(default="", env="UNDERDOG_API_URL")

    # Cloudinary
    CLOUDINARY_CLOUD_NAME: str = Field(default="", env="CLOUDINARY_CLOUD_NAME")
    CLOUDINARY_API_KEY: str = Field(default="", env="CLOUDINARY_API_KEY")
    CLOUDINARY_API_SECRET: str = Field(default="", env="CLOUDINARY_API_SECRET")

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
    # NOTE: deliberately NOT honoured — escrow funding always requires a human
    # action. Kept so an existing deployment's env var still validates.
    AI_AUTONOMOUS_PAYMENT_ENABLED: bool = Field(default=False, env="AI_AUTONOMOUS_PAYMENT_ENABLED")
    # Proactive hunting ("total" autonomy): how often to look for unmet needs
    AI_AGENT_PROACTIVE_ENABLED: bool = Field(default=True, env="AI_AGENT_PROACTIVE_ENABLED")
    AI_AGENT_PROACTIVE_INTERVAL_SECONDS: int = Field(
        default=900, env="AI_AGENT_PROACTIVE_INTERVAL_SECONDS"
    )
    # Only consider a job "stale" (needing a hunt) after this long with no applicants
    AI_AGENT_PROACTIVE_MIN_JOB_AGE_MINUTES: int = Field(
        default=10, env="AI_AGENT_PROACTIVE_MIN_JOB_AGE_MINUTES"
    )

    # ── Web Push Notifications ────────────────────────────────────────────────
    VAPID_PUBLIC_KEY: str = Field(default="", env="VAPID_PUBLIC_KEY")
    VAPID_PRIVATE_KEY: str = Field(default="", env="VAPID_PRIVATE_KEY")
    VAPID_CLAIM_EMAIL: str = Field(default="", env="VAPID_CLAIM_EMAIL")

    def validate_vapid_key(self) -> None:
        """Verify the VAPID private key can actually be loaded before any push is sent.

        web push was silently failing for a long time because the send path caught
        every exception and only logged a warning. A truncated or SEC1-format key
        (which cryptography >= 45 refuses to load) made every send throw, and the
        failure was invisible. This runs at startup so a broken key is loud.
        """
        import logging

        logger = logging.getLogger(__name__)
        if not self.VAPID_PRIVATE_KEY or not self.VAPID_PUBLIC_KEY:
            logger.error(
                "[VAPID] VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY are not set — web push will not work. "
                "Generate keys with: npx web-push generate-vapid-keys"
            )
            return

        try:
            from py_vapid import Vapid
            from py_vapid import b64urldecode
            import base64

            # mirror exactly what pywebpush does in Vapid.from_string -> from_der
            value = self.VAPID_PRIVATE_KEY.encode().replace(b"\n", b"")
            der = b64urldecode(value)
            if len(der) == 32:
                Vapid.from_raw(value)
            else:
                Vapid.from_der(value)
        except Exception as exc:
            logger.error(
                "[VAPID] VAPID_PRIVATE_KEY cannot be loaded (%s). Web push will fail for every user. "
                "This usually means the key was truncated when copied or is in the old SEC1 format "
                "(cryptography >= 45 rejects SEC1). Regenerate a pair with `npx web-push "
                "generate-vapid-keys` (PKCS#8 is produced by default) and update BOTH the private "
                "and public key env vars — existing subscriptions will need to re-enable.",
                exc,
            )

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
    # NOTE: Groq retires models regularly. The previous default
    # (llama-3.1-8b-instant) no longer exists on their API, which silently
    # degraded every AI feature to its fallback. groq_client.ensure_working_model()
    # validates this at startup and self-heals if it goes away again.
    GROQ_MODEL: str = Field(default="openai/gpt-oss-120b", env="GROQ_MODEL")
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

    @field_validator("PAYMENT_RAIL")
    @classmethod
    def _normalise_rail(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if v not in ("", "paypal", "solana"):
            raise ValueError("PAYMENT_RAIL must be 'paypal' or 'solana'")
        return v

    @field_validator("PAYPAL_ENV")
    @classmethod
    def _normalise_paypal_env(cls, v: str) -> str:
        v = (v or "sandbox").strip().lower()
        if v not in ("sandbox", "live"):
            raise ValueError("PAYPAL_ENV must be 'sandbox' or 'live'")
        return v

    @model_validator(mode="after")
    def _require_rail_config(self) -> "Settings":
        """Fail at boot — not at the first escrow — when the chosen rail is half-configured.

        The PayPal rail is allowed to boot without credentials so the rest of the
        app (browse, chat, AI) still runs; ``paypal_enabled`` tells the UI whether
        checkout is actually available.
        """
        if not self.PAYMENT_RAIL:
            self.PAYMENT_RAIL = "solana" if self.solana_enabled else "paypal"
        if self.PAYMENT_RAIL == "solana":
            missing = [
                name for name in (
                    "GIGR_PROGRAM_ID", "SOLANA_RPC_URL", "PLATFORM_KEYPAIR",
                    "WALLET_ENCRYPTION_KEY", "USDC_MINT_DEVNET",
                )
                if not getattr(self, name)
            ]
            if missing:
                raise ValueError(
                    "PAYMENT_RAIL=solana requires these settings: " + ", ".join(missing)
                )
        return self

    @property
    def solana_enabled(self) -> bool:
        """True when every Solana setting is present."""
        return all(
            getattr(self, name)
            for name in ("GIGR_PROGRAM_ID", "SOLANA_RPC_URL", "PLATFORM_KEYPAIR",
                         "WALLET_ENCRYPTION_KEY", "USDC_MINT_DEVNET")
        )

    @property
    def available_rails(self) -> list:
        """Rails a caller may choose between. The default rail is always listed."""
        rails = []
        if self.solana_enabled or self.PAYMENT_RAIL == "solana":
            rails.append("solana")
        if self.paypal_enabled or self.PAYMENT_RAIL == "paypal":
            rails.append("paypal")
        return rails

    @property
    def paypal_enabled(self) -> bool:
        """True when PayPal REST credentials are present."""
        return bool(self.PAYPAL_CLIENT_ID and self.PAYPAL_CLIENT_SECRET)

    @property
    def paypal_base_url(self) -> str:
        return (
            "https://api-m.paypal.com"
            if self.PAYPAL_ENV == "live"
            else "https://api-m.sandbox.paypal.com"
        )

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

    # ── Agent feature flags ────────────────────────────────────────────────────
    # All FEATURE_AGENT_* flags are declared here and read ONLY from this module.
    # Never call os.getenv or process.env for these elsewhere in the codebase.
    # Default: all open (False only for premium/unbuilt features).
    FEATURE_AGENT_MULTI_TURN: bool = Field(
        default=True, env="FEATURE_AGENT_MULTI_TURN"
    )
    FEATURE_AGENT_REASONING_VISIBLE: bool = Field(
        default=True, env="FEATURE_AGENT_REASONING_VISIBLE"
    )
    FEATURE_AGENT_MAP_RESULTS: bool = Field(
        default=True, env="FEATURE_AGENT_MAP_RESULTS"
    )
    FEATURE_AGENT_PROACTIVE_SURFACE: bool = Field(
        default=True, env="FEATURE_AGENT_PROACTIVE_SURFACE"
    )
    FEATURE_AGENT_STREAMING: bool = Field(
        default=False, env="FEATURE_AGENT_STREAMING"
    )
    FEATURE_AGENT_SMART_APPLY: bool = Field(
        default=False, env="FEATURE_AGENT_SMART_APPLY"
    )
    FEATURE_AGENT_PLANNER: bool = Field(
        default=False, env="FEATURE_AGENT_PLANNER"
    )
    # Off by default. Flip to True when a payment subscription check is wired.
    FEATURE_AGENT_PREMIUM: bool = Field(
        default=False, env="FEATURE_AGENT_PREMIUM"
    )
    FEATURE_AGENT_GUARDRAILS: bool = Field(
        default=True, env="FEATURE_AGENT_GUARDRAILS"
    )
    FEATURE_AGENT_COMMAND_PALETTE: bool = Field(
        default=True, env="FEATURE_AGENT_COMMAND_PALETTE"
    )

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()