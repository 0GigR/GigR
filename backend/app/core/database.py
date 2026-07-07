import logging
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from .config import settings

logger = logging.getLogger(__name__)

# Convert postgresql:// to postgresql+asyncpg://
database_url = settings.DATABASE_URL
if database_url.startswith("postgresql://"):
    database_url = database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
elif database_url.startswith("postgresql+asyncpg://"):
    pass
else:
    raise ValueError("Invalid DATABASE_URL scheme. Expected postgresql:// or postgresql+asyncpg://")

import os as _os

# Vercel / serverless: use NullPool to avoid exhausting PgBouncer's session-mode
# connection limit. Each request gets its own connection and closes it immediately.
# On a dedicated server (local dev, Railway, Render) we keep the normal pool.
_is_serverless = _os.getenv("VERCEL") or _os.getenv("AWS_LAMBDA_FUNCTION_NAME")

if _is_serverless:
    from sqlalchemy.pool import NullPool
    engine = create_async_engine(
        database_url,
        echo=False,
        future=True,
        poolclass=NullPool,
        connect_args={
            "statement_cache_size": 0,
            "prepared_statement_cache_size": 0,
            "server_settings": {
                "application_name": "gigr_backend",
            },
        },
    )
else:
    engine = create_async_engine(
        database_url,
        echo=False,
        future=True,
        pool_size=5,
        max_overflow=2,
        pool_pre_ping=True,
        pool_recycle=1800,
        connect_args={
            "statement_cache_size": 0,
            "prepared_statement_cache_size": 0,
            "server_settings": {
                "application_name": "gigr_backend",
            },
        },
    )

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass

# async def init_db() -> None: 
#     """
#     Create all tables that don't yet exist. This is safe to run on every startup.
#     It will NOT drop or modify existing tables.
#     """
#     async with engine.begin() as conn:
#         # Create tables (checkfirst=True avoids trying to create existing ones)
#         await conn.run_sync(Base.metadata.create_all, checkfirst=True)
#         # Activate PostGIS extension if needed
#         await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))

async def init_db() -> None:
    async with engine.begin() as conn:
        # Create missing tables
        await conn.run_sync(Base.metadata.create_all, checkfirst=True)
        # Ensure PostGIS extension
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))

        # ---- Auto-migrate: add missing columns ----
        # For each model, check if columns exist, if not, add them
        from sqlalchemy import inspect as schema_inspect

        def add_missing_columns(sync_conn):
            inspector = schema_inspect(sync_conn)
            for table_name, table_class in Base.metadata.tables.items():
                try:
                    existing_cols = [col["name"] for col in inspector.get_columns(table_name)]
                except Exception:
                    continue  # table doesn't exist yet, create_all will handle it
                for col in table_class.columns:
                    if col.name not in existing_cols:
                        # Build the ALTER TABLE statement
                        col_type = col.type.compile(sync_conn.dialect)
                        nullable = "" if col.nullable else " NOT NULL"

                        # Build a SQL-safe DEFAULT clause
                        default = ""
                        if col.default and col.default.arg is not None:
                            raw = col.default.arg
                            type_str = col_type.upper()
                            if "JSONB" in type_str or "JSON" in type_str:
                                # JSONB defaults must be quoted: '{}'::jsonb
                                default = f" DEFAULT '{raw}'::jsonb"
                            elif isinstance(raw, bool):
                                default = f" DEFAULT {'TRUE' if raw else 'FALSE'}"
                            elif isinstance(raw, (int, float)):
                                default = f" DEFAULT {raw}"
                            elif isinstance(raw, list):
                                # Postgres array literal is {}
                                # For now, we only handle empty list safely
                                if not raw:
                                    default = f" DEFAULT '{{}}'::{type_str}"
                                else:
                                    # Fallback for non-empty lists (assuming string contents)
                                    joined = ",".join(f'"{str(x).replace(chr(34), chr(34)+chr(34))}"' for x in raw)
                                    default = f" DEFAULT '{{{joined}}}'::{type_str}"
                            else:
                                # String/text: wrap in single quotes, escape any inner quotes
                                escaped = str(raw).replace("'", "''")
                                default = f" DEFAULT '{escaped}'"

                        sync_conn.execute(
                            text(
                                f'ALTER TABLE {table_name} ADD COLUMN "{col.name}" {col_type}{nullable}{default}'
                            )
                        )
                        logger.info("[init_db] Added column '%s' to '%s'", col.name, table_name)

        await conn.run_sync(add_missing_columns)

        # ---- One-time cleanup: remove duplicate applications / service requests ----
        # If the same user applies to the same job (or requests the same service)
        # multiple times within 60 seconds, keep only the earliest record.
        try:
            # ===================================================================
            # GLOBAL DUPLICATE CLEANUP (omnipotent version)
            # Deletes child rows first, then parent rows, in dependency order.
            # Keeps the earliest record per logical group using DISTINCT ON.
            # ===================================================================

            # ---- helpers ----
            KEEP_JOB = """
                SELECT DISTINCT ON (client_id, title, price, COALESCE(description,''), status)
                    id
                FROM jobs
                ORDER BY client_id, title, price, COALESCE(description,''), status, created_at ASC
            """
            KEEP_SVC = """
                SELECT DISTINCT ON (provider_id, title, price, COALESCE(description,''))
                    id
                FROM service_listings
                ORDER BY provider_id, title, price, COALESCE(description,''), created_at ASC
            """
            KEEP_APP = """
                SELECT DISTINCT ON (applicant_id, job_id)
                    id
                FROM applications
                ORDER BY applicant_id, job_id, created_at ASC
            """

            # IDs of all duplicate jobs (open/requested)
            DUPE_JOB_IDS = f"SELECT id FROM jobs WHERE status IN ('open','requested') AND id NOT IN ({KEEP_JOB})"

            # IDs of jobs referencing duplicate service listings
            DUPE_SVC_JOB_IDS = f"""
                SELECT id FROM jobs
                WHERE service_listing_id IN (
                    SELECT id FROM service_listings WHERE id NOT IN ({KEEP_SVC})
                )
            """

            # Union of all job IDs that will be deleted
            ALL_DELETED_JOB_IDS = f"({DUPE_JOB_IDS}) UNION ({DUPE_SVC_JOB_IDS})"

            # ─── 1. Child tables referencing ANY job that will be deleted ───
            for tbl in ["messages", "scope_amendments", "disputes", "vouches",
                        "applications"]:
                await conn.execute(
                    text(f"DELETE FROM {tbl} WHERE job_id IN ({ALL_DELETED_JOB_IDS})")
                )

            # ─── 2. Duplicate APPLICATIONS (direct) ─────────────────────────
            await conn.execute(
                text(f"DELETE FROM applications WHERE id NOT IN ({KEEP_APP})")
            )

            # ─── 3. Duplicate JOBS (open & requested) ───────────────────────
            for status in ["open", "requested"]:
                await conn.execute(
                    text(f"""
                        DELETE FROM jobs
                        WHERE status = '{status}'
                        AND id NOT IN ({KEEP_JOB})
                    """)
                )

            # ─── 4. Jobs referencing duplicate service listings ─────────────
            await conn.execute(
                text(f"DELETE FROM jobs WHERE id IN ({DUPE_SVC_JOB_IDS})")
            )

            # ─── 5. Duplicate SERVICE LISTINGS ──────────────────────────────
            await conn.execute(
                text(f"DELETE FROM service_listings WHERE id NOT IN ({KEEP_SVC})")
            )

            logger.info("[init_db] Duplicate cleanup completed successfully.")

        except Exception as e:
            logger.warning("[init_db] Duplicate cleanup skipped: %s", e)