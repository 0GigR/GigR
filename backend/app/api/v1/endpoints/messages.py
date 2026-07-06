from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from ....crud.message import get_messages_for_job, create_message, get_messages_for_job_since
from ....crud.job import get_job_by_id
from ....schemas.message import MessageCreate, MessageOut
from ....models.user import User
from ....services.ws_manager import manager
import uuid

router = APIRouter()


def _assert_participant(job, current_user: User) -> None:
    """Raise 403 if current_user is not the client or provider of the job."""
    if job.client_id != current_user.id and job.provider_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a participant in this job")


@router.get("/job/{job_id}", response_model=list[MessageOut])
async def messages_for_job(
    job_id: uuid.UUID,
    since_id: uuid.UUID | None = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    _assert_participant(job, current_user)
    if since_id:
        return await get_messages_for_job_since(db, job_id, since_id)
    return await get_messages_for_job(db, job_id)


@router.post("/", response_model=MessageOut, status_code=status.HTTP_201_CREATED)
async def send_message(
    msg: MessageCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, msg.job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    _assert_participant(job, current_user)
    message = await create_message(db, msg.job_id, current_user.id, msg.content, msg.image_url)
    # Broadcast the new message to all WebSocket clients in this job room
    await manager.broadcast_new_message(message)
    return message
