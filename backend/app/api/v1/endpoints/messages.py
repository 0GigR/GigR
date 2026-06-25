from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from ....crud.message import get_messages_for_job, create_message, get_messages_for_job_since
from ....schemas.message import MessageCreate, MessageOut
from ....models.user import User
from ....services.ws_manager import manager
import uuid

router = APIRouter()


@router.get("/job/{job_id}", response_model=list[MessageOut])
async def messages_for_job(
    job_id: uuid.UUID,
    since_id: uuid.UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    if since_id:
        return await get_messages_for_job_since(db, job_id, since_id)
    return await get_messages_for_job(db, job_id)


@router.post("/", response_model=MessageOut, status_code=status.HTTP_201_CREATED)
async def send_message(
    msg: MessageCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    message = await create_message(db, msg.job_id, current_user.id, msg.content, msg.image_url)
    # Broadcast the new message to all WebSocket clients in this job room
    await manager.broadcast_new_message(message)
    return message
