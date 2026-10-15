"""Agent session service — multi-turn conversational context management.

Maintains lightweight, bounded conversational context for multi-turn interactions
(e.g., "find a plumber", followed by "make it cheaper", "how about in Ikeja instead").
Sessions expire after an inactivity TTL (default 30 minutes).
"""

from __future__ import annotations

import logging
import time
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 1800  # 30 minutes
MAX_TURNS_PER_SESSION = 10
MAX_SESSIONS = 1000


class _SessionStore:
    def __init__(self) -> None:
        self._sessions: Dict[str, Dict[str, any]] = {}

    def _prune_expired(self) -> None:
        now = time.time()
        expired = [
            sid for sid, session_entry in self._sessions.items()
            if now - session_entry.get("last_active", 0) > SESSION_TTL_SECONDS
        ]
        for sid in expired:
            self._sessions.pop(sid, None)

        if len(self._sessions) > MAX_SESSIONS:
            sorted_by_activity = sorted(
                self._sessions.items(),
                key=lambda item: item[1].get("last_active", 0),
            )
            for sid, _ in sorted_by_activity[: len(self._sessions) - MAX_SESSIONS]:
                self._sessions.pop(sid, None)

    def get_history(self, session_id: Optional[str]) -> List[Dict[str, str]]:
        """Return the pruned list of message turns for the session."""
        if not session_id:
            return []
        self._prune_expired()
        session = self._sessions.get(session_id)
        if not session:
            return []
        session["last_active"] = time.time()
        return list(session.get("messages", []))

    def record_turn(
        self,
        session_id: Optional[str],
        user_message: str,
        assistant_response: str,
    ) -> None:
        """Append a user/assistant turn to the active session history."""
        if not session_id or not user_message:
            return
        self._prune_expired()
        now = time.time()
        if session_id not in self._sessions:
            self._sessions[session_id] = {
                "messages": [],
                "last_active": now,
            }

        session = self._sessions[session_id]
        session["last_active"] = now
        messages: List[Dict[str, str]] = session["messages"]

        messages.append({"role": "user", "content": user_message.strip()})
        if assistant_response:
            messages.append({"role": "assistant", "content": assistant_response.strip()})

        if len(messages) > MAX_TURNS_PER_SESSION * 2:
            session["messages"] = messages[-(MAX_TURNS_PER_SESSION * 2):]

    def clear(self, session_id: str) -> None:
        """Evict a session from memory."""
        self._sessions.pop(session_id, None)


_store = _SessionStore()


def get_session_history(session_id: Optional[str]) -> List[Dict[str, str]]:
    """Get conversation history for session_id."""
    return _store.get_history(session_id)


def record_session_turn(
    session_id: Optional[str],
    user_message: str,
    assistant_response: str,
) -> None:
    """Record an interaction turn in session_id."""
    _store.record_turn(session_id, user_message, assistant_response)


def clear_session(session_id: str) -> None:
    """Clear conversation history for session_id."""
    _store.clear(session_id)
