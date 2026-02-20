"""
Request statistics storage and aggregation helpers.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any, Dict, List

import aiofiles
import orjson

DATA_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data"
REQUEST_LOG_FILE = DATA_DIR / "request_logs.jsonl"


class RequestStatsStore:
    def __init__(self):
        self._lock = asyncio.Lock()

    async def add(self, model: str, status: int, duration_ms: float):
        entry = {
            "timestamp": int(time.time()),
            "model": str(model or "unknown"),
            "status": int(status or 0),
            "duration_ms": float(duration_ms or 0.0),
        }
        async with self._lock:
            REQUEST_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            async with aiofiles.open(REQUEST_LOG_FILE, "ab") as f:
                await f.write(orjson.dumps(entry) + b"\n")

    async def _load_window(self, window_sec: int) -> List[Dict[str, Any]]:
        now = int(time.time())
        begin = now - max(60, int(window_sec))
        if not REQUEST_LOG_FILE.exists():
            return []

        records: List[Dict[str, Any]] = []
        async with self._lock:
            async with aiofiles.open(REQUEST_LOG_FILE, "rb") as f:
                raw = await f.read()

        for line in raw.splitlines():
            if not line:
                continue
            try:
                item = orjson.loads(line)
            except Exception:
                continue
            if not isinstance(item, dict):
                continue
            ts = int(item.get("timestamp", 0) or 0)
            if ts < begin:
                continue
            records.append(item)
        return records

    async def trend(self, window_sec: int, bucket: str) -> Dict[str, Any]:
        rows = await self._load_window(window_sec)
        bucket_sec = 3600 if bucket == "hour" else 86400
        grouped: Dict[int, Dict[str, Any]] = {}

        for row in rows:
            ts = int(row.get("timestamp", 0) or 0)
            slot = ts - (ts % bucket_sec)
            g = grouped.setdefault(
                slot,
                {
                    "timestamp": slot,
                    "total": 0,
                    "success": 0,
                    "error": 0,
                    "duration_total_ms": 0.0,
                },
            )
            g["total"] += 1
            if int(row.get("status", 0) or 0) == 200:
                g["success"] += 1
            else:
                g["error"] += 1
            g["duration_total_ms"] += float(row.get("duration_ms", 0.0) or 0.0)

        items = []
        for ts in sorted(grouped.keys()):
            item = grouped[ts]
            total = int(item["total"] or 0)
            item["avg_duration_ms"] = round(
                float(item["duration_total_ms"] or 0.0) / total, 2
            ) if total > 0 else 0.0
            item.pop("duration_total_ms", None)
            items.append(item)

        return {
            "window_sec": int(window_sec),
            "bucket": bucket,
            "items": items,
        }

    async def model_distribution(self, window_sec: int) -> Dict[str, Any]:
        rows = await self._load_window(window_sec)
        grouped: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            model = str(row.get("model") or "unknown")
            g = grouped.setdefault(
                model,
                {
                    "model": model,
                    "count": 0,
                    "success": 0,
                    "error": 0,
                    "duration_total_ms": 0.0,
                },
            )
            g["count"] += 1
            if int(row.get("status", 0) or 0) == 200:
                g["success"] += 1
            else:
                g["error"] += 1
            g["duration_total_ms"] += float(row.get("duration_ms", 0.0) or 0.0)

        items = []
        for model, item in grouped.items():
            count = int(item["count"] or 0)
            item["avg_duration_ms"] = round(
                float(item["duration_total_ms"] or 0.0) / count, 2
            ) if count > 0 else 0.0
            item.pop("duration_total_ms", None)
            items.append(item)

        items.sort(key=lambda x: int(x.get("count", 0) or 0), reverse=True)
        return {"window_sec": int(window_sec), "items": items}


_store: RequestStatsStore | None = None


async def get_request_stats_store() -> RequestStatsStore:
    global _store
    if _store is None:
        _store = RequestStatsStore()
    return _store


__all__ = ["RequestStatsStore", "get_request_stats_store"]
