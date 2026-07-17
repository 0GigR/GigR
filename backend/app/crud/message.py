from uuid import UUID
from typing import List
from sqlalchemy import select, desc, or_
from sqlalchemy.ext.asyncio import AsyncSession
from ..models.message import Message
from ..models.job import Job
from ..models.user import User
from ..models.agent_task import AgentTask

async def get_message_by_id(db: AsyncSession, message_id: UUID) -> Message | None:
    result = await db.execute(select(Message).where(Message.id == message_id))
    return result.scalar_one_or_none()


def _flatten_message_row(row) -> dict:
    """Flatten a (Message, sender_name, sender_image_url) result row into a single
    dict so MessageOut sees id/job_id/sender_id/content/created_at at the top level,
    alongside the joined sender fields. Without this, ``.mappings()`` nests the ORM
    object under a "Message" key and Pydantic reports those fields as missing.
    """
    msg: Message = row["Message"]
    return {
        "id": msg.id,
        "job_id": msg.job_id,
        "sender_id": msg.sender_id,
        "content": msg.content,
        "image_url": msg.image_url,
        "applicant_id": msg.applicant_id,
        "created_at": msg.created_at,
        "sender_name": row["sender_name"],
        "sender_image_url": row["sender_image_url"],
    }


async def get_messages_for_job(
    db: AsyncSession,
    job_id: UUID,
    limit: int = 50,
    offset: int = 0,
    applicant_id: UUID | None = None,
):
    query = (
        select(Message, User.display_name.label("sender_name"), User.profile_image_url.label("sender_image_url"))
        .outerjoin(User, Message.sender_id == User.id)
        .where(Message.job_id == job_id)
    )
    # applicant_id None => contract room thread (NULL rows); set => that thread
    query = query.where(Message.applicant_id == applicant_id)
    query = query.order_by(Message.created_at.asc()).limit(limit).offset(offset)
    result = await db.execute(query)
    # Flatten each row so Pydantic sees the Message fields + joined sender fields.
    return [_flatten_message_row(r) for r in result.mappings().all()]

async def get_messages_for_job_since(
    db: AsyncSession,
    job_id: UUID,
    since_id: UUID | None = None,
    limit: int = 50,
    applicant_id: UUID | None = None,
):
    query = (
        select(Message, User.display_name.label("sender_name"), User.profile_image_url.label("sender_image_url"))
        .outerjoin(User, Message.sender_id == User.id)
        .where(Message.job_id == job_id)
        .where(Message.applicant_id == applicant_id)
        .order_by(Message.created_at.asc())
    )
    if since_id:
        # Fetch messages after the given id (simple cursor)
        sub = select(Message.created_at).where(Message.id == since_id).scalar_subquery()
        query = query.where(Message.created_at > sub)
    result = await db.execute(query.limit(limit))
    return [_flatten_message_row(r) for r in result.mappings().all()]

async def create_message(
    db: AsyncSession,
    job_id: UUID,
    sender_id: UUID,
    content: str,
    image_url: str | None = None,
    applicant_id: UUID | None = None,
) -> Message:
    message = Message(
        job_id=job_id,
        sender_id=sender_id,
        content=content,
        image_url=image_url,
        applicant_id=applicant_id,
    )
    db.add(message)
    await db.commit()
    await db.refresh(message)
    
    # Check if the receiver has AI auto-reply enabled
    # Find the job to determine the receiver
    job_result = await db.execute(select(Job).where(Job.id == job_id))
    job = job_result.scalar_one_or_none()
    
    if job:
        receiver_id = job.provider_id if job.client_id == sender_id else job.client_id
        if receiver_id:
            receiver_result = await db.execute(select(User).where(User.id == receiver_id))
            receiver = receiver_result.scalar_one_or_none()
            
            # Assuming AI setting key is "autonomyLevel"
            if receiver and receiver.ai_settings and receiver.ai_settings.get("autonomyLevel") in ["low", "medium", "high", "total"]:
                # Spawn an AgentTask for the receiver to auto-reply to this message
                reply_command = f"Reply to this message: '{content}' (From {job.title})"
                auto_reply_task = AgentTask(
                    user_id=receiver.id,
                    command_text=reply_command,
                    task_type="pending",
                    status="queued"
                )
                db.add(auto_reply_task)
                await db.commit()

    return message

async def delete_message(db: AsyncSession, message: Message) -> None:
    await db.delete(message)
    await db.commit()