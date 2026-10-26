import logging
from uuid import UUID
from typing import List
from sqlalchemy import select, desc, or_
from sqlalchemy.ext.asyncio import AsyncSession
from ..models.message import Message
from ..models.job import Job
from ..models.user import User
from ..models.agent_task import AgentTask

logger = logging.getLogger(__name__)

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
    is_agent: bool = False,
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

    # Autonomous auto-reply — skipped for agent-authored messages so two agents
    # can never ping-pong replies at each other forever.
    if not is_agent:
        await _maybe_queue_auto_reply(db, job_id, message)

    return message


async def _maybe_queue_auto_reply(db: AsyncSession, job_id: UUID, message: Message) -> None:
    """Queue an autonomous reply for the recipient, honouring their policy.

    Previously this read the autonomy level inline, spawned a `pending` task
    whose text was re-parsed as NLP, and had no policy gate or rate limit. It
    also fired for messages the agent itself had just sent, which is how an
    agent could end up talking to another agent indefinitely.
    """
    from ..services.agent_policy import (
        AUTONOMY_MARKER,
        resolve_policy,
        within_guardrails,
    )

    job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
    if not job:
        return

    receiver_id = job.provider_id if job.client_id == message.sender_id else job.client_id
    if not receiver_id:
        return

    receiver = (
        await db.execute(select(User).where(User.id == receiver_id))
    ).scalar_one_or_none()
    if not receiver:
        return

    policy = resolve_policy(receiver.ai_settings)
    if not policy.can_auto_reply:
        return
    if not await within_guardrails(
        db, receiver.id, feature="auto_reply", cap=policy.daily_action_cap
    ):
        return

    # Exactly one autonomous reply per incoming message, no matter how many
    # times this fires (retries, duplicate deliveries, double sends).
    already_queued = (await db.execute(
        select(AgentTask)
        .where(
            AgentTask.user_id == receiver.id,
            AgentTask.params["message_id"].astext == str(message.id),
        )
        .limit(1)
    )).scalar_one_or_none()
    if already_queued:
        return

    sender = (
        await db.execute(select(User).where(User.id == message.sender_id))
    ).scalar_one_or_none()

    # Structured params: the handler no longer has to re-parse prose to find out
    # which conversation it is replying into.
    db.add(AgentTask(
        user_id=receiver.id,
        command_text=f"Auto-reply about “{job.title}”",
        task_type="auto_reply",
        params={
            "job_id": str(job_id),
            "message_id": str(message.id),
            "incoming": (message.content or "")[:2000],
            "sender_name": sender.display_name if sender else None,
            "job_title": job.title,
            AUTONOMY_MARKER: "auto_reply",
        },
        status="queued",
    ))
    await db.commit()
    logger.info("[agent] queued auto-reply user=%s job=%s", receiver.id, job_id)

async def delete_message(db: AsyncSession, message: Message) -> None:
    await db.delete(message)
    await db.commit()

async def list_messages_for_jobs(db: AsyncSession, job_ids: List[UUID]) -> List[Message]:
    """Every message on these jobs, oldest first, in one query."""
    if not job_ids:
        return []
    result = await db.execute(
        select(Message)
        .where(Message.job_id.in_(list(job_ids)))
        .order_by(Message.created_at.asc().nulls_last(), Message.id.asc())
    )
    return list(result.scalars().all())


async def list_messages_by_sender(db: AsyncSession, sender_id: UUID) -> List[Message]:
    """Every message the user sent, oldest first, whatever the job.

    Needed because a pre-assignment conversation happens on a job the applicant
    is not the client or the provider of, so the job-based query alone would
    miss the applicant's own side of it.
    """
    result = await db.execute(
        select(Message)
        .where(Message.sender_id == sender_id)
        .order_by(Message.created_at.asc().nulls_last(), Message.id.asc())
    )
    return list(result.scalars().all())
