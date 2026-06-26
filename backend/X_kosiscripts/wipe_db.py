# # backend/wipe_db.py
# import asyncio
# from app.core.database import engine
# from sqlalchemy import text

# async def wipe():
#     async with engine.begin() as conn:
#         await conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres;"))
#         # If your db user isn't postgres, replace with your user, or just:
#         # await conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO your_user;"))
#         # Actually, simpler:
#         # await conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
#     print("Database wiped. Restart the backend to recreate tables.")

# asyncio.run(wipe())

# backend/wipe_db.py
# backend/wipe_db.py
# backend/wipe_db.py
# backend/wipe_db.py
import asyncio
from app.core.database import engine
from sqlalchemy import text

async def wipe():
    async with engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
        # Optional: only if needed, otherwise skip
        await conn.execute(text("GRANT ALL ON SCHEMA public TO enterprisedb"))
    print("Database wiped. Restart the backend to recreate tables.")

async def main():
    await wipe()
    # Dispose engine to close connections gracefully
    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(main())