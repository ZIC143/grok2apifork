from fastapi import APIRouter, Depends, Query

from app.core.auth import verify_app_key
from app.services.grok.services.conversation import get_conversation_store

router = APIRouter()


@router.get("/conversations", dependencies=[Depends(verify_app_key)])
async def list_conversations(
    limit: int = Query(default=100, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
    token: str = Query(default=""),
):
    store = await get_conversation_store()
    data = await store.list(limit=limit, offset=offset, token=token)
    return {"status": "success", **data}


@router.post("/conversations/clear", dependencies=[Depends(verify_app_key)])
async def clear_conversations(payload: dict):
    store = await get_conversation_store()
    deleted = await store.clear(
        conversation_id=str(payload.get("conversation_id") or "").strip(),
        token=str(payload.get("token") or "").strip(),
        expired_only=bool(payload.get("expired_only")),
    )
    return {"status": "success", "deleted": deleted}
