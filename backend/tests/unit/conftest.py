"""Unit tests here need no database: override the parent conftest's DB-bound fixtures."""
import os

# Settings are read at import time; give the app harmless values so importing it works.
os.environ.setdefault("DATABASE_URL", "postgresql://u:p@localhost:5432/unit")
os.environ.setdefault("SECRET_KEY", "unit-test-secret")
os.environ.setdefault("ADMIN_SECRET", "unit-test-admin")

import pytest


@pytest.fixture(scope="session")
async def db_ready():
    return None


@pytest.fixture(scope="session", autouse=True)
async def cleanup_session(db_ready):
    yield
