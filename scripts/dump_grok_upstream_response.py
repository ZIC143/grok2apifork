"""\
直接抓取 Grok 上游（https://grok.com）接口的原始流式响应，并保存到文件。

用途：
- 不改动项目代码
- 复现/调试上游返回的 NDJSON token 流（含 tool_usage_card / raw_function_result 等字段）

你需要提供 grok.com 的 Cookie：至少包含 sso=...；如被 Cloudflare 拦截，额外提供 cf_clearance=...。

支持两种方式传参：
- 通过命令行参数：--sso / --cookie / --cf-clearance
- 通过环境变量：GROK_COOKIE / GROK_SSO / GROK_CF_CLEARANCE

输出：
- meta.json：请求/响应元数据（默认脱敏 Cookie）
- response.ndjson：上游原始逐行内容（每行一个 JSON）
- error.txt：非 200 时保存错误正文
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import gzip
import json
import os
import random
import string
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import requests


UPSTREAM_URL = "https://grok.com/rest/app-chat/conversations/new"
DEFAULT_IMPERSONATE = "chrome136"


def _has_curl_cffi() -> bool:
    try:
        import curl_cffi  # noqa: F401
        from curl_cffi.requests import AsyncSession  # noqa: F401

        return True
    except Exception:
        return False


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _mask(value: str, *, keep_start: int = 6, keep_end: int = 4) -> str:
    v = str(value or "")
    if not v:
        return ""
    if len(v) <= keep_start + keep_end:
        return "***"
    return f"{v[:keep_start]}***{v[-keep_end:]}"


def _extract_cookie_value(cookie: str, name: str) -> str | None:
    if not cookie:
        return None
    needle = f"{name}="
    if needle not in cookie:
        return None
    parts = cookie.split(";")
    for part in parts:
        part = part.strip()
        if part.startswith(needle):
            val = part[len(needle) :].strip()
            return val or None
    return None


def _normalize_sso(sso_or_cookie: str) -> str:
    raw = str(sso_or_cookie or "").strip()
    if not raw:
        return ""
    if ";" in raw:
        return str(_extract_cookie_value(raw, "sso") or "").strip()
    if raw.startswith("sso="):
        return raw[4:].strip()
    return raw


def _build_cookie(*, cookie: str, sso: str, cf_clearance: str) -> str:
    if cookie:
        return cookie.strip()

    sso = _normalize_sso(sso)
    if not sso:
        return ""

    cf_clearance = str(cf_clearance or "").strip()
    if cf_clearance:
        return f"sso={sso}; cf_clearance={cf_clearance}"
    return f"sso={sso}"


def _cookie_keys(cookie: str) -> list[str]:
    keys: set[str] = set()
    for part in str(cookie or "").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k = part.split("=", 1)[0].strip()
        if k:
            keys.add(k)
    return sorted(keys)


async def _read_curl_cffi_text(resp: Any, *, max_bytes: int = 512 * 1024) -> str:
    """Best-effort read response body from curl_cffi (stream=True compatible)."""
    # 1) Try `text` property (may already be populated)
    try:
        text = getattr(resp, "text", "")
        if isinstance(text, str) and text:
            return text
    except Exception:
        pass

    # 2) Prefer async full content
    body: bytes = b""
    if hasattr(resp, "acontent"):
        try:
            body = await resp.acontent()
        except Exception:
            body = b""

    # 3) Fallback: stream chunks
    if not body and hasattr(resp, "aiter_content"):
        chunks: list[bytes] = []
        size = 0
        try:
            async for chunk in resp.aiter_content():
                if not chunk:
                    continue
                if not isinstance(chunk, (bytes, bytearray)):
                    chunk = str(chunk).encode("utf-8")
                chunk_b = bytes(chunk)
                chunks.append(chunk_b)
                size += len(chunk_b)
                if max_bytes > 0 and size >= max_bytes:
                    break
            body = b"".join(chunks)
        except Exception:
            body = b""

    if not body:
        return ""

    # 4) Decode (handle gzip when possible)
    try:
        headers = getattr(resp, "headers", {}) or {}
        enc = str(headers.get("content-encoding") or headers.get("Content-Encoding") or "").lower().strip()
        if enc == "gzip" or body[:2] == b"\x1f\x8b":
            try:
                body = gzip.decompress(body)
            except Exception:
                pass
    except Exception:
        pass

    return body.decode("utf-8", errors="replace")


def _gen_statsig_id() -> str:
    # 与项目内 StatsigService.gen_id() 等价的“伪造” Statsig ID。
    def _rand(length: int, alnum: bool) -> str:
        chars = (string.ascii_lowercase + string.digits) if alnum else string.ascii_lowercase
        return "".join(random.choices(chars, k=length))

    if random.choice([True, False]):
        r = _rand(5, True)
        msg = f"e:TypeError: Cannot read properties of null (reading 'children['{r}']')"
    else:
        r = _rand(10, False)
        msg = f"e:TypeError: Cannot read properties of undefined (reading '{r}')"

    return base64.b64encode(msg.encode("utf-8")).decode("ascii")


def _build_headers(cookie: str, *, xai_request_id: str) -> Dict[str, str]:
    # 参考 app/services/grok/chat.py 的请求头，尽量贴近浏览器。
    headers: Dict[str, str] = {
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Origin": "https://grok.com",
        "Pragma": "no-cache",
        "Priority": "u=1, i",
        "Referer": "https://grok.com/",
        "Sec-Ch-Ua": '"Google Chrome";v="136", "Chromium";v="136", "Not(A:Brand";v="24"',
        "Sec-Ch-Ua-Arch": "arm",
        "Sec-Ch-Ua-Bitness": "64",
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Model": "",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "x-statsig-id": _gen_statsig_id(),
        "x-xai-request-id": xai_request_id,
        "Cookie": cookie,
    }
    return headers


def _build_payload(
    *,
    message: str,
    model_name: str,
    model_mode: str,
    temporary: bool,
    disable_search: bool,
    is_thinking: bool,
    return_raw_grok_in_xai_request: bool,
) -> Dict[str, Any]:
    return {
        "temporary": bool(temporary),
        "modelName": model_name,
        "modelMode": model_mode,
        "isThinking": bool(is_thinking),
        "message": message,
        "fileAttachments": [],
        "imageAttachments": [],
        "disableSearch": bool(disable_search),
        "enableImageGeneration": True,
        "returnImageBytes": False,
        "returnRawGrokInXaiRequest": bool(return_raw_grok_in_xai_request),
        "enableImageStreaming": True,
        "imageGenerationCount": 2,
        "forceConcise": False,
        "toolOverrides": {},
        "enableSideBySide": True,
        "sendFinalMetadata": True,
        "isReasoning": False,
        "disableTextFollowUps": False,
        "responseMetadata": {
            "modelConfigOverride": {"modelMap": {}},
            "requestModelDetails": {"modelId": model_name},
        },
        "disableMemory": False,
        "forceSideBySide": False,
        "isAsyncChat": False,
        "disableSelfHarmShortCircuit": False,
        "deviceEnvInfo": {
            "darkModeEnabled": False,
            "devicePixelRatio": 2,
            "screenWidth": 2056,
            "screenHeight": 1329,
            "viewportWidth": 2056,
            "viewportHeight": 1083,
        },
    }


def _sanitize_headers(headers: Dict[str, str], *, include_secrets: bool) -> Dict[str, str]:
    out = dict(headers or {})
    if not include_secrets and "Cookie" in out:
        cookie = str(out.get("Cookie") or "")
        sso = _extract_cookie_value(cookie, "sso") or ""
        cf = _extract_cookie_value(cookie, "cf_clearance") or ""
        parts = []
        if sso:
            parts.append(f"sso={_mask(sso)}")
        if cf:
            parts.append(f"cf_clearance={_mask(cf)}")
        out["Cookie"] = "; ".join(parts) if parts else "***"
    return out


def _write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


@dataclass
class DumpResult:
    out_dir: str
    status_code: int
    lines: int
    bytes_written: int
    elapsed_ms: int


async def dump_upstream(args: argparse.Namespace) -> DumpResult:
    out_dir = Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    cookie = _build_cookie(
        cookie=str(args.cookie or os.getenv("GROK_COOKIE", "")).strip(),
        sso=str(args.sso or os.getenv("GROK_SSO", "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uX2lkIjoiZDM5NTIyMzAtYjAzMy00MDJhLTg0YTMtMDIzYzMwNjIwNjM5In0.S7_z4msBuRSXWjYfchEEfhoSbJW7NqmGJ2fQLySpA7Q")).strip(),
        cf_clearance=str(args.cf_clearance or os.getenv("GROK_CF_CLEARANCE", "")).strip(),
    )
    if not cookie:
        raise SystemExit("缺少 Cookie：请提供 --cookie 或 --sso（或设置 GROK_COOKIE / GROK_SSO）。")

    cookie_keys = _cookie_keys(cookie)

    xai_request_id = str(uuid.uuid4())
    headers = _build_headers(cookie, xai_request_id=xai_request_id)

    if args.payload_file:
        payload_path = Path(args.payload_file).expanduser().resolve()
        payload = json.loads(payload_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise SystemExit("--payload-file 必须是一个 JSON object")
    else:
        payload = _build_payload(
            message=str(args.message),
            model_name=str(args.model_name),
            model_mode=str(args.model_mode),
            temporary=bool(args.temporary),
            disable_search=bool(args.disable_search),
            is_thinking=bool(args.is_thinking),
            return_raw_grok_in_xai_request=bool(args.return_raw),
        )

    proxies = None
    proxy = str(args.proxy or os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY") or "").strip()
    if proxy:
        proxies = {"http": proxy, "https": proxy}

    meta_path = out_dir / "meta.json"
    body_path = out_dir / "response.ndjson"
    err_path = out_dir / "error.txt"

    read_mode = str(getattr(args, "read_mode", "") or "stream").strip().lower()
    if read_mode not in {"stream", "full"}:
        raise SystemExit("--read-mode 仅支持 stream/full")

    started = time.monotonic()
    backend = str(getattr(args, "backend", "") or "auto").strip().lower()
    if backend not in {"auto", "curl_cffi", "requests"}:
        raise SystemExit("--backend 仅支持 auto/curl_cffi/requests")

    use_curl = False
    if backend == "curl_cffi":
        use_curl = True
    elif backend == "requests":
        use_curl = False
    else:
        use_curl = _has_curl_cffi()

    if use_curl:
        # 可选：若安装了 curl_cffi，则用浏览器指纹（更容易通过上游校验）。
        try:
            from curl_cffi.requests import AsyncSession  # type: ignore
        except Exception as e:
            raise SystemExit(
                "未安装 curl_cffi：请改用 --backend requests，或安装依赖后再试。"
            ) from e

        session = AsyncSession(impersonate=str(args.impersonate))
        try:
            resp = await session.post(
                UPSTREAM_URL,
                headers=headers,
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                timeout=float(args.timeout),
                stream=True,
                proxies=proxies,
            )

            meta: Dict[str, Any] = {
                "timestamp": _now_iso(),
                "url": UPSTREAM_URL,
                "request": {
                    "xai_request_id": xai_request_id,
                    "headers": _sanitize_headers(headers, include_secrets=bool(args.include_secrets)),
                    "cookie_keys": cookie_keys,
                    "payload": payload,
                    "proxy": proxy or "",
                    "backend": "curl_cffi",
                    "impersonate": str(args.impersonate),
                    "read_mode": read_mode,
                },
                "response": {
                    "status_code": int(getattr(resp, "status_code", 0) or 0),
                    "headers": dict(getattr(resp, "headers", {}) or {}),
                },
            }
            _write_json(meta_path, meta)

            status_code = int(getattr(resp, "status_code", 0) or 0)
            if status_code != 200:
                text = await _read_curl_cffi_text(resp)
                if not text:
                    text = "(empty response body)"
                err_path.write_text(text, encoding="utf-8", errors="replace")
                elapsed_ms = int((time.monotonic() - started) * 1000)
                return DumpResult(
                    out_dir=str(out_dir),
                    status_code=status_code,
                    lines=0,
                    bytes_written=0,
                    elapsed_ms=elapsed_ms,
                )

            lines = 0
            bytes_written = 0
            max_lines = int(args.max_lines) if args.max_lines is not None else 0

            if read_mode == "full":
                # 一次性读取完整 body（会等待上游流结束），然后整体写入文件。
                full_text = await resp.atext()
                body_bytes = (full_text or "").encode("utf-8")
                body_path.write_bytes(body_bytes)
                bytes_written = len(body_bytes)
                lines = (full_text or "").count("\n")
            else:
                # 逐行落盘（适合大响应/需要边下边存）。
                with body_path.open("wb") as f:
                    async for line in resp.aiter_lines():
                        if line is None:
                            continue
                        raw = line if isinstance(line, bytes) else str(line).encode("utf-8")
                        f.write(raw + b"\n")
                        bytes_written += len(raw) + 1
                        lines += 1
                        if max_lines > 0 and lines >= max_lines:
                            break

            elapsed_ms = int((time.monotonic() - started) * 1000)
            meta["response"]["lines"] = lines
            meta["response"]["bytes_written"] = bytes_written
            meta["response"]["elapsed_ms"] = elapsed_ms
            meta["response"]["body_file"] = str(body_path.name)
            if err_path.exists():
                meta["response"]["error_file"] = str(err_path.name)
            _write_json(meta_path, meta)

            return DumpResult(
                out_dir=str(out_dir),
                status_code=200,
                lines=lines,
                bytes_written=bytes_written,
                elapsed_ms=elapsed_ms,
            )
        finally:
            try:
                await session.close()
            except Exception:
                pass

    # 默认：requests（零额外依赖），但在部分网络/风控场景下可能更容易被上游拒绝。
    # 注意：requests 对 br/zstd 解压依赖可选库；这里不显式声明 Accept-Encoding，
    # 让 requests 使用它的默认值（通常为 gzip/deflate），避免拿到无法解码的压缩流。
    headers_req = dict(headers)
    headers_req.pop("Accept-Encoding", None)
    req_body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        with requests.post(
            UPSTREAM_URL,
            headers=headers_req,
            data=req_body,
            timeout=float(args.timeout),
            stream=True,
            proxies=proxies,
        ) as resp:
            meta = {
                "timestamp": _now_iso(),
                "url": UPSTREAM_URL,
                "request": {
                    "xai_request_id": xai_request_id,
                    "headers": _sanitize_headers(headers_req, include_secrets=bool(args.include_secrets)),
                    "cookie_keys": cookie_keys,
                    "payload": payload,
                    "proxy": proxy or "",
                    "backend": "requests",
                    "read_mode": read_mode,
                },
                "response": {
                    "status_code": int(getattr(resp, "status_code", 0) or 0),
                    "headers": dict(getattr(resp, "headers", {}) or {}),
                },
            }
            _write_json(meta_path, meta)

            status_code = int(getattr(resp, "status_code", 0) or 0)
            if status_code != 200:
                text = ""
                try:
                    text = resp.text
                except Exception:
                    try:
                        text = (resp.content or b"").decode("utf-8", errors="replace")
                    except Exception:
                        text = "(unable to read response body)"
                err_path.write_text(text, encoding="utf-8", errors="replace")
                elapsed_ms = int((time.monotonic() - started) * 1000)
                return DumpResult(
                    out_dir=str(out_dir),
                    status_code=status_code,
                    lines=0,
                    bytes_written=0,
                    elapsed_ms=elapsed_ms,
                )

            lines = 0
            bytes_written = 0
            max_lines = int(args.max_lines) if args.max_lines is not None else 0

            if read_mode == "full":
                body = resp.content or b""
                body_path.write_bytes(body)
                bytes_written = len(body)
                try:
                    lines = body.count(b"\n")
                except Exception:
                    lines = 0
            else:
                with body_path.open("wb") as f:
                    for line in resp.iter_lines(decode_unicode=False):
                        if line is None:
                            continue
                        raw = line if isinstance(line, (bytes, bytearray)) else str(line).encode("utf-8")
                        f.write(bytes(raw) + b"\n")
                        bytes_written += len(raw) + 1
                        lines += 1
                        if max_lines > 0 and lines >= max_lines:
                            break

            elapsed_ms = int((time.monotonic() - started) * 1000)
            meta["response"]["lines"] = lines
            meta["response"]["bytes_written"] = bytes_written
            meta["response"]["elapsed_ms"] = elapsed_ms
            meta["response"]["body_file"] = str(body_path.name)
            if err_path.exists():
                meta["response"]["error_file"] = str(err_path.name)
            _write_json(meta_path, meta)

            return DumpResult(
                out_dir=str(out_dir),
                status_code=200,
                lines=lines,
                bytes_written=bytes_written,
                elapsed_ms=elapsed_ms,
            )
    except requests.RequestException as e:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        err_path.write_text(str(e), encoding="utf-8", errors="replace")
        # 依旧写 meta，便于定位
        meta = {
            "timestamp": _now_iso(),
            "url": UPSTREAM_URL,
            "request": {
                "xai_request_id": xai_request_id,
                "headers": _sanitize_headers(headers_req, include_secrets=bool(args.include_secrets)),
                "cookie_keys": cookie_keys,
                "payload": payload,
                "proxy": proxy or "",
                "backend": "requests",
                "read_mode": read_mode,
            },
            "response": {
                "status_code": 0,
                "error": str(e),
            },
        }
        _write_json(meta_path, meta)
        return DumpResult(
            out_dir=str(out_dir),
            status_code=0,
            lines=0,
            bytes_written=0,
            elapsed_ms=elapsed_ms,
        )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Dump grok.com upstream NDJSON response to files")

    p.add_argument(
        "--out",
        default="",
        help="输出目录（默认：./upstream_dump/<timestamp>）",
    )

    p.add_argument("--cookie", default="", help="完整 Cookie 字符串（优先级最高）")
    p.add_argument("--sso", default="", help="sso token 或包含 sso=... 的 Cookie")
    p.add_argument("--cf-clearance", default="", help="可选：cf_clearance 值")

    p.add_argument("--proxy", default="", help="可选：HTTP/HTTPS 代理，例如 http://127.0.0.1:7890")
    p.add_argument(
        "--backend",
        default="auto",
        help="HTTP 后端：auto/curl_cffi/requests（默认 auto；若本机未安装 curl_cffi 会自动用 requests）",
    )
    p.add_argument("--impersonate", default=DEFAULT_IMPERSONATE, help="curl_cffi impersonate 标识")
    p.add_argument("--timeout", type=float, default=120.0, help="请求超时（秒）")

    p.add_argument(
        "--read-mode",
        default="full",
        help="读取/保存上游响应的方式：stream=逐行写入（默认）；full=一次性读取完整响应后写入（非流式输出）",
    )

    p.add_argument("--message", default="what is the weather in new york now", help="发送的消息文本")
    p.add_argument("--model-name", default="grok-4-1-thinking-1129", help="上游 modelName，例如 grok-3 / grok-420")
    p.add_argument(
        "--model-mode",
        default="MODEL_MODE_GROK_4_1_MINI_THINKING",
        help="上游 modelMode，例如 MODEL_MODE_GROK_3 / MODEL_MODE_GROK_420",
    )

    p.add_argument("--temporary", action=argparse.BooleanOptionalAction, default=True, help="temporary 会话")
    p.add_argument("--disable-search", action=argparse.BooleanOptionalAction, default=False, help="禁用搜索")
    p.add_argument(
        "--is-thinking",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="设置请求体 isThinking=true/false",
    )
    p.add_argument(
        "--return-raw",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="设置 returnRawGrokInXaiRequest=true（可能返回更多字段）",
    )

    p.add_argument(
        "--payload-file",
        default="",
        help="可选：直接使用自定义 payload(JSON)，会覆盖 --message/--model-* 等参数",
    )

    p.add_argument(
        "--max-lines",
        type=int,
        default=None,
        help="可选：最多保存多少行（用于快速抓包）",
    )

    p.add_argument(
        "--include-secrets",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="meta.json 中是否写入未脱敏的 Cookie（默认脱敏）",
    )

    return p


async def _amain() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if not args.out:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        args.out = str((Path.cwd() / "upstream_dump" / ts))

    result = await dump_upstream(args)
    # 只输出必要信息，避免泄漏 Cookie
    print(
        f"OK: status={result.status_code}, lines={result.lines}, bytes={result.bytes_written}, elapsed_ms={result.elapsed_ms}\n"
        f"输出目录: {result.out_dir}"
    )
    return 0 if result.status_code == 200 else 1


def main() -> int:
    try:
        return asyncio.run(_amain())
    except KeyboardInterrupt:
        print("Interrupted")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
