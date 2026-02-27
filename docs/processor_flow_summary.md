# Grok 上游响应处理流程详解（按行号）

> 覆盖文件：
> - app/services/grok/processor.py
> - src/grok/processor.ts
>
> 目标：从“接收上游响应”到“输出响应”的完整链路，按行号列出每一步。

---

## 一、Python：app/services/grok/processor.py

### 1) 公共工具与输出构建

- 资产预览与 HTML 生成
  - L21-L39：`_build_video_poster_preview()` 生成视频 Poster 预览 HTML（用于前端展示链接/海报）。

- 基础处理器与通用输出
  - L45-L50：`BaseProcessor.__init__()` 记录 `model`、`token`、`created`、`app_url` 等上下文信息。
  - L52-L56：`_get_dl()` 懒加载并复用 `DownloadService`。
  - L58-L61：`close()` 关闭下载服务连接。
  - L64-L83：`process_url()` 统一资产 URL 处理：
    - 规范路径（补 `/`）、过滤根路径（空/`/`）。
    - 调用下载服务缓存到本地 `/v1/files/{media_type}{path}`。
    - 若配置 `app_url` 则拼接为完整 URL。
  - L87-L107：`_sse()` 统一生成 OpenAI SSE chunk（`chat.completion.chunk`）。

---

### 2) 流式对话：`StreamProcessor.process()`

**总体入口**
- L308：`async def process()` 入口，开始流式处理。

**接收并解析上游 NDJSON**
- L311-L318：对上游 `response` 逐行读取，忽略空行/JSON 解析失败。
- L319：定位 `resp = data.result.response`，作为后续解析主体。

**元数据与 role**
- L321-L325：提取 `llmInfo.modelHash` 与 `responseId` 并缓存。
- L327-L330：首次输出 role（`assistant`）。

**图像生成进度（thinking 渲染）**
- L332-L342：当 `streamingImageGenerationResponse` 出现：
  - L334-L337：必要时打开 `<think>`。
  - L338-L341：输出“第 N 张图片进度”并记录到 `_reasoning_text`。
  - L342：处理完进度后 `continue`。

**模型级 `modelResponse`（搜索摘要 + 结果 + 图片）**
- L344-L446：当 `modelResponse` 出现且尚未在流中看到搜索结果：
  - L346-L369：从 `steps[*].text` 中解析 `tool_usage_card`，抽取 `web_search` 查询并入队。
  - L370-L391：处理 `steps[*].webSearchResults`（去重 + 生成 Markdown 列表）。
  - L393-L420：处理 `steps[*].toolUsageResults` 中的 `webSearchResults`（去重 + 列表输出）。
  - L422-L444：处理带 `raw_function_result` 标签的 `webSearchResults`（去重 + 列表输出）。

- L448-L453：若此前开启 `<think>` 且 `modelResponse.message` 存在，先输出消息，再关闭 `<think>`。
- L455-L457：若 search 打开了 `_think_opened`，补充关闭标签。
- L459-L483：处理 `generatedImageUrls`：
  - L464-L477：`image_format=base64` 时尝试转 base64，失败回退到 `process_url()`。
  - L478-L483：`image_format=url` 直接 `process_url()`。
  - 均以 Markdown 图片输出，并累积 `_output_text`。
- L485-L486：读取 `metadata.llm_info.modelHash` 更新 `fingerprint`。

**普通 token 流**
- L489-L495：读取 token、thinking 状态、messageTag、rollout/tool_usage_card_id。
- L497-L510：`tool_usage_card`：解析搜索查询，去重后入队。
- L512-L535：`raw_function_result`：输出搜索结果列表（去重 + 输出到 `<think>` 或正文）。
- L537-L559：无 `messageTag` 但有 `webSearchResults`：同样输出搜索结果。
- L562-L563：过滤 `filter_tags`（直接跳过 token）。
- L565-L575：thinking 包裹：打开/关闭 `<think>`。
- L577-L589：若 `<think>` 是由搜索打开而后续进入正文，先关闭并刷新缓冲。
- L591-L600：根据 thinking 状态选择立即输出/缓冲输出，并累计 `_reasoning_text` 或 `_output_text`。

**流尾与收尾**
- L602-L614：
  - 关闭残留 `<think>`。
  - 刷新 `_pending_output`。
  - 输出 `finish_reason=stop` 与 `data: [DONE]`。
- L615-L619：异常记录 + finally 释放下载服务。

**Usage 计算**
- L621-L623：`build_usage()` 使用 `_output_text + _reasoning_text` 估算 token 用量。

---

### 3) 非流式对话：`CollectProcessor.process()`

**总体入口与状态**
- L747：`async def process()` 入口。
- L753-L760：初始化 `response_id/fingerprint/search_text/response_text` 及状态位。

**接收并解析上游 NDJSON**
- L763-L770：逐行读取与 JSON 解析。
- L772-L773：提取 `llmInfo.modelHash`。

**token 分支与搜索处理**
- L774-L777：读取 token、thinking、messageTag、rollout/tool_usage_card_id。
- L780-L791：`tool_usage_card`：解析搜索查询，去重入队。
- L797-L820：`raw_function_result`：输出搜索结果列表。
- L822-L846：无 `messageTag` 但有 `webSearchResults`：输出搜索结果列表。
- L848-L849：过滤 `filter_tags`。
- L851-L874：thinking 包裹与 `<think>` 开关控制。
- L876-L879：正文拼接（带搜索时会先关闭搜索 `<think>`）。

**modelResponse 汇总（搜索步骤 + 正文 + 图片）**
- L881-L947：解析 `modelResponse.steps` 搜索信息并输出（同流式逻辑）。
- L948-L972：`responseId`、`message` 回填（若尚未见 token）。
- L974-L999：`generatedImageUrls` 转 Markdown 图片（base64/URL）。
- L1000-L1011：元数据 `modelHash` 更新与 finally 释放资源。

**最终收尾与输出对象**
- L1002-L1009：补齐 `<think>` 关闭标签。
- L1010-L1024：拼接 `content`、计算 usage，返回 OpenAI 完整响应对象。

---

### 4) 视频流式：`VideoStreamProcessor.process()`

- L1051-L1066：逐行解析上游，读取 `responseId`，首次发送 role。
- L1072-L1099：处理 `streamingVideoGenerationResponse`：
  - 输出进度到 `<think>`。
  - 当进度 100% 时：`process_url()` 缓存视频/缩略图并输出 HTML。
- L1102-L1108：收尾关闭 `<think>` 与释放资源。

### 5) 视频非流式：`VideoCollectProcessor.process()`

- L1129-L1157：解析 `streamingVideoGenerationResponse`，进度 100% 时生成 HTML 内容。
- L1161-L1173：返回 OpenAI 完整响应对象（含 `content`）。

### 6) 图片流式：`ImageStreamProcessor.process()`

- L1205-L1228：处理 `streamingImageGenerationResponse`：输出 `image_generation.partial_image` 事件。
- L1238-L1261：在 `modelResponse.generatedImageUrls` 中收集最终图片（URL 或 base64）。
- L1263-L1274：输出 `image_generation.completed` 事件（含 usage 占位）。
- L1277-L1281：异常记录 + 释放资源。

### 7) 图片非流式：`ImageCollectProcessor.process()`

- L1295-L1322：从 `modelResponse.generatedImageUrls` 收集图片（URL/base64）。
- L1324-L1332：异常处理与资源释放。
- L1334-L1339：返回图片列表。

---

## 二、TypeScript：src/grok/processor.ts

### 1) 辅助与格式化工具

- L6-L19：`sleep()` 与 `readWithTimeout()` 用于读取上游流并支持超时。
- L21-L41：`makeChunk()` 生成 OpenAI SSE chunk。
- L44-L45：`makeDone()` 生成 `[DONE]` 结尾。
- L48-L51：`toImgProxyUrl()` 统一资产代理路径。
- L53-L75：视频 HTML 构建（含海报预览）。
- L77-L115：`encodeAssetPath()` + `normalizeGeneratedAssetUrls()` 处理资产 URL。
- L123-L185：搜索相关的规范化与 Markdown 输出。
- L183-L206：`parseToolUsageCardToken()` 解析工具卡（tool name / args / cardId）。
- L208-L231：`isWebSearchTool()` 与 `extractToolUsageCardsFromText()`。

---

### 2) 流式：`createOpenAiStreamFromGrokNdjson()`

**初始化与 ReadableStream 构建**
- L241-L267：读取配置、设置默认模型、编码器、超时阈值等。
- L285-L334：`ReadableStream.start()` 内初始化 reader 与状态机、搜索缓存与缓冲区。
- L356-L373：`closeSearchThink()` 与 `flushStop()` 等关闭与收尾工具。

**主循环：读取上游 NDJSON**
- L375-L414：超时控制（首包/块/总时长）+ `readWithTimeout()`。
- L431-L476：JSON 解析失败跳过，检测上游 error 并立刻输出错误/结束。

**视频生成流**
- L489-L537：`streamingVideoGenerationResponse`：
  - 进度更新（可写入 `<think>`）。
  - 生成视频/缩略图代理 URL，输出 HTML。随后 `continue`。

**模型级搜索摘要**
- L489-L627（内）：当 `modelResponse` 首次出现且尚未输出搜索结果：
  - L520-L542：解析 `tool_usage_card` 查询入队。
  - L543-L570：输出 `webSearchResults`（去重 + 列表）。
  - L572-L597：输出 `toolUsageResults.webSearchResults`。
  - L598-L626：处理 `raw_function_result` 标签的结果。

**图片生成响应**
- L630-L654：当 `imageAttachmentInfo` 出现，优先从 `modelResponse.generatedImageUrls` 输出图片；否则原样输出 token。

**文本 token 与搜索/think 交互**
- L655-L662：处理空 token / thinking 状态切换。
- L664-L706：`tool_usage_card`：抽取查询并入队。
- L708-L759：`raw_function_result` 与直接 `webSearchResults`：输出搜索结果。
- L760-L824：过滤 tags + `<think>` 开关 + 正文输出（支持搜索缓冲）。

**流尾与 usage**
- L833-L911：
  - 若搜索打开 `<think>`，先关闭后 flush。
  - 输出 usage chunk（含 prompt/completion 统计）。
  - 输出 stop 与 `[DONE]`。
  - `onFinish()` 回调。

---

### 3) 非流式：`parseOpenAiFromGrokNdjson()`

**读取上游响应并初始化**
- L879-L940：读取全文、按行切分并初始化状态与搜索缓存。

**逐行解析与视频优先处理**
- L981-L1009：若存在 `streamingVideoGenerationResponse.videoUrl`，立即生成视频 HTML 并终止循环。

**token 分支与搜索**
- L1011-L1120：
  - 更新模型名与 thinking 状态。
  - `tool_usage_card` 入队查询。
  - `raw_function_result` 与 `webSearchResults` 输出结果。
  - `<think>` 开关与正文拼接。

**modelResponse 汇总**
- L1124-L1221：解析 `modelResponse.steps` 的搜索结果（去重 + 列表输出）。
- L1235-L1264：
  - 处理 `generatedImageUrls` 并输出图片。
  - `modelResponse.message` 回填（当未见 token）。
  - 占位 `generatedImageUrls` 时继续扫描，否则结束。

**收尾与 usage**
- L1266-L1318：关闭 `<think>`、计算 usage，返回完整 OpenAI 响应对象。

---

## 结论（统一链路概览）

1. **接收上游响应**：Python 与 TS 都按行解析 NDJSON（`async for line` / `ReadableStream.read()`）。
2. **解析元信息**：提取 `responseId`、模型名、`llmInfo.modelHash`。
3. **分支处理**：
   - 图像/视频进度：在 `streamingImageGenerationResponse` 或 `streamingVideoGenerationResponse` 处输出进度与最终媒体 HTML。
   - 搜索：`tool_usage_card` 入队查询，`webSearchResults` 统一输出 Markdown 列表。
   - 文本：根据 `isThinking` 控制 `<think>` 包裹与正文输出/缓冲。
4. **输出响应**：
   - Python 流式：`_sse()` 输出 chunk + `[DONE]`。
   - TS 流式：`makeChunk()` 输出 chunk + usage + `[DONE]`。
   - 非流式：聚合 `content` 后构造 OpenAI 兼容响应对象。
