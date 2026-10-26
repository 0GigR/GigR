from uuid import UUID
from typing import Dict, Iterable, List
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..models.category import Category

async def get_category_by_id(db: AsyncSession, category_id: UUID) -> Category | None:
    result = await db.execute(select(Category).where(Category.id == category_id))
    return result.scalar_one_or_none()

async def get_category_by_name(db: AsyncSession, name: str) -> Category | None:
    result = await db.execute(select(Category).where(Category.name == name))
    return result.scalar_one_or_none()

async def list_categories(db: AsyncSession) -> List[Category]:
    result = await db.execute(select(Category).order_by(Category.name))
    return result.scalars().all()

async def create_category(db: AsyncSession, name: str) -> Category:
    category = Category(name=name)
    db.add(category)
    await db.commit()
    await db.refresh(category)
    return category

async def delete_category(db: AsyncSession, category: Category) -> None:
    await db.delete(category)
    await db.commit()

from sqlalchemy import or_

async def search_categories(db: AsyncSession, query: str) -> List[Category]:
    result = await db.execute(
        select(Category).where(Category.name.ilike(f"%{query}%")).order_by(Category.name)
    )
    return result.scalars().all()

async def get_category_names(
    db: AsyncSession, category_ids: Iterable[UUID]
) -> Dict[UUID, str]:
    """Map category ids to their names in one query.

    A job row carries ``category_id``; the fact sentence needs the name, so the
    caller resolves the whole set at once instead of one query per job.
    """
    ids = [category_id for category_id in category_ids if category_id is not None]
    if not ids:
        return {}
    result = await db.execute(
        select(Category.id, Category.name).where(Category.id.in_(ids))
    )
    return {row[0]: row[1] for row in result.all()}
