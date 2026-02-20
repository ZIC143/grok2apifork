"""
Think/Search acceptance verifier for /v1/chat/completions.

Usage:
  python scripts/verify_think_search.py

Env:
  BASE_URL=http://127.0.0.1:8000
  API_KEY=<your_api_key>
  MODEL=grok-4.1-thinking
  REQUEST_TIMEOUT=120
    VERIFY_MODE=strict|compatible
    DEBUG_THINK_SEARCH=true|false
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class Case:
    name: str
    stream: bool
    thinking: bool
    show_search: bool
    expect_think: bool
    expect_search: bool


SEARCH_QUERY_MARKER = "🔍 搜索:"
SEARCH_COUNT_MARKER = "📄 找到 "


def _looks_like_search_process_text(text: str) -> bool:
    hints = (
        "搜索过程",
        "检索",
        "查询",
        "结果",
        "资料",
        "来源",
        "条结果",
        "搜索",
    )
    hit = 0
    for h in hints:
        if h in text:
            hit += 1
    return hit >= 2


def _extract_sse_content(raw: str) -> str:
    parts: list[str] = []
    for line in raw.splitlines():
        if not line.startswith("data: "):
            continue
        data = line[6:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            payload = json.loads(data)
        except Exception:
            continue
        for choice in payload.get("choices", []):
            delta = choice.get("delta") or {}
            content = delta.get("content")
            if isinstance(content, str):
                parts.append(content)
    return "".join(parts)


def _check_markers(
    text: str,
    *,
    expect_think: bool,
    expect_search: bool,
    mode: str,
) -> tuple[bool, list[str]]:
    errors: list[str] = []
    has_think_open = "<think>" in text
    has_think_close = "</think>" in text
    has_search_query = SEARCH_QUERY_MARKER in text
    has_search_count = SEARCH_COUNT_MARKER in text
    has_search_nl = _looks_like_search_process_text(text)

    if expect_think:
        if not has_think_open or not has_think_close:
            errors.append("missing <think> wrapper")
    else:
        if has_think_open or has_think_close:
            errors.append("unexpected <think> wrapper")

    if expect_search:
        if mode == "strict":
            if not has_search_query:
                errors.append("missing search query marker")
            if not has_search_count:
                errors.append("missing search count marker")
        else:
            if not (has_search_query and has_search_count) and not has_search_nl:
                errors.append("missing search process evidence")
    else:
        if has_search_query or has_search_count or has_search_nl:
            errors.append("unexpected search markers")

    return (len(errors) == 0), errors


async def _call_case(
    client: httpx.AsyncClient,
    case: Case,
    model: str,
    mode: str,
    debug_header: bool,
) -> tuple[bool, str, list[str], dict[str, str]]:
    payload: dict[str, Any] = {
        "model": model,
        "stream": case.stream,
        "thinking": case.thinking,
        "show_search": case.show_search,
        "messages": [
            {
                "role": "user",
                "content": "请使用搜索工具查询今天北京天气，先展示搜索过程（查询与结果数量），再给结论。",
            }
        ],
    }

    headers = {"X-Debug-Think-Search": "true"} if debug_header else None
    resp = await client.post("/v1/chat/completions", json=payload, headers=headers)
    resp.raise_for_status()

    if case.stream:
        body = _extract_sse_content(resp.text)
    else:
        data = resp.json()
        body = (
            data.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        if not isinstance(body, str):
            body = str(body)

    ok, errs = _check_markers(body, expect_think=case.expect_think, expect_search=case.expect_search, mode=mode)
    debug_echo = {
        "show_thinking": resp.headers.get("X-Debug-Show-Thinking", ""),
        "show_search": resp.headers.get("X-Debug-Show-Search", ""),
        "is_reasoning": resp.headers.get("X-Debug-Is-Reasoning", ""),
        "reasoning_effort": resp.headers.get("X-Debug-Reasoning-Effort", ""),
    }
    return ok, body, errs, debug_echo


async def main() -> int:
    base_url = os.getenv("BASE_URL", "http://127.0.0.1:8000").rstrip("/")
    if base_url.endswith("/v1"):
        base_url = base_url[:-3]
    api_key = (os.getenv("API_KEY", "") or os.getenv("API_KAY", "")).strip()
    model = os.getenv("MODEL", "grok-4.1-thinking").strip() or "grok-4.1-thinking"
    timeout = float(os.getenv("REQUEST_TIMEOUT", "120"))
    verify_mode = os.getenv("VERIFY_MODE", "strict").strip().lower()
    if verify_mode not in {"strict", "compatible"}:
        verify_mode = "strict"
    debug_header = os.getenv("DEBUG_THINK_SEARCH", "false").strip().lower() in {"1", "true", "yes"}

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    cases = [
        Case("stream_think_on_search_on", True, True, True, True, True),
        Case("stream_think_on_search_off", True, True, False, True, False),
        Case("stream_think_off_search_on", True, False, True, False, False),
        Case("nonstream_think_on_search_on", False, True, True, True, True),
    ]

    print(f"Base URL: {base_url}")
    print(f"Model: {model}")
    print(f"Verify mode: {verify_mode}")
    print(f"Debug header: {debug_header}")

    failed = 0
    async with httpx.AsyncClient(base_url=base_url, headers=headers, timeout=timeout) as client:
        for case in cases:
            try:
                ok, body, errs, debug_echo = await _call_case(client, case, model, verify_mode, debug_header)
            except Exception as e:
                failed += 1
                print(f"[FAIL] {case.name}: request error -> {e}")
                continue

            if ok:
                print(f"[PASS] {case.name}")
            else:
                failed += 1
                print(f"[FAIL] {case.name}: {'; '.join(errs)}")
                preview = body[:500].replace("\n", "\\n")
                print(f"  preview: {preview}")
            if debug_header:
                print(
                    "  debug:",
                    f"thinking={debug_echo.get('show_thinking','')}",
                    f"search={debug_echo.get('show_search','')}",
                    f"reasoning={debug_echo.get('is_reasoning','')}",
                    f"effort={debug_echo.get('reasoning_effort','')}",
                )

    if failed:
        print(f"\nResult: FAILED ({failed}/{len(cases)})")
        return 1

    print("\nResult: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
