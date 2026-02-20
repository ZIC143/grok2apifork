from fastapi import APIRouter, Depends, Query

from app.core.auth import verify_app_key
from app.services.grok.services.conversation import get_conversation_store
from app.services.grok.services.request_stats import get_request_stats_store

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


@router.get("/stats/trend", dependencies=[Depends(verify_app_key)])
async def request_stats_trend(
    window: str = Query(default="24h"),
    bucket: str = Query(default="hour"),
):
    window_map = {
        "24h": 24 * 3600,
        "7d": 7 * 24 * 3600,
    }
    window_sec = window_map.get(str(window).lower(), 24 * 3600)
    bucket_value = "day" if str(bucket).lower() == "day" else "hour"
    store = await get_request_stats_store()
    data = await store.trend(window_sec=window_sec, bucket=bucket_value)
    return {"status": "success", **data}


@router.get("/stats/models", dependencies=[Depends(verify_app_key)])
async def request_stats_models(window: str = Query(default="24h")):
    window_map = {
        "24h": 24 * 3600,
        "7d": 7 * 24 * 3600,
    }
    window_sec = window_map.get(str(window).lower(), 24 * 3600)
    store = await get_request_stats_store()
    data = await store.model_distribution(window_sec=window_sec)
    return {"status": "success", **data}
