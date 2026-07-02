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

async def get_messages_for_job(
    db: AsyncSession,
    job_id: UUID,
    limit: int = 50,
    offset: int = 0
) -> List[Message]:
    result = await db.execute(
        select(Message)
        .where(Message.job_id == job_id)
        .order_by(Message.created_at.asc())
        .limit(limit)
        .offset(offset)
    )
    return result.scalars().all()

async def get_messages_for_job_since(
    db: AsyncSession,
    job_id: UUID,
    since_id: UUID | None = None,
    limit: int = 50
) -> List[Message]:
    query = select(Message).where(Message.job_id == job_id).order_by(Message.created_at.asc())
    if since_id:
        # Fetch messages after the given id (simple cursor)
        sub = select(Message.created_at).where(Message.id == since_id).scalar_subquery()
        query = query.where(Message.created_at > sub)
    result = await db.execute(query.limit(limit))
    return result.scalars().all()

async def create_message(
    db: AsyncSession,
    job_id: UUID,
    sender_id: UUID,
    content: str,
    image_url: str | None = None
) -> Message:
    message = Message(
        job_id=job_id,
        sender_id=sender_id,
        content=content,
        image_url=image_url
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
            
            # Assuming AI setting key is "aiAutoReplyEnabled"
            if receiver and receiver.ai_settings and receiver.ai_settings.get("aiAutoReplyEnabled") is True:
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