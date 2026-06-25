from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from ....core.database import async_session
from ....core.security import decode_access_token
from ....services.ws_manager import manager
from ....crud.user import get_user_by_id

router = APIRouter()


@router.websocket("/ws/messages/{job_id}")
async def websocket_messages(
    websocket: WebSocket,
    job_id: str,
    token: str = Query(...),
):
    """WebSocket endpoint for real-time chat per job room.

    Connect with: ws://host/ws/messages/{job_id}?token=<JWT>

    On new messages, the server broadcasts a JSON payload:
    {"type": "new_message", "message": {...MessageOut data...}}
    """
    # Authenticate via token query param
    payload = decode_access_token(token)
    if payload is None:
        await websocket.close(code=4001, reason="Invalid token")
        return

    user_id: str | None = payload.get("sub")
    if user_id is None:
        await websocket.close(code=4001, reason="Invalid token")
        return

    # Use a short-lived DB session only for auth, then release the pool connection.
    # Holding a session for the whole socket lifetime exhausts the pool when the
    # client opens many rooms at once (one socket per job).
    async with async_session() as db:
        user = await get_user_by_id(db, user_id)
    if user is None:
        await websocket.close(code=4001, reason="User not found")
        return

    # Accept connection and join room
    await manager.connect(websocket, job_id)
    try:
        # Keep the connection alive; listen for client messages if needed
        while True:
            data = await websocket.receive_text()
            # Currently we don't process client->server WS messages;
            # messages are sent via POST REST endpoint and broadcasted.
            # This loop just keeps the connection open.
    except WebSocketDisconnect:
        manager.disconnect(websocket, job_id)
    except Exception:
        manager.disconnect(websocket, job_id)