"""
Background maintenance tasks (conversation cleanup + log retention).
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Optional

from app.core.config import get_config
from app.core.logger import logger
from app.services.grok.services.conversation import get_conversation_store

DEFAULT_LOG_DIR = Path(__file__).resolve().parent.parent.parent / "logs"


class MaintenanceScheduler:
    def __init__(self):
        self._task: Optional[asyncio.Task] = None
        self._running = False

    def _interval_seconds(self) -> int:
        value = get_config("maintenance.cleanup_interval_sec", 1800)
        try:
            return max(60, int(value))
        except Exception:
            return 1800

    def _log_retention_days(self) -> int:
        value = get_config("maintenance.log_retention_days", 7)
        try:
            return max(1, int(value))
        except Exception:
            return 7

    async def _cleanup_logs(self):
        raw_dir = str(get_config("maintenance.log_dir", "") or "").strip()
        log_dir = Path(raw_dir) if raw_dir else DEFAULT_LOG_DIR
        retention_days = self._log_retention_days()
        if not log_dir.exists() or not log_dir.is_dir():
            return

        now = time.time()
        deadline = now - retention_days * 86400
        deleted = 0
        for path in log_dir.glob("*.log"):
            try:
                stat = path.stat()
                if stat.st_mtime < deadline:
                    path.unlink(missing_ok=True)
                    deleted += 1
            except Exception:
                continue
        if deleted:
            logger.info(f"Maintenance: deleted {deleted} expired log files")

    async def _run_once(self):
        store = await get_conversation_store()
        await store.cleanup_expired()
        await self._cleanup_logs()

    async def _loop(self):
        logger.info("Maintenance scheduler started")
        while self._running:
            try:
                await self._run_once()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Maintenance run failed: {e}")
            await asyncio.sleep(self._interval_seconds())
        logger.info("Maintenance scheduler stopped")

    def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())

    def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()


_scheduler: Optional[MaintenanceScheduler] = None


def get_maintenance_scheduler() -> MaintenanceScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = MaintenanceScheduler()
    return _scheduler


__all__ = ["MaintenanceScheduler", "get_maintenance_scheduler"]
