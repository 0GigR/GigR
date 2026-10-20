"""Unit tests for the Gigr Self-Healing Service.

Verifies:
- Reverting prematurely completed jobs (unreleased milestones or unpaid balances)
- Advancing unmarked completed jobs (all milestones released and fully paid)
- Restoring missing 1h review timers on submitted milestones
- Synchronizing open disputes with parent job status
- Failing stuck agent tasks past timeout
- Purging expired password reset tokens
- Strict verification of no-emoji policy per house-standard.md
"""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import os
import re
import uuid

import pytest

from app.models.agent_task import AgentTask
from app.models.dispute import Dispute, DisputeStatus
from app.models.job import Job
from app.models.milestone import JobMilestone
from app.models.password_reset_token import PasswordResetToken
from app.models.voice_call import VoiceCall
from app.services.self_healing_service import (
    heal_prematurely_completed_jobs,
    heal_unmarked_completed_jobs,
    heal_stuck_review_timers,
    heal_disputed_jobs_desync,
    heal_stuck_agent_tasks,
    heal_expired_password_reset_tokens,
    heal_stale_voice_calls,
    run_all_heals,
)


class _Rows:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self):
        unpacked = [r[0] if isinstance(r, tuple) else r for r in self.rows]
        return _Rows(unpacked)

    def all(self):
        return list(self.rows)

    def scalar_one(self):
        return self.rows[0] if self.rows else 0

    def scalar_one_or_none(self):
        return self.rows[0] if self.rows else None


class MockAsyncSession:
    def __init__(self, entities=None):
        self.entities = entities or {}
        self.committed = False
        self.rollbacked = False
        self.deleted = []

    async def execute(self, statement):
        table_name = getattr(statement.table, "name", "") if hasattr(statement, "table") else ""
        query_str = str(statement).lower()

        # Handle password reset tokens count & delete
        if "password_reset_tokens" in query_str:
            tokens = self.entities.get(PasswordResetToken, [])
            if "count(" in query_str:
                return _Rows([len(tokens)])
            if "delete" in query_str:
                self.deleted.extend(tokens)
                self.entities[PasswordResetToken] = []
                return _Rows([])
            return _Rows(tokens)

        # Handle JobMilestone queries
        if "job_milestones" in query_str:
            milestones = self.entities.get(JobMilestone, [])
            # If query filters by job_id, we can return milestones for that job
            return _Rows(milestones)

        # Handle Job queries
        if "jobs" in query_str and "disputes" not in query_str:
            jobs = self.entities.get(Job, [])
            return _Rows(jobs)

        # Handle Dispute join query
        if "disputes" in query_str:
            disputes = self.entities.get(Dispute, [])
            jobs = self.entities.get(Job, [])
            joined = []
            for d in disputes:
                for j in jobs:
                    if d.job_id == j.id:
                        joined.append((d, j))
            return _Rows(joined)

        # Handle AgentTask queries
        if "agent_tasks" in query_str:
            tasks = self.entities.get(AgentTask, [])
            return _Rows(tasks)

        # Handle VoiceCall queries
        if "voice_calls" in query_str:
            calls = self.entities.get(VoiceCall, [])
            return _Rows(calls)

        return _Rows([])

    async def commit(self):
        self.committed = True

    async def rollback(self):
        self.rollbacked = True


@pytest.mark.asyncio
async def test_revert_prematurely_completed_job_with_partial_release():
    """Job marked completed with release < price should be reverted to in_progress."""
    job = Job(
        id=uuid.uuid4(),
        client_id=uuid.uuid4(),
        title="House Painting",
        description="Paint entire duplex",
        status="completed",
        price=Decimal("100.00"),
    )
    milestone = JobMilestone(
        id=uuid.uuid4(),
        job_id=job.id,
        title="Deposit",
        amount=Decimal("50.00"),
        status="released",
        contract_milestone_id="hex01",
    )

    db = MockAsyncSession({Job: [job], JobMilestone: [milestone]})
    res = await heal_prematurely_completed_jobs(db, dry_run=False)

    assert res.status == "healed"
    assert res.items_healed == 1
    assert job.status == "in_progress"


@pytest.mark.asyncio
async def test_revert_prematurely_completed_job_with_unreleased_milestone():
    """Job marked completed with a pending milestone should be reverted to in_progress."""
    job = Job(
        id=uuid.uuid4(),
        client_id=uuid.uuid4(),
        title="Roof Repair",
        description="Fix leak",
        status="completed",
        price=Decimal("200.00"),
    )
    m1 = JobMilestone(
        id=uuid.uuid4(),
        job_id=job.id,
        title="Phase 1",
        amount=Decimal("100.00"),
        status="released",
        contract_milestone_id="hex02",
    )
    m2 = JobMilestone(
        id=uuid.uuid4(),
        job_id=job.id,
        title="Phase 2",
        amount=Decimal("100.00"),
        status="pending",
        contract_milestone_id="hex03",
    )

    db = MockAsyncSession({Job: [job], JobMilestone: [m1, m2]})
    res = await heal_prematurely_completed_jobs(db, dry_run=False)

    assert res.status == "healed"
    assert job.status == "in_progress"


@pytest.mark.asyncio
async def test_advance_unmarked_completed_job():
    """Job in progress with all milestones released should advance to completed."""
    job = Job(
        id=uuid.uuid4(),
        client_id=uuid.uuid4(),
        title="AC Servicing",
        description="Clean filters",
        status="in_progress",
        price=Decimal("80.00"),
    )
    m1 = JobMilestone(
        id=uuid.uuid4(),
        job_id=job.id,
        title="Full Service",
        amount=Decimal("80.00"),
        status="released",
        contract_milestone_id="hex04",
    )

    db = MockAsyncSession({Job: [job], JobMilestone: [m1]})
    res = await heal_unmarked_completed_jobs(db, dry_run=False)

    assert res.status == "healed"
    assert res.items_healed == 1
    assert job.status == "completed"


@pytest.mark.asyncio
async def test_heal_stuck_review_timer():
    """Milestone under review without auto_release_at should have timer initialized."""
    milestone = JobMilestone(
        id=uuid.uuid4(),
        job_id=uuid.uuid4(),
        title="Deliverable",
        amount=Decimal("50.00"),
        status="under_review",
        auto_release_at=None,
        contract_milestone_id="hex05",
    )

    db = MockAsyncSession({JobMilestone: [milestone], Job: []})
    res = await heal_stuck_review_timers(db, dry_run=False)

    assert res.status == "healed"
    assert res.items_healed == 1
    assert milestone.auto_release_at is not None
    assert milestone.work_submitted_at is not None


@pytest.mark.asyncio
async def test_heal_dispute_job_desync():
    """Open dispute must force parent job status to disputed."""
    job_id = uuid.uuid4()
    job = Job(
        id=job_id,
        client_id=uuid.uuid4(),
        title="Carpentry",
        description="Custom desk",
        status="in_progress",
        price=Decimal("150.00"),
    )
    dispute = Dispute(
        id=uuid.uuid4(),
        job_id=job_id,
        client_id=job.client_id,
        provider_id=uuid.uuid4(),
        raised_by=job.client_id,
        reason="Poor craftsmanship",
        status=DisputeStatus.OPEN,
    )

    db = MockAsyncSession({Job: [job], Dispute: [dispute]})
    res = await heal_disputed_jobs_desync(db, dry_run=False)

    assert res.status == "healed"
    assert res.items_healed == 1
    assert job.status == "disputed"


@pytest.mark.asyncio
async def test_heal_stuck_agent_task():
    """AgentTask running longer than timeout threshold must be marked failed."""
    old_time = datetime.now(timezone.utc) - timedelta(minutes=25)
    task = AgentTask(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        command_text="find a plumber near me",
        task_type="search",
        status="running",
        created_at=old_time,
    )

    db = MockAsyncSession({AgentTask: [task]})
    res = await heal_stuck_agent_tasks(db, dry_run=False)

    assert res.status == "healed"
    assert res.items_healed == 1
    assert task.status == "failed"
    assert "auto-healed" in task.result["error"]


@pytest.mark.asyncio
async def test_heal_expired_password_reset_tokens():
    """Expired reset tokens older than 24 hours must be purged."""
    expired_token = PasswordResetToken(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        token_hash="abc123hash",
        expires_at=datetime.now(timezone.utc) - timedelta(days=2),
    )

    db = MockAsyncSession({PasswordResetToken: [expired_token]})
    res = await heal_expired_password_reset_tokens(db, dry_run=False)

    assert res.status == "healed"
    assert res.items_healed == 1
    assert len(db.deleted) == 1


@pytest.mark.asyncio
async def test_heal_stale_voice_calls():
    """Stale uncompleted voice calls past 1 hour must be set to failed."""
    stale_call = VoiceCall(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        token="rand_token_123",
        to_number="+2348012345678",
        message="Hello from agent",
        status="queued",
        created_at=datetime.now(timezone.utc) - timedelta(hours=2),
    )

    db = MockAsyncSession({VoiceCall: [stale_call]})
    res = await heal_stale_voice_calls(db, dry_run=False)

    assert res.status == "healed"
    assert res.items_healed == 1
    assert stale_call.status == "failed"


def test_strict_no_emojis_in_self_healing_codebase():
    """Enforce house-standard.md rule: No emojis. Ever. Anywhere in the codebase."""
    emoji_regex = re.compile(r"[\U00010000-\U0010ffff]")
    target_files = [
        "backend/app/services/self_healing_service.py",
        "backend/scripts/run_self_heal.py",
        "backend/tests/unit/test_self_healer.py",
    ]

    for file_path in target_files:
        full_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../..", file_path))
        if os.path.exists(full_path):
            with open(full_path, "r", encoding="utf-8") as f:
                content = f.read()
                matches = emoji_regex.findall(content)
                assert len(matches) == 0, f"Found prohibited emoji(s) in {file_path}: {matches}"
