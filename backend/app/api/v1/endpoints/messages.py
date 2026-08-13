from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from ....crud.message import get_messages_for_job, create_message, get_messages_for_job_since
from ....crud.job import get_job_by_id
from ....crud.notification import create_notification
from ....schemas.message import MessageCreate, MessageOut
from ....models.user import User
from ....services.ws_manager import manager
import uuid

router = APIRouter()


def _assert_thread_access(job, current_user: User, applicant_id: uuid.UUID | None) -> None:
    """Authorize access to a message thread.

    - Contract room (applicant_id is None): must be the job's client or provider.
    - Discussion thread (applicant_id set): must be the job's client OR the
      applicant named by applicant_id. Nobody else.
    """
    if applicant_id is None:
        if job.client_id != current_user.id and job.provider_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a participant in this job")
    else:
        if current_user.id != job.client_id and current_user.id != applicant_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a party to this discussion")


@router.get("/job/{job_id}", response_model=list[MessageOut])
async def messages_for_job(
    job_id: uuid.UUID,
    since_id: uuid.UUID | None = Query(None),
    applicant_id: uuid.UUID | None = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    _assert_thread_access(job, current_user, applicant_id)
    if since_id:
        return await get_messages_for_job_since(db, job_id, since_id, applicant_id=applicant_id)
    return await get_messages_for_job(db, job_id, applicant_id=applicant_id)


@router.get("/job/{job_id}/threads")
async def discussion_threads(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Poster-only: list pre-assignment discussion threads for a job, one per
    applicant who has messaged, with the last message preview."""
    from sqlalchemy import select as _select, func as _func
    from ....models.message import Message
    from ....models.user import User as _User

    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if job.client_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the job poster can view discussions")

    # Distinct applicant_ids that have a thread on this job
    rows = await db.execute(
        _select(Message.applicant_id)
        .where(Message.job_id == job_id, Message.applicant_id.isnot(None))
        .distinct()
    )
    applicant_ids = [r[0] for r in rows.all()]

    threads = []
    for aid in applicant_ids:
        last = (await db.execute(
            _select(Message).where(Message.job_id == job_id, Message.applicant_id == aid)
            .order_by(Message.created_at.desc()).limit(1)
        )).scalar_one_or_none()
        applicant = (await db.execute(_select(_User).where(_User.id == aid))).scalar_one_or_none()
        threads.append({
            "applicant_id": str(aid),
            "applicant_name": applicant.display_name if applicant else "Unknown",
            "applicant_image": applicant.profile_image_url if applicant else None,
            "last_message": last.content if last else None,
            "last_at": last.created_at.isoformat() if last and last.created_at else None,
        })
    threads.sort(key=lambda t: t["last_at"] or "", reverse=True)
    return threads


@router.post("/", response_model=MessageOut, status_code=status.HTTP_201_CREATED)
async def send_message(
    msg: MessageCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, msg.job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    _assert_thread_access(job, current_user, msg.applicant_id)
    message = await create_message(db, msg.job_id, current_user.id, msg.content, msg.image_url, applicant_id=msg.applicant_id)

    # Broadcast the new message to all WebSocket clients in this job room
    await manager.broadcast_new_message(message)

    # Determine the recipient for the notification
    if msg.applicant_id is None:
        # Contract room: the other party
        recipient_id = job.provider_id if current_user.id == job.client_id else job.client_id
    else:
        # Discussion thread: if poster sent it, notify the applicant; else notify poster
        recipient_id = msg.applicant_id if current_user.id == job.client_id else job.client_id

    sender_name = current_user.display_name or "Someone"
    if recipient_id:
        await create_notification(
            db,
            user_id=recipient_id,
            title=f"New message from {sender_name}",
            message=msg.content[:100] + ("..." if len(msg.content) > 100 else ""),
            link=f"/dashboard/messages?jobId={job.id}",
            type="message",
            tag=f"chat:{job.id}",
        )
    await db.commit()

    return message
