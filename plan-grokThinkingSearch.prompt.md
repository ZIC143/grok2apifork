## Plan: 思考/搜索过程展示（Workers + FastAPI 对齐）

### 目标

- 在 Workers 与 FastAPI 两端新增 `grok.show_search`（默认 `true`），把 Grok 的“搜索查询词 + 结果数量（+ 可选标题/链接列表）”解析并输出到 `<think>...</think>` 推理段。
- 同时补齐 `stream=false`（非流式）聚合逻辑：两端都能返回包含 `<think>` 的完整内容，且用量统计能正确计算 `reasoning_tokens`。
- 搜索过程 **仅在** `grok.thinking=true` 时展示（`grok.show_search` 作为附属开关）；两端行为、文案与边界条件对齐，且不污染最终回答。

### 外部行为/协议约定

- `<think>` 内：推理 token + 搜索过程（query/count/list）。
- `<think>` 外：最终回答 token。
- `grok.thinking=false`：不输出 `<think>`，并丢弃上游 `isThinking=true` 的 token 与搜索过程。
- `grok.thinking=true` 且 `grok.show_search=false`：仍输出推理 token（`isThinking=true`），但不输出“搜索 query/结果数/列表”。
- 结果列表默认用 Markdown 列表输出（更通用）：`- [title](url "preview")`。
  - 内置聊天页如需可点击链接，可增强渲染（见后文）。

---

## Steps

### 1) 配置与配置页：新增 `show_search`（两端一致）

- FastAPI 默认配置：在 [config.defaults.toml](config.defaults.toml) 的 `[grok]` 下新增 `show_search = true`。
- 配置页文案：在 [app/static/config/config.js](app/static/config/config.js) 的 `LOCALE_MAP.grok` 新增 `show_search` 的标题与说明（配置页会自动渲染 bool 开关，需补齐中文解释）。
- Workers（D1 settings）对齐：
  - 在 [src/settings.ts](src/settings.ts) 的 `GrokSettings` 增加 `show_search?: boolean`，并在 `DEFAULTS.grok` 增加 `show_search: true`。
  - 在 [src/routes/admin.ts](src/routes/admin.ts) 的 `/api/v1/admin/config`：
    - GET：回传 `grok.show_search`（与 Python 配置结构一致）。
    - POST：支持写入 `grok.show_search` 并持久化到 settings。
  - 新部署默认值：在 [migrations/0001_init.sql](migrations/0001_init.sql) 的默认 `settings(grok)` JSON 中补上 `show_search`（避免新库缺项）。

### 2) 统一解析约束（先定清“缺什么就补什么”）

两端都按同一套 NDJSON 解析约束实现，避免行为漂移：

- 兼容字段来源：优先读 `data.result.response.*`，必要时兼容 `data.result.*`（继续对话/特殊帧可能把 `token/isThinking` 放在更外层）。
- 关注字段：
  - `token: string`（文本 token）
  - `isThinking: boolean`（是否处于推理段）
  - `messageTag: string`（`tool_usage_card` / `raw_function_result` 等）
  - `rolloutId` / `toolUsageCardId`（用于去重/关联）
  - `webSearchResults.results[]`（结果列表）

搜索过程解析（仅在 `showThinking && showSearch` 下输出）：

- `messageTag == "tool_usage_card"`：解析 token 文本中的 `<xai:tool_name>` 与 CDATA JSON 参数。
  - 当 tool 为 `web_search`：输出一行 `🔍 搜索: {query}`（可加 `[rolloutId]` 前缀）。
- `messageTag == "raw_function_result"` 或出现 `webSearchResults`：
  - 输出一行 `📄 找到 N 条结果`。
  - 可选：输出前 K 条结果为 Markdown 列表（标题/URL/preview 需做安全裁剪与转义）。

关键约束：

- **必须在** `filtered_tags`/`filter_tags` 过滤之前处理 `messageTag/webSearchResults`，避免默认过滤导致“工具卡被跳过，无法解析 query”。
- 去重：基于 `rolloutId/toolUsageCardId + query/count` 做 best-effort 去重，避免同一批结果反复刷屏。
- 输出限制：K（如 5~10）+ preview 截断（如 200 字符），防止推理面板爆量。

### 3) Workers：流式解析（SSE）

在 [src/grok/processor.ts](src/grok/processor.ts) 的 `createOpenAiStreamFromGrokNdjson()`：

- 增加 `showSearch = settings.show_search !== false`（且仅当 `showThinking` 为真才生效）。
- 把 `messageTag/toolUsageCardId/webSearchResults` 的处理前置到过滤逻辑之前。
- 按“统一解析约束”输出 query/count/list，且 **强制写入 `<think>` 段内**。

### 4) Workers：非流式解析（stream=false）

扩展 [src/grok/processor.ts](src/grok/processor.ts) 的 `parseOpenAiFromGrokNdjson()`：

- 复用与流式相同的 token/isThinking/messageTag/webSearchResults 解析逻辑，聚合成最终 `content`（包含 `<think>` 段）。
- 无 token 时再回退 `modelResponse.message`（或视频/图片的既有回退路径）。
- 确保 `buildChatUsageFromTexts()` 能通过 `<think>` 拆分正确计算 `reasoning_tokens`。

### 5) FastAPI：流式解析（SSE）

在 [app/services/grok/processor.py](app/services/grok/processor.py) 的 `StreamProcessor.process()`：

- 新增 `self.show_search = bool(get_config("grok.show_search", True))`，并与 `self.show_think` 联动（`show_think` 关闭则视为 `show_search` 关闭）。
- 补齐对 `isThinking/messageTag/webSearchResults/rolloutId/toolUsageCardId` 的解析与输出，参考 [grok2api_new-main/app/services/grok_client.py](grok2api_new-main/app/services/grok_client.py) 的 `tool_usage_card/raw_function_result` 路径。
- 调整过滤顺序：先处理 messageTag/webSearchResults，再对普通 token 应用 `filter_tags`。

### 6) FastAPI：非流式解析 + 用量一致

在 [app/services/grok/processor.py](app/services/grok/processor.py) 的 `CollectProcessor.process()`：

- 同样解析 token/isThinking/messageTag/webSearchResults，构造带 `<think>` 的完整 `content`；无 token 再回退 `modelResponse.message`。
- 确保 `build_chat_usage()` 的输入是最终聚合后的 completionText，使 `reasoning_tokens` 统计与流式一致。

### 7) 内置聊天页（/chat、/admin/chat）：可折叠推理面板（默认折叠）

> 这一步不影响“纯 API 客户端”，但能满足“展示/实时可视化”的需求。

- 在 [app/static/chat/chat.js](app/static/chat/chat.js)：
  - 增加流式友好的 `<think>` 分段器（支持 `</think>` 未到达的中间态）。
  - assistant bubble 内拆成两块：推理面板 + 最终回答区；推理面板默认折叠，且无推理内容时隐藏。
  - 历史清洁：写入 `chatMessages` 时仅保留最终回答（剥离 `<think>`），避免把推理/搜索过程带回上下文。
  - 同步改造 `streamChat()` / `streamVideo()` / `retryLastAssistantAnswer()` 的渲染与入库逻辑。
- 在 [app/static/chat/chat.css](app/static/chat/chat.css)：增加推理面板样式与折叠交互视觉。
- 若后端输出 Markdown 链接列表：可在前端做最小渲染增强（把 `- [t](u)` 转为可点击 `<a>`），仍通过 `sanitizeHtml()` 做安全兜底。

### 8) 文档与一致性校验

- 在 [readme.md](readme.md) 或 [README.cloudflare.md](README.cloudflare.md) 追加 `grok.show_search` 说明，并强调其依赖 `grok.thinking`。
- 两端默认值与配置页开关保持一致。

---

## Verification

- 流式：触发搜索的提示词，确认 SSE 中出现 `<think>`，且 `<think>` 内包含“搜索 query / 找到 N 条结果（+ 列表）”。关闭 `grok.thinking` 后不输出推理/搜索。
- 非流式：相同提示词 `stream=false`，返回内容包含 `<think>` 段与搜索信息（受开关控制）。
- 配置：在配置页切换 `grok.show_search` 与 `grok.thinking`，确认两端实时生效且表现一致。
- 回归：图片/视频/生图流式进度不受影响。

## Decisions

- 使用 `<think>...</think>` 作为统一承载协议（避免引入自定义 SSE event，最大化兼容 OpenAI SSE 客户端）。
- 搜索过程展示仅在 `grok.thinking=true` 时生效，`grok.show_search` 作为附属开关。
- 流式与非流式都支持输出 `<think>` 内的推理/搜索信息，保证端到端一致。
