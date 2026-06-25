from fastapi import WebSocket
from typing import Dict, Set
import json
import uuid

class ConnectionManager:
    """Manages WebSocket connections grouped by job (chat room)."""

    def __init__(self):
        # job_id -> set of WebSocket connections
        self._rooms: Dict[str, Set[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, job_id: str):
        await websocket.accept()
        self._rooms.setdefault(job_id, set()).add(websocket)

    def disconnect(self, websocket: WebSocket, job_id: str):
        room = self._rooms.get(job_id)
        if room:
            room.discard(websocket)
            if not room:
                del self._rooms[job_id]

    async def broadcast_new_message(self, message):
        """Broadcast a Message model to its job room (used by chat + auto-notifications)."""
        await self.broadcast_to_job(message.job_id, {"type": "new_message", "message": {
            "id": str(message.id),
            "job_id": str(message.job_id),
            "sender_id": str(message.sender_id),
            "content": message.content,
            "image_url": message.image_url,
            "created_at": message.created_at.isoformat() if message.created_at else None,
        }})

    async def broadcast_to_job(self, job_id: uuid.UUID, message: dict):
        """Send a JSON payload to all WebSocket clients in a job room."""
        room = self._rooms.get(str(job_id))
        if not room:
            return
        payload = json.dumps(message, default=str)
        stale = set()
        for ws in room:
            try:
                await ws.send_text(payload)
            except Exception:
                stale.add(ws)
        # Clean up dead connections
        for ws in stale:
            room.discard(ws)
        if not room:
            del self._rooms[str(job_id)]


manager = ConnectionManager()