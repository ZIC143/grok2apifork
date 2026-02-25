"""
OpenAI 响应格式处理器
"""
import time
import uuid
import random
import html
import re
import orjson
from typing import Any, AsyncGenerator, Optional, AsyncIterable, List

from app.core.config import get_config
from app.core.logger import logger
from app.services.grok.assets import DownloadService
from app.services.token_usage import build_chat_usage


ASSET_URL = "https://assets.grok.com/"


def _build_video_poster_preview(video_url: str, thumbnail_url: str = "") -> str:
    """将 <video> 替换为可点击的 Poster 预览图（用于前端展示）"""
    safe_video = html.escape(video_url or "", quote=True)
    safe_thumb = html.escape(thumbnail_url or "", quote=True)

    if not safe_video:
        return ""

    if not safe_thumb:
        return f'<a href="{safe_video}" target="_blank" rel="noopener noreferrer">{safe_video}</a>'

    return f'''<a href="{safe_video}" target="_blank" rel="noopener noreferrer" style="display:inline-block;position:relative;max-width:100%;text-decoration:none;">
  <img src="{safe_thumb}" alt="video" style="max-width:100%;height:auto;border-radius:12px;display:block;" />
  <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
    <span style="width:64px;height:64px;border-radius:9999px;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;">
      <span style="width:0;height:0;border-top:12px solid transparent;border-bottom:12px solid transparent;border-left:18px solid #fff;margin-left:4px;"></span>
    </span>
  </span>
</a>'''


class BaseProcessor:
    """基础处理器"""
    
    def __init__(self, model: str, token: str = ""):
        self.model = model
        self.token = token
        self.created = int(time.time())
        self.app_url = get_config("app.app_url", "")
        self._dl_service: Optional[DownloadService] = None

    def _get_dl(self) -> DownloadService:
        """获取下载服务实例（复用）"""
        if self._dl_service is None:
            self._dl_service = DownloadService()
        return self._dl_service

    async def close(self):
        """释放下载服务资源"""
        if self._dl_service:
            await self._dl_service.close()
            self._dl_service = None

    async def process_url(self, path: str, media_type: str = "image") -> str:
        """处理资产 URL"""
        # 处理可能的绝对路径
        if path.startswith("http"):
            from urllib.parse import urlparse
            path = urlparse(path).path
            
        if not path.startswith("/"):
            path = f"/{path}"

        # Invalid root path is not a displayable image URL.
        if path in {"", "/"}:
            return ""

        # Always materialize to local cache endpoint so callers don't rely on
        # direct assets.grok.com access (often blocked without upstream cookies).
        dl_service = self._get_dl()
        await dl_service.download(path, self.token, media_type)
        local_path = f"/v1/files/{media_type}{path}"
        if self.app_url:
            return f"{self.app_url.rstrip('/')}{local_path}"
        return local_path
            
    def _sse(self, content: str = "", role: str = None, finish: str = None) -> str:
        """构建 SSE 响应 (StreamProcessor 通用)"""
        if not hasattr(self, 'response_id'):
            self.response_id = None
        if not hasattr(self, 'fingerprint'):
            self.fingerprint = ""
            
        delta = {}
        if role:
            delta["role"] = role
            delta["content"] = ""
        elif content:
            delta["content"] = content
        
        chunk = {
            "id": self.response_id or f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "system_fingerprint": self.fingerprint if hasattr(self, 'fingerprint') else "",
            "choices": [{"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish}]
        }
        return f"data: {orjson.dumps(chunk).decode()}\n\n"


class StreamProcessor(BaseProcessor):
    """流式响应处理器"""
    
    def __init__(self, model: str, token: str = "", think: bool = None):
        super().__init__(model, token)
        self.response_id: Optional[str] = None
        self.fingerprint: str = ""
        self.think_opened: bool = False
        self.role_sent: bool = False
        self._output_text: str = ""
        self._reasoning_text: str = ""
        self.filter_tags = get_config("grok.filter_tags", [])
        self.image_format = get_config("app.image_format", "url")
        self._think_opened: bool = False
        self._search_query_seen: set[str] = set()
        self._search_results_seen: set[str] = set()
        self._search_result_limit: int = 6
        self._search_preview_limit: int = 200
        
        if think is None:
            self.show_think = get_config("grok.thinking", False)
        else:
            self.show_think = think
        self.show_search = bool(get_config("grok.show_search", True))

    def _normalize_search_text(self, value: Any, limit: int) -> str:
        text = " ".join(str(value or "").split()).strip()
        if not text:
            return ""
        if limit > 0 and len(text) > limit:
            return text[:limit] + "..."
        return text

    def _escape_markdown(self, text: str) -> str:
        return re.sub(r"([\\\[\]\(\)])", r"\\\\\1", text or "")

    def _normalize_search_url(self, value: Any) -> str:
        url = str(value or "").strip()
        if not url:
            return ""
        if not (url.startswith("http://") or url.startswith("https://") or url.startswith("/")):
            return ""
        return url.replace(" ", "%20").replace(")", "%29")

    def _format_search_results(self, results: list[dict]) -> str:
        if not results:
            return ""
        limit = max(1, min(10, int(self._search_result_limit or 6)))
        lines: list[str] = []
        for item in results[:limit]:
            title = self._normalize_search_text(item.get("title"), 200) or self._normalize_search_text(item.get("url"), 200)
            url = self._normalize_search_url(item.get("url"))
            preview = self._normalize_search_text(item.get("preview"), self._search_preview_limit)
            if url:
                title_safe = self._escape_markdown(title or "link")
                preview_safe = self._escape_markdown(preview.replace('"', "'")) if preview else ""
                suffix = f' "{preview_safe}"' if preview_safe else ""
                lines.append(f"- [{title_safe}]({url}{suffix})")
            elif title:
                lines.append(f"- {self._escape_markdown(title)}")
        return "\n".join(lines)

    def _extract_tool_usage(self, token_text: str) -> tuple[str, dict] | None:
        if not token_text:
            return None
        tool_match = re.search(r"<xai:tool_name>([^<]+)</xai:tool_name>", token_text)
        tool_name = tool_match.group(1) if tool_match else ""
        args_match = re.search(r"<!\[CDATA\[([\s\S]*?)\]\]>", token_text)
        args: dict = {}
        if args_match:
            try:
                args = orjson.loads(args_match.group(1)) or {}
            except Exception:
                args = {}
        if not tool_name and not args:
            return None
        return tool_name, args

    def _extract_tool_usage_cards(self, token_text: Any) -> list[tuple[str, dict]]:
        text = str(token_text or "")
        if not text:
            return []
        matches = re.findall(r"<xai:tool_usage_card>[\s\S]*?<\/xai:tool_usage_card>", text, flags=re.IGNORECASE)
        if matches:
            parsed: list[tuple[str, dict]] = []
            for m in matches:
                tool = self._extract_tool_usage(m)
                if tool:
                    parsed.append(tool)
            return parsed
        single = self._extract_tool_usage(text)
        return [single] if single else []

    def _extract_results_list(self, web_results: Any) -> list[dict]:
        results_list: list[dict] = []
        if isinstance(web_results, dict) and isinstance(web_results.get("results"), list):
            results_list = web_results.get("results") or []
        elif isinstance(web_results, list):
            results_list = web_results
        return results_list

    def _emit_search_text(self, text: str, current_is_thinking: bool) -> str:
        if not text:
            return ""
        if not self.show_think:
            return text
        output = text
        if not self._think_opened:
            output = f"<think>\n{output}"
            self._think_opened = True
        if not current_is_thinking:
            output = f"{output}</think>\n"
            self._think_opened = False
        return output
    
    async def process(self, response: AsyncIterable[bytes]) -> AsyncGenerator[str, None]:
        """处理流式响应"""
        try:
            async for line in response:
                if not line:
                    continue
                try:
                    data = orjson.loads(line)
                except orjson.JSONDecodeError:
                    continue
                
                resp = data.get("result", {}).get("response", {})
                
                # 元数据
                if (llm := resp.get("llmInfo")) and not self.fingerprint:
                    self.fingerprint = llm.get("modelHash", "")
                if rid := resp.get("responseId"):
                    self.response_id = rid
                
                # 首次发送 role
                if not self.role_sent:
                    yield self._sse(role="assistant")
                    self.role_sent = True
                
                # 图像生成进度
                if img := resp.get("streamingImageGenerationResponse"):
                    if self.show_think:
                        if not self.think_opened:
                            yield self._sse("<think>\n")
                            self.think_opened = True
                        idx = img.get('imageIndex', 0) + 1
                        progress = img.get('progress', 0)
                        yield self._sse(f"正在生成第{idx}张图片中，当前进度{progress}%\n")
                        self._reasoning_text += f"正在生成第{idx}张图片中，当前进度{progress}%\n"
                    continue
                
                # modelResponse
                if mr := resp.get("modelResponse"):
                    if self.show_search:
                        steps = mr.get("steps") if isinstance(mr.get("steps"), list) else []
                        for step in steps:
                            if not isinstance(step, dict):
                                continue
                            step_tags = step.get("tags") if isinstance(step.get("tags"), list) else []
                            step_rollout = step.get("rolloutId") or ""
                            step_tool_id = step.get("toolUsageCardId") or ""
                            prefix = f"[{step_rollout}] " if step_rollout else ""

                            text_parts = step.get("text") if isinstance(step.get("text"), list) else []
                            for raw_text in text_parts:
                                for tool_name, args in self._extract_tool_usage_cards(raw_text):
                                    if not tool_name.startswith("web_search"):
                                        continue
                                    query = self._normalize_search_text(args.get("query"), 200)
                                    if not query:
                                        continue
                                    key = f"{step_rollout or step_tool_id}|{query}"
                                    if key in self._search_query_seen:
                                        continue
                                    self._search_query_seen.add(key)
                                    msg = f"{prefix}🔍 搜索: {query}\n"
                                    out = self._emit_search_text(msg, False)
                                    if out:
                                        yield self._sse(out)
                                        if self.show_think:
                                            self._reasoning_text += out
                                        else:
                                            self._output_text += out

                            step_results = step.get("webSearchResults")
                            results_list = []
                            if isinstance(step_results, dict) and isinstance(step_results.get("results"), list):
                                results_list = step_results.get("results") or []
                            elif isinstance(step_results, list):
                                results_list = step_results
                            if results_list:
                                key = f"{step_rollout or step_tool_id}|{len(results_list)}"
                                if key not in self._search_results_seen:
                                    self._search_results_seen.add(key)
                                    list_md = self._format_search_results(results_list)
                                    msg = f"{prefix}📄 找到 {len(results_list)} 条结果\n"
                                    if list_md:
                                        msg += f"{list_md}\n"
                                    out = self._emit_search_text(msg, False)
                                    if out:
                                        yield self._sse(out)
                                        if self.show_think:
                                            self._reasoning_text += out
                                        else:
                                            self._output_text += out

                            usage_results = step.get("toolUsageResults") if isinstance(step.get("toolUsageResults"), list) else []
                            for usage in usage_results:
                                if not isinstance(usage, dict) or not usage.get("webSearchResults"):
                                    continue
                                results_list = self._extract_results_list(usage.get("webSearchResults"))
                                if not results_list:
                                    continue
                                key = f"{step_rollout or step_tool_id}|{len(results_list)}"
                                if key in self._search_results_seen:
                                    continue
                                self._search_results_seen.add(key)
                                list_md = self._format_search_results(results_list)
                                msg = f"{prefix}📄 找到 {len(results_list)} 条结果\n"
                                if list_md:
                                    msg += f"{list_md}\n"
                                out = self._emit_search_text(msg, False)
                                if out:
                                    yield self._sse(out)
                                    if self.show_think:
                                        self._reasoning_text += out
                                    else:
                                        self._output_text += out

                            if "raw_function_result" in step_tags and step.get("webSearchResults"):
                                results_list = self._extract_results_list(step.get("webSearchResults"))
                                if results_list:
                                    key = f"{step_rollout or step_tool_id}|{len(results_list)}"
                                    if key not in self._search_results_seen:
                                        self._search_results_seen.add(key)
                                        list_md = self._format_search_results(results_list)
                                        msg = f"{prefix}📄 找到 {len(results_list)} 条结果\n"
                                        if list_md:
                                            msg += f"{list_md}\n"
                                        out = self._emit_search_text(msg, False)
                                        if out:
                                            yield self._sse(out)
                                            if self.show_think:
                                                self._reasoning_text += out
                                            else:
                                                self._output_text += out
                    if self.think_opened and self.show_think:
                        if msg := mr.get("message"):
                            yield self._sse(msg + "\n")
                            self._reasoning_text += msg + "\n"
                        yield self._sse("</think>\n")
                        self.think_opened = False
                    
                    # 处理生成的图片
                    for url in mr.get("generatedImageUrls", []):
                        parts = url.split("/")
                        img_id = parts[-2] if len(parts) >= 2 else "image"

                        if self.image_format == "base64":
                            dl_service = self._get_dl()
                            base64_data = await dl_service.to_base64(url, self.token, "image")
                            if base64_data:
                                yield self._sse(f"![{img_id}]({base64_data})\n")
                                self._output_text += f"![{img_id}]({base64_data})\n"
                            else:
                                final_url = await self.process_url(url, "image")
                                yield self._sse(f"![{img_id}]({final_url})\n")
                                self._output_text += f"![{img_id}]({final_url})\n"
                        else:
                            final_url = await self.process_url(url, "image")
                            yield self._sse(f"![{img_id}]({final_url})\n")
                            self._output_text += f"![{img_id}]({final_url})\n"
                    
                    if (meta := mr.get("metadata", {})).get("llm_info", {}).get("modelHash"):
                        self.fingerprint = meta["llm_info"]["modelHash"]
                    continue
                
                # 普通 token
                if (token := resp.get("token")) is not None:
                    if token and isinstance(token, str):
                        current_is_thinking = bool(resp.get("isThinking"))
                        message_tag = resp.get("messageTag")
                        rollout_id = resp.get("rolloutId") or ""
                        tool_usage_card_id = resp.get("toolUsageCardId") or ""

                        # 搜索过程：工具卡
                        if self.show_search and message_tag == "tool_usage_card":
                            parsed = self._extract_tool_usage(token)
                            if parsed:
                                tool_name, args = parsed
                                if tool_name.startswith("web_search"):
                                    query = self._normalize_search_text(args.get("query"), 200)
                                    if query:
                                        key = f"{rollout_id or tool_usage_card_id}|{query}"
                                        if key not in self._search_query_seen:
                                            self._search_query_seen.add(key)
                                            prefix = f"[{rollout_id}] " if rollout_id else ""
                                            msg = f"{prefix}🔍 搜索: {query}\n"
                                            out = self._emit_search_text(msg, current_is_thinking)
                                            if out:
                                                yield self._sse(out)
                                                self._reasoning_text += out
                            continue

                        # 搜索过程：函数结果
                        if self.show_search and message_tag == "raw_function_result":
                            web_results = resp.get("webSearchResults")
                            results_list: list[dict] = []
                            if isinstance(web_results, dict) and isinstance(web_results.get("results"), list):
                                results_list = web_results.get("results") or []
                            elif isinstance(web_results, list):
                                results_list = web_results
                            if results_list:
                                key = f"{rollout_id or tool_usage_card_id}|{len(results_list)}"
                                if key not in self._search_results_seen:
                                    self._search_results_seen.add(key)
                                    prefix = f"[{rollout_id}] " if rollout_id else ""
                                    list_md = self._format_search_results(results_list)
                                    msg = f"{prefix}📄 找到 {len(results_list)} 条结果\n"
                                    if list_md:
                                        msg += f"{list_md}\n"
                                    out = self._emit_search_text(msg, current_is_thinking)
                                    if out:
                                        yield self._sse(out)
                                        self._reasoning_text += out
                            continue

                        # 搜索过程：无 messageTag 但带结果
                        if self.show_search and isinstance(resp.get("webSearchResults"), dict) and isinstance(resp.get("webSearchResults").get("results"), list):
                            results_list = resp.get("webSearchResults").get("results") or []
                            if results_list:
                                key = f"{rollout_id or tool_usage_card_id}|{len(results_list)}"
                                if key not in self._search_results_seen:
                                    self._search_results_seen.add(key)
                                    prefix = f"[{rollout_id}] " if rollout_id else ""
                                    list_md = self._format_search_results(results_list)
                                    msg = f"{prefix}📄 找到 {len(results_list)} 条结果\n"
                                    if list_md:
                                        msg += f"{list_md}\n"
                                    out = self._emit_search_text(msg, current_is_thinking)
                                    if out:
                                        yield self._sse(out)
                                        self._reasoning_text += out
                            continue

                        if self.filter_tags and any(t in token for t in self.filter_tags):
                            continue

                        # 推理包裹
                        out_token = token
                        if current_is_thinking:
                            if self.show_think and not self._think_opened:
                                out_token = f"<think>\n{out_token}"
                                self._think_opened = True
                            elif not self.show_think:
                                continue
                        elif self._think_opened and self.show_think:
                            out_token = f"\n</think>\n{out_token}"
                            self._think_opened = False

                        yield self._sse(out_token)
                        if self._think_opened and self.show_think:
                            self._reasoning_text += out_token
                        else:
                            self._output_text += out_token
                        
            if self.think_opened:
                yield self._sse("</think>\n")
                self.think_opened = False
            if self._think_opened:
                yield self._sse("\n</think>\n")
                self._think_opened = False
            yield self._sse(finish="stop")
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error(f"Stream processing error: {e}", extra={"model": self.model})
            raise
        finally:
            await self.close()

    def build_usage(self, prompt_messages: Optional[list[dict]] = None) -> dict[str, Any]:
        usage = build_chat_usage(prompt_messages or [], (self._output_text + self._reasoning_text))
        return usage


class CollectProcessor(BaseProcessor):
    """非流式响应处理器"""
    
    def __init__(self, model: str, token: str = ""):
        super().__init__(model, token)
        self.image_format = get_config("app.image_format", "url")
        self.filter_tags = get_config("grok.filter_tags", [])
        self.show_think = get_config("grok.thinking", False)
        self.show_search = bool(get_config("grok.show_search", True))
        self._think_opened = False
        self._search_query_seen: set[str] = set()
        self._search_results_seen: set[str] = set()
        self._search_result_limit: int = 6
        self._search_preview_limit: int = 200

    def _normalize_search_text(self, value: Any, limit: int) -> str:
        text = " ".join(str(value or "").split()).strip()
        if not text:
            return ""
        if limit > 0 and len(text) > limit:
            return text[:limit] + "..."
        return text

    def _escape_markdown(self, text: str) -> str:
        return re.sub(r"([\\\[\]\(\)])", r"\\\\\1", text or "")

    def _normalize_search_url(self, value: Any) -> str:
        url = str(value or "").strip()
        if not url:
            return ""
        if not (url.startswith("http://") or url.startswith("https://") or url.startswith("/")):
            return ""
        return url.replace(" ", "%20").replace(")", "%29")

    def _format_search_results(self, results: list[dict]) -> str:
        if not results:
            return ""
        limit = max(1, min(10, int(self._search_result_limit or 6)))
        lines: list[str] = []
        for item in results[:limit]:
            title = self._normalize_search_text(item.get("title"), 200) or self._normalize_search_text(item.get("url"), 200)
            url = self._normalize_search_url(item.get("url"))
            preview = self._normalize_search_text(item.get("preview"), self._search_preview_limit)
            if url:
                title_safe = self._escape_markdown(title or "link")
                preview_safe = self._escape_markdown(preview.replace('"', "'")) if preview else ""
                suffix = f' "{preview_safe}"' if preview_safe else ""
                lines.append(f"- [{title_safe}]({url}{suffix})")
            elif title:
                lines.append(f"- {self._escape_markdown(title)}")
        return "\n".join(lines)

    def _extract_tool_usage(self, token_text: str) -> tuple[str, dict] | None:
        if not token_text:
            return None
        tool_match = re.search(r"<xai:tool_name>([^<]+)</xai:tool_name>", token_text)
        tool_name = tool_match.group(1) if tool_match else ""
        args_match = re.search(r"<!\[CDATA\[([\s\S]*?)\]\]>", token_text)
        args: dict = {}
        if args_match:
            try:
                args = orjson.loads(args_match.group(1)) or {}
            except Exception:
                args = {}
        if not tool_name and not args:
            return None
        return tool_name, args

    def _emit_search_text(self, text: str, current_is_thinking: bool) -> str:
        if not text:
            return ""
        if not self.show_think:
            return text
        output = text
        if not self._think_opened:
            output = f"<think>\n{output}"
            self._think_opened = True
        if not current_is_thinking:
            output = f"{output}</think>\n"
            self._think_opened = False
        return output
    
    async def process(self, response: AsyncIterable[bytes], prompt_messages: Optional[list[dict]] = None) -> dict[str, Any]:
        """处理并收集完整响应"""
        response_id = ""
        fingerprint = ""
        content = ""
        saw_token = False
        is_thinking = False
        thinking_finished = False
        
        try:
            async for line in response:
                if not line:
                    continue
                try:
                    data = orjson.loads(line)
                except orjson.JSONDecodeError:
                    continue
                
                resp = data.get("result", {}).get("response", {})
                
                if (llm := resp.get("llmInfo")) and not fingerprint:
                    fingerprint = llm.get("modelHash", "")
                
                if (token := resp.get("token")) is not None and isinstance(token, str):
                    current_is_thinking = bool(resp.get("isThinking"))
                    message_tag = resp.get("messageTag")
                    rollout_id = resp.get("rolloutId") or ""
                    tool_usage_card_id = resp.get("toolUsageCardId") or ""
                    if thinking_finished and current_is_thinking:
                        is_thinking = current_is_thinking
                        continue

                    if self.show_search and message_tag == "tool_usage_card":
                        parsed = self._extract_tool_usage(token)
                        if parsed:
                            tool_name, args = parsed
                            if tool_name.startswith("web_search"):
                                query = self._normalize_search_text(args.get("query"), 200)
                                if query:
                                    key = f"{rollout_id or tool_usage_card_id}|{query}"
                                    if key not in self._search_query_seen:
                                        self._search_query_seen.add(key)
                                        prefix = f"[{rollout_id}] " if rollout_id else ""
                                        msg = f"{prefix}🔍 搜索: {query}\n"
                                        out = self._emit_search_text(msg, current_is_thinking)
                                        if out:
                                            content += out
                                            saw_token = True
                        if is_thinking and not current_is_thinking:
                            thinking_finished = True
                        is_thinking = current_is_thinking
                        continue

                    if self.show_search and message_tag == "raw_function_result":
                        web_results = resp.get("webSearchResults")
                        results_list: list[dict] = []
                        if isinstance(web_results, dict) and isinstance(web_results.get("results"), list):
                            results_list = web_results.get("results") or []
                        elif isinstance(web_results, list):
                            results_list = web_results
                        if results_list:
                            key = f"{rollout_id or tool_usage_card_id}|{len(results_list)}"
                            if key not in self._search_results_seen:
                                self._search_results_seen.add(key)
                                prefix = f"[{rollout_id}] " if rollout_id else ""
                                list_md = self._format_search_results(results_list)
                                msg = f"{prefix}📄 找到 {len(results_list)} 条结果\n"
                                if list_md:
                                    msg += f"{list_md}\n"
                                out = self._emit_search_text(msg, current_is_thinking)
                                if out:
                                    content += out
                                    saw_token = True
                        if is_thinking and not current_is_thinking:
                            thinking_finished = True
                        is_thinking = current_is_thinking
                        continue

                    if self.show_search and isinstance(resp.get("webSearchResults"), dict) and isinstance(resp.get("webSearchResults").get("results"), list):
                        results_list = resp.get("webSearchResults").get("results") or []
                        if results_list:
                            key = f"{rollout_id or tool_usage_card_id}|{len(results_list)}"
                            if key not in self._search_results_seen:
                                self._search_results_seen.add(key)
                                prefix = f"[{rollout_id}] " if rollout_id else ""
                                list_md = self._format_search_results(results_list)
                                msg = f"{prefix}📄 找到 {len(results_list)} 条结果\n"
                                if list_md:
                                    msg += f"{list_md}\n"
                                out = self._emit_search_text(msg, current_is_thinking)
                                if out:
                                    content += out
                                    saw_token = True
                        if is_thinking and not current_is_thinking:
                            thinking_finished = True
                        is_thinking = current_is_thinking
                        continue

                    if self.filter_tags and any(t in token for t in self.filter_tags):
                        continue

                    out_token = token
                    if current_is_thinking:
                        if self.show_think and not self._think_opened:
                            out_token = f"<think>\n{out_token}"
                            self._think_opened = True
                        elif not self.show_think:
                            continue
                    elif self._think_opened and self.show_think:
                        out_token = f"\n</think>\n{out_token}"
                        self._think_opened = False
                        if is_thinking:
                            thinking_finished = True
                    content += out_token
                    saw_token = True
                    is_thinking = current_is_thinking

                if mr := resp.get("modelResponse"):
                    if self.show_search:
                        steps = mr.get("steps") if isinstance(mr.get("steps"), list) else []
                        for step in steps:
                            if not isinstance(step, dict):
                                continue
                            step_tags = step.get("tags") if isinstance(step.get("tags"), list) else []
                            step_rollout = step.get("rolloutId") or ""
                            step_tool_id = step.get("toolUsageCardId") or ""
                            prefix = f"[{step_rollout}] " if step_rollout else ""

                            text_parts = step.get("text") if isinstance(step.get("text"), list) else []
                            for raw_text in text_parts:
                                for tool_name, args in self._extract_tool_usage_cards(raw_text):
                                    if not tool_name.startswith("web_search"):
                                        continue
                                    query = self._normalize_search_text(args.get("query"), 200)
                                    if not query:
                                        continue
                                    key = f"{step_rollout or step_tool_id}|{query}"
                                    if key in self._search_query_seen:
                                        continue
                                    self._search_query_seen.add(key)
                                    msg = f"{prefix}🔍 搜索: {query}\n"
                                    out = self._emit_search_text(msg, False)
                                    if out:
                                        content += out
                                        saw_token = True

                            results_list = self._extract_results_list(step.get("webSearchResults"))
                            if results_list:
                                key = f"{step_rollout or step_tool_id}|{len(results_list)}"
                                if key not in self._search_results_seen:
                                    self._search_results_seen.add(key)
                                    list_md = self._format_search_results(results_list)
                                    msg = f"{prefix}📄 找到 {len(results_list)} 条结果\n"
                                    if list_md:
                                        msg += f"{list_md}\n"
                                    out = self._emit_search_text(msg, False)
                                    if out:
                                        content += out
                                        saw_token = True

                            usage_results = step.get("toolUsageResults") if isinstance(step.get("toolUsageResults"), list) else []
                            for usage in usage_results:
                                if not isinstance(usage, dict) or not usage.get("webSearchResults"):
                                    continue
                                results_list = self._extract_results_list(usage.get("webSearchResults"))
                                if not results_list:
                                    continue
                                key = f"{step_rollout or step_tool_id}|{len(results_list)}"
                                if key in self._search_results_seen:
                                    continue
                                self._search_results_seen.add(key)
                                list_md = self._format_search_results(results_list)
                                msg = f"{prefix}📄 找到 {len(results_list)} 条结果\n"
                                if list_md:
                                    msg += f"{list_md}\n"
                                out = self._emit_search_text(msg, False)
                                if out:
                                    content += out
                                    saw_token = True

                            if "raw_function_result" in step_tags and step.get("webSearchResults"):
                                results_list = self._extract_results_list(step.get("webSearchResults"))
                                if results_list:
                                    key = f"{step_rollout or step_tool_id}|{len(results_list)}"
                                    if key not in self._search_results_seen:
                                        self._search_results_seen.add(key)
                                        list_md = self._format_search_results(results_list)
                                        msg = f"{prefix}📄 找到 {len(results_list)} 条结果\n"
                                        if list_md:
                                            msg += f"{list_md}\n"
                                        out = self._emit_search_text(msg, False)
                                        if out:
                                            content += out
                                            saw_token = True
                    response_id = mr.get("responseId", "")
                    if not saw_token and isinstance(mr.get("message"), str):
                        content = mr.get("message", "")
                    
                    if urls := mr.get("generatedImageUrls"):
                        content += "\n"
                        for url in urls:
                            parts = url.split("/")
                            img_id = parts[-2] if len(parts) >= 2 else "image"
                            
                            if self.image_format == "base64":
                                dl_service = self._get_dl()
                                base64_data = await dl_service.to_base64(url, self.token, "image")
                                if base64_data:
                                    content += f"![{img_id}]({base64_data})\n"
                                else:
                                    final_url = await self.process_url(url, "image")
                                    content += f"![{img_id}]({final_url})\n"
                            else:
                                final_url = await self.process_url(url, "image")
                                content += f"![{img_id}]({final_url})\n"
                    
                    if (meta := mr.get("metadata", {})).get("llm_info", {}).get("modelHash"):
                        fingerprint = meta["llm_info"]["modelHash"]
                            
        except Exception as e:
            logger.error(f"Collect processing error: {e}", extra={"model": self.model})
        finally:
            await self.close()
        
        if self.show_think and self._think_opened:
            content += "\n</think>\n"
            self._think_opened = False
        usage = build_chat_usage(prompt_messages or [], content)
        return {
            "id": response_id,
            "object": "chat.completion",
            "created": self.created,
            "model": self.model,
            "system_fingerprint": fingerprint,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": content, "refusal": None, "annotations": []},
                "finish_reason": "stop"
            }],
            "usage": usage
        }


class VideoStreamProcessor(BaseProcessor):
    """视频流式响应处理器"""
    
    def __init__(self, model: str, token: str = "", think: bool = None):
        super().__init__(model, token)
        self.response_id: Optional[str] = None
        self.think_opened: bool = False
        self.role_sent: bool = False
        self.video_format = get_config("app.video_format", "url")
        
        if think is None:
            self.show_think = get_config("grok.thinking", False)
        else:
            self.show_think = think
    
    def _build_video_html(self, video_url: str, thumbnail_url: str = "") -> str:
        """构建视频 HTML 标签"""
        if get_config("grok.video_poster_preview", False):
            return _build_video_poster_preview(video_url, thumbnail_url)
        poster_attr = f' poster="{thumbnail_url}"' if thumbnail_url else ""
        return f'''<video id="video" controls="" preload="none"{poster_attr}>
  <source id="mp4" src="{video_url}" type="video/mp4">
</video>'''
    
    async def process(self, response: AsyncIterable[bytes]) -> AsyncGenerator[str, None]:
        """处理视频流式响应"""
        try:
            async for line in response:
                if not line:
                    continue
                try:
                    data = orjson.loads(line)
                except orjson.JSONDecodeError:
                    continue
                
                resp = data.get("result", {}).get("response", {})
                
                if rid := resp.get("responseId"):
                    self.response_id = rid
                
                # 首次发送 role
                if not self.role_sent:
                    yield self._sse(role="assistant")
                    self.role_sent = True
                
                # 视频生成进度
                if video_resp := resp.get("streamingVideoGenerationResponse"):
                    progress = video_resp.get("progress", 0)
                    
                    if self.show_think:
                        if not self.think_opened:
                            yield self._sse("<think>\n")
                            self.think_opened = True
                        yield self._sse(f"正在生成视频中，当前进度{progress}%\n")
                    
                    if progress == 100:
                        video_url = video_resp.get("videoUrl", "")
                        thumbnail_url = video_resp.get("thumbnailImageUrl", "")
                        
                        if self.think_opened and self.show_think:
                            yield self._sse("</think>\n")
                            self.think_opened = False
                        
                        if video_url:
                            final_video_url = await self.process_url(video_url, "video")
                            final_thumbnail_url = ""
                            if thumbnail_url:
                                final_thumbnail_url = await self.process_url(thumbnail_url, "image")
                            
                            video_html = self._build_video_html(final_video_url, final_thumbnail_url)
                            yield self._sse(video_html)
                            
                            logger.info(f"Video generated: {video_url}")
                    continue
                        
            if self.think_opened:
                yield self._sse("</think>\n")
            yield self._sse(finish="stop")
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error(f"Video stream processing error: {e}", extra={"model": self.model})
        finally:
            await self.close()


class VideoCollectProcessor(BaseProcessor):
    """视频非流式响应处理器"""
    
    def __init__(self, model: str, token: str = ""):
        super().__init__(model, token)
        self.video_format = get_config("app.video_format", "url")
    
    def _build_video_html(self, video_url: str, thumbnail_url: str = "") -> str:
        if get_config("grok.video_poster_preview", False):
            return _build_video_poster_preview(video_url, thumbnail_url)
        poster_attr = f' poster="{thumbnail_url}"' if thumbnail_url else ""
        return f'''<video id="video" controls="" preload="none"{poster_attr}>
  <source id="mp4" src="{video_url}" type="video/mp4">
</video>'''
    
    async def process(self, response: AsyncIterable[bytes]) -> dict[str, Any]:
        """处理并收集视频响应"""
        response_id = ""
        content = ""
        
        try:
            async for line in response:
                if not line:
                    continue
                try:
                    data = orjson.loads(line)
                except orjson.JSONDecodeError:
                    continue
                
                resp = data.get("result", {}).get("response", {})
                
                if video_resp := resp.get("streamingVideoGenerationResponse"):
                    if video_resp.get("progress") == 100:
                        response_id = resp.get("responseId", "")
                        video_url = video_resp.get("videoUrl", "")
                        thumbnail_url = video_resp.get("thumbnailImageUrl", "")
                        
                        if video_url:
                            final_video_url = await self.process_url(video_url, "video")
                            final_thumbnail_url = ""
                            if thumbnail_url:
                                final_thumbnail_url = await self.process_url(thumbnail_url, "image")
                            
                            content = self._build_video_html(final_video_url, final_thumbnail_url)
                            logger.info(f"Video generated: {video_url}")
                            
        except Exception as e:
            logger.error(f"Video collect processing error: {e}", extra={"model": self.model})
        finally:
            await self.close()
        
        return {
            "id": response_id,
            "object": "chat.completion",
            "created": self.created,
            "model": self.model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": content, "refusal": None},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }


class ImageStreamProcessor(BaseProcessor):
    """图片生成流式响应处理器"""
    
    def __init__(
        self,
        model: str,
        token: str = "",
        n: int = 1,
        response_format: str = "b64_json",
    ):
        super().__init__(model, token)
        self.partial_index = 0
        self.n = n
        self.target_index = random.randint(0, 1) if n == 1 else None
        self.response_format = (response_format or "b64_json").lower()
        if self.response_format == "url":
            self.response_field = "url"
        elif self.response_format == "base64":
            self.response_field = "base64"
        else:
            self.response_field = "b64_json"
    
    def _sse(self, event: str, data: dict) -> str:
        """构建 SSE 响应 (覆盖基类)"""
        return f"event: {event}\ndata: {orjson.dumps(data).decode()}\n\n"
    
    async def process(self, response: AsyncIterable[bytes]) -> AsyncGenerator[str, None]:
        """处理流式响应"""
        final_images = []
        
        try:
            async for line in response:
                if not line:
                    continue
                try:
                    data = orjson.loads(line)
                except orjson.JSONDecodeError:
                    continue
                
                resp = data.get("result", {}).get("response", {})
                
                # 图片生成进度
                if img := resp.get("streamingImageGenerationResponse"):
                    image_index = img.get("imageIndex", 0)
                    progress = img.get("progress", 0)
                    
                    if self.n == 1 and image_index != self.target_index:
                        continue
                    
                    out_index = 0 if self.n == 1 else image_index
                    
                    yield self._sse("image_generation.partial_image", {
                        "type": "image_generation.partial_image",
                        self.response_field: "",
                        "index": out_index,
                        "progress": progress
                    })
                    continue
                
                # modelResponse
                if mr := resp.get("modelResponse"):
                    if urls := mr.get("generatedImageUrls"):
                        for url in urls:
                            if self.response_format == "url":
                                processed = await self.process_url(url, "image")
                                if processed:
                                    final_images.append(processed)
                                continue
                            dl_service = self._get_dl()
                            base64_data = await dl_service.to_base64(url, self.token, "image")
                            if base64_data:
                                if "," in base64_data:
                                    b64 = base64_data.split(",", 1)[1]
                                else:
                                    b64 = base64_data
                                final_images.append(b64)
                    continue
                    
            for index, b64 in enumerate(final_images):
                if self.n == 1:
                    if index != self.target_index:
                        continue
                    out_index = 0
                else:
                    out_index = index
                
                yield self._sse("image_generation.completed", {
                    "type": "image_generation.completed",
                    self.response_field: b64,
                    "index": out_index,
                    "usage": {
                        "total_tokens": 50,
                        "input_tokens": 25,
                        "output_tokens": 25,
                        "input_tokens_details": {"text_tokens": 5, "image_tokens": 20}
                    }
                })
        except Exception as e:
            logger.error(f"Image stream processing error: {e}")
            raise
        finally:
            await self.close()


class ImageCollectProcessor(BaseProcessor):
    """图片生成非流式响应处理器"""
    
    def __init__(
        self,
        model: str,
        token: str = "",
        response_format: str = "b64_json",
    ):
        super().__init__(model, token)
        self.response_format = (response_format or "b64_json").lower()
    
    async def process(self, response: AsyncIterable[bytes]) -> List[str]:
        """处理并收集图片"""
        images = []
        
        try:
            async for line in response:
                if not line:
                    continue
                try:
                    data = orjson.loads(line)
                except orjson.JSONDecodeError:
                    continue
                
                resp = data.get("result", {}).get("response", {})
                
                if mr := resp.get("modelResponse"):
                    if urls := mr.get("generatedImageUrls"):
                        for url in urls:
                            if self.response_format == "url":
                                processed = await self.process_url(url, "image")
                                if processed:
                                    images.append(processed)
                                continue
                            dl_service = self._get_dl()
                            base64_data = await dl_service.to_base64(url, self.token, "image")
                            if base64_data:
                                if "," in base64_data:
                                    b64 = base64_data.split(",", 1)[1]
                                else:
                                    b64 = base64_data
                                images.append(b64)
                                
        except Exception as e:
            logger.error(f"Image collect processing error: {e}")
        finally:
            await self.close()
        
        return images


__all__ = [
    "StreamProcessor",
    "CollectProcessor",
    "VideoStreamProcessor",
    "VideoCollectProcessor",
    "ImageStreamProcessor",
    "ImageCollectProcessor",
]
