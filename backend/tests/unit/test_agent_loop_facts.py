"""The agent loop stores facts for a task whatever its final status.

The two failures this guards against are easy to introduce and silent: gating the
fact refresh on ``status == "completed"`` (so a job created before a later step
failed never reaches memory), and dropping the JSONB memory patch that completed
tasks built before facts existed (a regression in the opposite direction).
"""

from types import SimpleNamespace
from uuid import uuid4

import app.api.v1.endpoints.ai as ai
from app.core.config import settings


def _task(**overrides):
    task = SimpleNamespace(
        user_id=uuid4(),
        status="completed",
        task_type="post_job",
        params={},
        result=None,
        logs=[],
    )
    for key, value in overrides.items():
        setattr(task, key, value)
    return task


async def _capture(monkeypatch):
    saved = []
    refreshed = []

    async def fake_save(db, user_id, updates):
        saved.append(updates)
        return updates

    async def fake_refresh(db, result):
        refreshed.append(result)
        return []

    monkeypatch.setattr(ai, "_save_memory", fake_save)
    monkeypatch.setattr(ai, "_store_learned_facts", fake_refresh)
    return saved, refreshed


async def test_a_completed_task_still_builds_the_memory_patch(monkeypatch):
    saved, refreshed = await _capture(monkeypatch)
    result = {"created": True, "job_id": "job-1", "price": 5000}
    task = _task(status="completed", task_type="post_job", result=result)

    await ai._store_task_memory(db=None, task=task)

    assert saved == [{"usual_price_job": 5000, "last_active_job_id": "job-1"}]
    assert refreshed == [result]


async def test_a_failed_task_stores_what_it_learned_before_failing(monkeypatch):
    saved, refreshed = await _capture(monkeypatch)
    learned = {"created": True, "job_id": "job-1", "price": 5000}
    task = _task(status="failed", task_type="post_job", result={"error": "boom"})

    await ai._store_task_memory(db=None, task=task, learned_result=learned)

    # The JSONB patch is unchanged: only a completed task writes one.
    assert saved == []
    # The fact refresh still sees the job the task really created.
    assert refreshed == [learned]


async def test_a_failed_task_with_no_learned_result_stores_no_fact(monkeypatch):
    saved, refreshed = await _capture(monkeypatch)
    task = _task(status="failed", task_type="post_job", result={"error": "boom"})

    await ai._store_task_memory(db=None, task=task)

    assert saved == []
    # The error payload carries no marketplace id, and the service ignores it.
    assert refreshed == [{"error": "boom"}]


async def test_a_completed_task_without_a_result_builds_no_patch(monkeypatch):
    saved, refreshed = await _capture(monkeypatch)
    task = _task(status="completed", task_type="post_job", result=None)

    await ai._store_task_memory(db=None, task=task)

    assert saved == []
    assert refreshed == [None]


async def test_the_fact_store_is_inert_with_the_flag_off(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)

    # db is None on purpose: with the flag off the service must return before
    # it reads a row, so passing no session at all proves it never tries.
    assert (
        await ai._store_learned_facts(
            db=None, result={"job_id": str(uuid4()), "created": True}
        )
        == []
    )
