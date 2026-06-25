from sqlalchemy import text   # <-- add this
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from .config import settings

# Convert postgresql:// to postgresql+asyncpg://
database_url = settings.DATABASE_URL
if database_url.startswith("postgresql://"):
    database_url = database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
elif database_url.startswith("postgresql+asyncpg://"):
    pass
else:
    raise ValueError("Invalid DATABASE_URL scheme. Expected postgresql:// or postgresql+asyncpg://")

engine = create_async_engine(database_url, echo=False, future=True)
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
                        default = f" DEFAULT {col.default.arg}" if col.default and col.default.arg is not None else ""
                        sync_conn.execute(
                            text(
                                f'ALTER TABLE {table_name} ADD COLUMN "{col.name}" {col_type}{nullable}{default}'
                            )
                        )
                        print(f"Added column {col.name} to {table_name}")

        await conn.run_sync(add_missing_columns)

        # ---- One-time cleanup: remove duplicate applications ----
        # Keep the earliest application per (applicant_id, job_id); delete the rest.
        await conn.execute(
            text(
                """
                DELETE FROM applications a
                USING applications b
                WHERE a.applicant_id = b.applicant_id
                  AND a.job_id = b.job_id
                  AND a.created_at > b.created_at
                """
            )
        )