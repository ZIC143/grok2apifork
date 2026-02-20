"""
Reverse interface: conversation share-link create/clone.
"""

import orjson
from typing import Any, Dict, Optional
from curl_cffi.requests import AsyncSession

from app.core.logger import logger
from app.core.config import get_config
from app.core.exceptions import UpstreamException
from app.services.token.service import TokenService
from app.services.reverse.utils.headers import build_headers
from app.services.reverse.utils.retry import retry_on_status

SHARE_CREATE_API = "https://grok.com/rest/app-chat/conversations/{conversation_id}/share"
SHARE_CLONE_API = "https://grok.com/rest/app-chat/share-links/{share_link_id}/clone"


class ShareLinkReverse:
    """Share-link reverse interfaces."""

    @staticmethod
    async def create(session: AsyncSession, token: str, conversation_id: str) -> Dict[str, Any]:
        try:
            base_proxy = get_config("proxy.base_proxy_url")
            proxies = {"http": base_proxy, "https": base_proxy} if base_proxy else None

            headers = build_headers(
                cookie_token=token,
                content_type="application/json",
                origin="https://grok.com",
                referer="https://grok.com/",
            )
            browser = get_config("proxy.browser")
            timeout = get_config("chat.timeout")
            url = SHARE_CREATE_API.format(conversation_id=conversation_id)

            async def _do_request():
                response = await session.post(
                    url,
                    headers=headers,
                    data=orjson.dumps({}),
                    timeout=timeout,
                    proxies=proxies,
                    impersonate=browser,
                )
                if response.status_code != 200:
                    content = ""
                    try:
                        content = await response.text()
                    except Exception:
                        pass
                    raise UpstreamException(
                        message=f"ShareLinkReverse.create failed, {response.status_code}",
                        details={"status": response.status_code, "body": content},
                    )
                return response

            response = await retry_on_status(_do_request)
            text = await response.text()
            try:
                return orjson.loads(text)
            except Exception:
                return {"raw": text}

        except Exception as e:
            if isinstance(e, UpstreamException):
                status = None
                if e.details and "status" in e.details:
                    status = e.details["status"]
                else:
                    status = getattr(e, "status_code", None)
                if status == 401:
                    try:
                        await TokenService.record_fail(token, status, "share_create_auth_failed")
                    except Exception:
                        pass
                raise

            logger.error(
                f"ShareLinkReverse.create failed, {str(e)}",
                extra={"error_type": type(e).__name__},
            )
            raise UpstreamException(
                message=f"ShareLinkReverse.create failed, {str(e)}",
                details={"status": 502, "error": str(e)},
            )

    @staticmethod
    async def clone(session: AsyncSession, token: str, share_link_id: str) -> Dict[str, Any]:
        try:
            base_proxy = get_config("proxy.base_proxy_url")
            proxies = {"http": base_proxy, "https": base_proxy} if base_proxy else None

            headers = build_headers(
                cookie_token=token,
                content_type="application/json",
                origin="https://grok.com",
                referer="https://grok.com/",
            )
            browser = get_config("proxy.browser")
            timeout = get_config("chat.timeout")
            url = SHARE_CLONE_API.format(share_link_id=share_link_id)

            async def _do_request():
                response = await session.post(
                    url,
                    headers=headers,
                    data=orjson.dumps({}),
                    timeout=timeout,
                    proxies=proxies,
                    impersonate=browser,
                )
                if response.status_code != 200:
                    content = ""
                    try:
                        content = await response.text()
                    except Exception:
                        pass
                    raise UpstreamException(
                        message=f"ShareLinkReverse.clone failed, {response.status_code}",
                        details={"status": response.status_code, "body": content},
                    )
                return response

            response = await retry_on_status(_do_request)
            text = await response.text()
            try:
                return orjson.loads(text)
            except Exception:
                return {"raw": text}

        except Exception as e:
            if isinstance(e, UpstreamException):
                status = None
                if e.details and "status" in e.details:
                    status = e.details["status"]
                else:
                    status = getattr(e, "status_code", None)
                if status == 401:
                    try:
                        await TokenService.record_fail(token, status, "share_clone_auth_failed")
                    except Exception:
                        pass
                raise

            logger.error(
                f"ShareLinkReverse.clone failed, {str(e)}",
                extra={"error_type": type(e).__name__},
            )
            raise UpstreamException(
                message=f"ShareLinkReverse.clone failed, {str(e)}",
                details={"status": 502, "error": str(e)},
            )


__all__ = ["ShareLinkReverse"]
