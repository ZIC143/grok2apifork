"""
Conversation state manager for real conversation continuation.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import aiofiles
import orjson

from app.core.config import get_config
from app.core.logger import logger

DATA_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data"
CONVERSATION_FILE = DATA_DIR / "conversations.json"


class ConversationStore:
    def __init__(self):
        self._lock = asyncio.Lock()
        self._loaded = False
        self._records: Dict[str, Dict[str, Any]] = {}

    async def _load(self):
        if self._loaded:
            return
        self._loaded = True
        if not CONVERSATION_FILE.exists():
            return
        try:
            async with aiofiles.open(CONVERSATION_FILE, "rb") as f:
                raw = await f.read()
            data = orjson.loads(raw)
            if isinstance(data, dict):
                self._records = data
        except Exception as e:
            logger.warning(f"ConversationStore load failed: {e}")
            self._records = {}

    async def _save(self):
        try:
            CONVERSATION_FILE.parent.mkdir(parents=True, exist_ok=True)
            async with aiofiles.open(CONVERSATION_FILE, "wb") as f:
                await f.write(orjson.dumps(self._records))
        except Exception as e:
            logger.warning(f"ConversationStore save failed: {e}")

    def _cleanup_expired_inplace(self):
        now = self._now()
        self._records = {
            cid: item
            for cid, item in self._records.items()
            if isinstance(item, dict) and int(item.get("expires_at", 0) or 0) > now
        }

    def _ttl_seconds(self) -> int:
        value = get_config("chat.conversation_ttl", 72000)
        try:
            v = int(value)
            return max(60, v)
        except Exception:
            return 72000

    def _now(self) -> int:
        return int(time.time())

    def _hash_messages(self, messages: List[Dict[str, Any]], exclude_last_user: bool) -> str:
        system_parts: List[str] = []
        user_parts: List[str] = []

        def _to_text(content: Any) -> str:
            if isinstance(content, str):
                return content.strip()
            if isinstance(content, list):
                pieces: List[str] = []
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    t = item.get("type")
                    if t == "text":
                        val = item.get("text", "")
                        if isinstance(val, str):
                            pieces.append(val.strip())
                return "\n".join([p for p in pieces if p])
            return ""

        normalized: List[Tuple[str, str]] = []
        for msg in messages:
            role = str(msg.get("role") or "user")
            text = _to_text(msg.get("content"))
            if not text:
                continue
            normalized.append((role, text))

        if exclude_last_user:
            for i in range(len(normalized) - 1, -1, -1):
                if normalized[i][0] == "user":
                    normalized.pop(i)
                    break

        for role, text in normalized:
            if role == "system":
                system_parts.append(text)
            elif role == "user":
                user_parts.append(text)

        payload = {
            "system": "\n".join(system_parts),
            "user": "\n".join(user_parts),
        }
        digest = hashlib.sha256(orjson.dumps(payload)).hexdigest()
        return digest

    async def cleanup_expired(self):
        async with self._lock:
            await self._load()
            before = len(self._records)
            self._cleanup_expired_inplace()
            if len(self._records) != before:
                await self._save()

    async def list(
        self,
        limit: int = 100,
        offset: int = 0,
        token: str = "",
    ) -> Dict[str, Any]:
        async with self._lock:
            await self._load()
            self._cleanup_expired_inplace()
            token = (token or "").strip()

            rows = []
            for cid, item in self._records.items():
                if not isinstance(item, dict):
                    continue
                if token and item.get("token") != token:
                    continue
                row = dict(item)
                row["conversation_id"] = cid
                rows.append(row)

            rows.sort(key=lambda x: int(x.get("updated_at", 0) or 0), reverse=True)
            total = len(rows)
            start = max(0, int(offset or 0))
            size = max(1, min(2000, int(limit or 100)))
            items = rows[start : start + size]
            return {
                "total": total,
                "items": items,
                "offset": start,
                "limit": size,
                "has_more": start + len(items) < total,
            }

    async def clear(
        self,
        conversation_id: str = "",
        token: str = "",
        expired_only: bool = False,
    ) -> int:
        async with self._lock:
            await self._load()
            now = self._now()
            cid = (conversation_id or "").strip()
            token = (token or "").strip()

            before = len(self._records)
            kept: Dict[str, Dict[str, Any]] = {}
            for k, item in self._records.items():
                if not isinstance(item, dict):
                    continue
                remove = False
                if cid and k == cid:
                    remove = True
                elif token and item.get("token") == token:
                    remove = True
                elif expired_only and int(item.get("expires_at", 0) or 0) <= now:
                    remove = True
                if not remove:
                    kept[k] = item

            self._records = kept
            deleted = before - len(self._records)
            if deleted > 0:
                await self._save()
            return deleted

    async def resolve(
        self, conversation_id: Optional[str], messages: List[Dict[str, Any]]
    ) -> Tuple[str, Optional[Dict[str, Any]]]:
        async with self._lock:
            await self._load()
            before = len(self._records)
            self._cleanup_expired_inplace()
            if len(self._records) != before:
                await self._save()

            if conversation_id and conversation_id in self._records:
                return conversation_id, self._records.get(conversation_id)

            history_hash = self._hash_messages(messages, exclude_last_user=True)
            if history_hash:
                latest_key = ""
                latest_ts = -1
                latest_state = None
                for cid, state in self._records.items():
                    if not isinstance(state, dict):
                        continue
                    if state.get("full_hash") != history_hash:
                        continue
                    ts = int(state.get("updated_at", 0) or 0)
                    if ts > latest_ts:
                        latest_ts = ts
                        latest_key = cid
                        latest_state = state
                if latest_key:
                    return latest_key, latest_state

            new_id = conversation_id or f"conv_{hashlib.md5(str(time.time()).encode()).hexdigest()[:16]}"
            return new_id, None

    async def upsert(
        self,
        client_conversation_id: str,
        token: str,
        messages: List[Dict[str, Any]],
        upstream_conversation_id: Optional[str],
        response_id: Optional[str],
        share_link_id: Optional[str],
    ):
        async with self._lock:
            await self._load()
            now = self._now()
            ttl = self._ttl_seconds()
            full_hash = self._hash_messages(messages, exclude_last_user=False)

            old = self._records.get(client_conversation_id, {})
            self._records[client_conversation_id] = {
                "client_conversation_id": client_conversation_id,
                "token": token,
                "upstream_conversation_id": upstream_conversation_id
                or old.get("upstream_conversation_id"),
                "response_id": response_id or old.get("response_id"),
                "share_link_id": share_link_id or old.get("share_link_id"),
                "full_hash": full_hash,
                "updated_at": now,
                "expires_at": now + ttl,
            }
            await self._save()


_store: Optional[ConversationStore] = None


async def get_conversation_store() -> ConversationStore:
    global _store
    if _store is None:
        _store = ConversationStore()
    return _store


__all__ = ["ConversationStore", "get_conversation_store"]
