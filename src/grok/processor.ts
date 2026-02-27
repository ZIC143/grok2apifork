import type { GrokSettings, GlobalSettings } from "../settings";
import { buildChatUsageFromTexts, estimateInputTokensFromMessages, estimateTokens } from "../utils/token_usage";

type GrokNdjson = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | { timeout: true }> {
  if (ms <= 0) return { timeout: true };
  return Promise.race([
    reader.read(),
    sleep(ms).then(() => ({ timeout: true }) as const),
  ]);
}

function makeChunk(
  id: string,
  created: number,
  model: string,
  content: string,
  finish_reason?: "stop" | "error" | null,
): string {
  const payload: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: content ? { role: "assistant", content } : {},
        finish_reason: finish_reason ?? null,
      },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function makeDone(): string {
  return "data: [DONE]\n\n";
}

function toImgProxyUrl(globalCfg: GlobalSettings, origin: string, path: string): string {
  const baseUrl = (globalCfg.base_url ?? "").trim() || origin;
  return `${baseUrl}/images/${path}`;
}

function buildVideoTag(src: string): string {
  return `<video src="${src}" controls="controls" width="500" height="300"></video>\n`;
}

function buildVideoPosterPreview(videoUrl: string, posterUrl?: string): string {
  const href = String(videoUrl || "").replace(/"/g, "&quot;");
  const poster = String(posterUrl || "").replace(/"/g, "&quot;");
  if (!href) return "";
  if (!poster) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>\n`;
  return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;position:relative;max-width:100%;text-decoration:none;">
  <img src="${poster}" alt="video" style="max-width:100%;height:auto;border-radius:12px;display:block;" />
  <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
    <span style="width:64px;height:64px;border-radius:9999px;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;">
      <span style="width:0;height:0;border-top:12px solid transparent;border-bottom:12px solid transparent;border-left:18px solid #fff;margin-left:4px;"></span>
    </span>
  </span>
</a>\n`;
}

function buildVideoHtml(args: { videoUrl: string; posterUrl?: string; posterPreview: boolean }): string {
  if (args.posterPreview) return buildVideoPosterPreview(args.videoUrl, args.posterUrl);
  return buildVideoTag(args.videoUrl);
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAssetPath(raw: string): string {
  try {
    const u = new URL(raw);
    // Keep full URL (query etc.) to avoid lossy pathname-only encoding (some URLs may encode the real path in query).
    return `u_${base64UrlEncode(u.toString())}`;
  } catch {
    const p = raw.startsWith("/") ? raw : `/${raw}`;
    return `p_${base64UrlEncode(p)}`;
  }
}

function normalizeGeneratedAssetUrls(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    if (s === "/") continue;

    try {
      const u = new URL(s);
      if (u.pathname === "/" && !u.search && !u.hash) continue;
    } catch {
      // ignore (path-style strings are allowed)
    }

    out.push(s);
  }

  return out;
}

const SEARCH_RESULT_LIMIT = 0;
const SEARCH_PREVIEW_LIMIT = 200;

type SearchResult = { title: string; url: string; preview: string };

function normalizeSearchText(raw: unknown, limit: number): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (limit > 0 && text.length > limit) return `${text.slice(0, limit)}...`;
  return text;
}

function escapeMarkdownText(raw: string): string {
  return raw.replace(/([\\\[\]\(\)])/g, "\\$1");
}

function normalizeSearchUrl(raw: unknown): string {
  const url = String(raw ?? "").trim();
  if (!url) return "";
  if (!(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/"))) return "";
  return url.replace(/\s/g, "%20").replace(/\)/g, "%29");
}

function buildMarkdownLink(result: SearchResult): string {
  const titleText = normalizeSearchText(result.title || result.url, 200);
  const title = escapeMarkdownText(titleText || "link");
  const url = normalizeSearchUrl(result.url);
  const previewRaw = normalizeSearchText(result.preview, SEARCH_PREVIEW_LIMIT);
  const preview = previewRaw ? escapeMarkdownText(previewRaw.replace(/"/g, "'")) : "";
  if (url) {
    const suffix = preview ? ` \"${preview}\"` : "";
    return `[${title}](${url}${suffix})`;
  }
  return title ? `${title}` : "";
}

function extractSearchResults(raw: unknown): SearchResult[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object" && Array.isArray((raw as any).results)) list = (raw as any).results;
  if (!list.length) return [];

  const out: SearchResult[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const title = typeof (item as any).title === "string" ? (item as any).title : "";
    const url = typeof (item as any).url === "string" ? (item as any).url : "";
    const preview = typeof (item as any).preview === "string" ? (item as any).preview : "";
    if (!title && !url && !preview) continue;
    out.push({ title, url, preview });
  }
  return out;
}

function formatSearchResults(results: SearchResult[], limit = SEARCH_RESULT_LIMIT): string {
  if (!results.length) return "";
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), results.length) : results.length;
  const lines: string[] = [];
  for (const result of results.slice(0, cap)) {
    const line = buildMarkdownLink(result);
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

function parseToolUsageCardToken(raw: string): { toolName: string; args: Record<string, unknown> } | null {
  const token = String(raw || "");
  if (!token) return null;
  const toolMatch = token.match(/<xai:tool_name>([^<]+)<\/xai:tool_name>/i);
  const toolName = toolMatch?.[1] ?? "";
  const argsMatch = token.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  let args: Record<string, unknown> = {};
  if (argsMatch?.[1]) {
    try {
      const parsed = JSON.parse(argsMatch[1]);
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      // ignore parsing failures
    }
  }
  if (!toolName && !Object.keys(args).length) return null;
  return { toolName, args };
}

function isWebSearchTool(name: string): boolean {
  const tool = String(name || "").toLowerCase();
  return tool.startsWith("web_search");
}

function extractToolUsageCardsFromText(raw: unknown): Array<{ toolName: string; args: Record<string, unknown> }> {
  const text = String(raw ?? "");
  if (!text) return [];
  const matches = text.match(/<xai:tool_usage_card>[\s\S]*?<\/xai:tool_usage_card>/gi);
  if (matches && matches.length) {
    const parsed = matches.map((m) => parseToolUsageCardToken(m)).filter(Boolean) as Array<{
      toolName: string;
      args: Record<string, unknown>;
    }>;
    return parsed;
  }
  const single = parseToolUsageCardToken(text);
  return single ? [single] : [];
}

export function createOpenAiStreamFromGrokNdjson(
  grokResp: Response,
  opts: {
    cookie: string;
    settings: GrokSettings;
    global: GlobalSettings;
    origin: string;
    promptMessages?: Array<{ content?: unknown }>;
    requestedModel: string;
    onFinish?: (result: {
      status: number;
      duration: number;
      usage?: ReturnType<typeof buildChatUsageFromTexts>;
    }) => Promise<void> | void;
  },
): ReadableStream<Uint8Array> {
  const { settings, global, origin } = opts;
  const fallbackModel =
    typeof opts.requestedModel === "string" && opts.requestedModel.trim()
      ? opts.requestedModel.trim()
      : "grok-4";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const filteredTags = (settings.filtered_tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const showThinking = settings.show_thinking !== false;
  const showSearch = settings.show_search !== false;

  const firstTimeoutMs = Math.max(0, (settings.stream_first_response_timeout ?? 30) * 1000);
  const chunkTimeoutMs = Math.max(0, (settings.stream_chunk_timeout ?? 120) * 1000);
  const totalTimeoutMs = Math.max(0, (settings.stream_total_timeout ?? 600) * 1000);

  const promptEst = estimateInputTokensFromMessages(opts.promptMessages ?? []);
  let completionText = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const body = grokResp.body;
      if (!body) {
        controller.enqueue(encoder.encode(makeChunk(id, created, fallbackModel, "Empty response", "error")));
        controller.enqueue(encoder.encode(makeDone()));
        controller.close();
        return;
      }

      const reader = body.getReader();
      const startTime = Date.now();
      let finalStatus = 200;
      let lastChunkTime = startTime;
      let firstReceived = false;

      let currentModel = fallbackModel;
      let isImage = false;
      let isThinking = false;
      let thinkingFinished = false;
      let thinkOpened = false;
      let videoProgressStarted = false;
      let lastVideoProgress = -1;
      const seenSearchQueries = new Set<string>();
      const seenSearchResults = new Set<string>();
      const pendingSearchQueries = new Map<string, Array<{ prefix: string; query: string }>>();

      const pendingContent: string[] = [];

      let lastSearchPrefix = "";
      let lastSearchWasQuery = false;

      const resetSearchPrefix = () => {
        lastSearchPrefix = "";
        lastSearchWasQuery = false;
      };

      const buildSearchHeader = (prefixLabel: string, isQuery: boolean) => {
        if (!prefixLabel) {
          lastSearchPrefix = "";
          lastSearchWasQuery = isQuery;
          return "";
        }
        if (isQuery) {
          lastSearchPrefix = prefixLabel;
          lastSearchWasQuery = true;
          return `${prefixLabel}\n`;
        }
        const header = !lastSearchWasQuery || lastSearchPrefix !== prefixLabel ? `${prefixLabel}\n` : "";
        lastSearchPrefix = prefixLabel;
        lastSearchWasQuery = false;
        return header;
      };

      const queueSearchQuery = (key: string, prefixLabel: string, query: string) => {
        if (!key || !query) return;
        const bucket = pendingSearchQueries.get(key) ?? [];
        bucket.push({ prefix: prefixLabel, query });
        pendingSearchQueries.set(key, bucket);
      };

      const popSearchQuery = (key: string) => {
        const bucket = pendingSearchQueries.get(key);
        if (!bucket || !bucket.length) return undefined;
        const item = bucket.shift();
        if (!bucket.length) pendingSearchQueries.delete(key);
        return item;
      };

      const flushPendingContent = () => {
        if (!pendingContent.length) return;
        const chunk = pendingContent.join("");
        pendingContent.length = 0;
        completionText += chunk;
        controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, chunk)));
      };

      const queueContent = (text: string) => {
        if (!text) return;
        resetSearchPrefix();
        if (showSearch) {
          pendingContent.push(text);
          return;
        }
        completionText += text;
        controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, text)));
      };

      let buffer = "";

      const flushStop = () => {
        flushPendingContent();
        controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, "", "stop")));
        controller.enqueue(encoder.encode(makeDone()));
      };

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const now = Date.now();
          const elapsed = now - startTime;
          if (!firstReceived && elapsed > firstTimeoutMs) {
            flushStop();
            if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
            controller.close();
            return;
          }
          if (totalTimeoutMs > 0 && elapsed > totalTimeoutMs) {
            flushStop();
            if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
            controller.close();
            return;
          }
          const idle = now - lastChunkTime;
          if (firstReceived && idle > chunkTimeoutMs) {
            flushStop();
            if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
            controller.close();
            return;
          }

          const perReadTimeout = Math.min(
            firstReceived ? chunkTimeoutMs : firstTimeoutMs,
            totalTimeoutMs > 0 ? Math.max(0, totalTimeoutMs - elapsed) : Number.POSITIVE_INFINITY,
          );

          const res = await readWithTimeout(reader, perReadTimeout);
          if ("timeout" in res) {
            flushStop();
            if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
            controller.close();
            return;
          }

          const { value, done } = res;
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;

            let data: GrokNdjson;
            try {
              data = JSON.parse(line) as GrokNdjson;
            } catch {
              continue;
            }

            firstReceived = true;
            lastChunkTime = Date.now();

            const err = (data as any).error;
            if (err?.message) {
              finalStatus = 500;
              flushPendingContent();
              controller.enqueue(
                encoder.encode(makeChunk(id, created, currentModel, `Error: ${String(err.message)}`, "stop")),
              );
              controller.enqueue(encoder.encode(makeDone()));
              if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
              controller.close();
              return;
            }

            const grok = (data as any).result?.response;
            if (!grok) continue;

            const userRespModel = grok.userResponse?.model;
            if (typeof userRespModel === "string" && userRespModel.trim()) currentModel = userRespModel.trim();

            // Video generation stream
            const videoResp = grok.streamingVideoGenerationResponse;
            if (videoResp) {
              const progress = typeof videoResp.progress === "number" ? videoResp.progress : 0;
              const videoUrl = typeof videoResp.videoUrl === "string" ? videoResp.videoUrl : "";
              const thumbUrl = typeof videoResp.thumbnailImageUrl === "string" ? videoResp.thumbnailImageUrl : "";

              if (progress > lastVideoProgress) {
                lastVideoProgress = progress;
                if (showThinking) {
                  let msg = "";
                  if (!videoProgressStarted) {
                    msg = `<think>视频已生成${progress}%\n`;
                    videoProgressStarted = true;
                  } else if (progress < 100) {
                    msg = `视频已生成${progress}%\n`;
                  } else {
                    msg = `视频已生成${progress}%</think>\n`;
                  }
                  controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, msg)));
                }
              }

              if (videoUrl) {
                const videoPath = encodeAssetPath(videoUrl);
                const src = toImgProxyUrl(global, origin, videoPath);

                let poster: string | undefined;
                if (thumbUrl) {
                  const thumbPath = encodeAssetPath(thumbUrl);
                  poster = toImgProxyUrl(global, origin, thumbPath);
                }

                controller.enqueue(
                  encoder.encode(
                    makeChunk(
                      id,
                      created,
                      currentModel,
                      buildVideoHtml({
                        videoUrl: src,
                        posterPreview: settings.video_poster_preview === true,
                        ...(poster ? { posterUrl: poster } : {}),
                      }),
                    ),
                  ),
                );
              }
              continue;
            }

            if (grok.imageAttachmentInfo) isImage = true;
            const rawToken = grok.token;
            const currentIsThinking = Boolean(grok.isThinking);
            const wasThinking = isThinking;
            const messageTag = grok.messageTag;
            const rolloutId = typeof grok.rolloutId === "string" ? grok.rolloutId : "";
            const toolUsageCardId = typeof grok.toolUsageCardId === "string" ? grok.toolUsageCardId : "";

            if (showSearch && grok.modelResponse) {
              const modelResp = grok.modelResponse;
              if (Array.isArray(modelResp.steps)) {
                for (const step of modelResp.steps) {
                  if (!step || typeof step !== "object") continue;
                  const stepTags = Array.isArray((step as any).tags) ? (step as any).tags : [];
                  const stepRolloutId = typeof (step as any).rolloutId === "string" ? (step as any).rolloutId : rolloutId;
                  const stepToolUsageId =
                    typeof (step as any).toolUsageCardId === "string" ? (step as any).toolUsageCardId : toolUsageCardId;
                  const prefix = stepRolloutId ? `[${stepRolloutId}] ` : "";

                  const toolTextParts = Array.isArray((step as any).text) ? (step as any).text : [];
                  for (const rawText of toolTextParts) {
                    const cards = extractToolUsageCardsFromText(rawText);
                    for (const card of cards) {
                      if (!isWebSearchTool(card.toolName)) continue;
                      const query = normalizeSearchText((card.args as any)?.query, 200);
                      if (!query) continue;
                      const dedupeKey = `${stepRolloutId || stepToolUsageId}|${query}`;
                      if (seenSearchQueries.has(dedupeKey)) continue;
                      seenSearchQueries.add(dedupeKey);
                      queueSearchQuery(dedupeKey, prefix, query);
                    }
                  }

                  if (Array.isArray((step as any).webSearchResults) || (step as any).webSearchResults?.results) {
                    const results = extractSearchResults((step as any).webSearchResults);
                    if (results.length) {
                      const resultsKey = `${stepRolloutId || stepToolUsageId}|${results.length}`;
                      if (!seenSearchResults.has(resultsKey)) {
                        seenSearchResults.add(resultsKey);
                        const list = formatSearchResults(results);
                        const pending = popSearchQuery(resultsKey);
                        const headerPrefix = pending?.prefix ?? prefix;
                        const queryText = pending?.query ?? "";
                        let msg = "";
                        if (queryText) msg += `${buildSearchHeader(headerPrefix, true)}🔍 搜索: ${queryText}\n`;
                        msg += `${buildSearchHeader(headerPrefix, false)}📄 找到 ${results.length} 条结果\n`;
                        if (list) msg += `${list}\n`;
                        if (showThinking) {
                          if (!thinkOpened) {
                            msg = `<think>\n${msg}`;
                            thinkOpened = true;
                          }
                        }
                        completionText += msg;
                        controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, msg)));
                      }
                    }
                  }

                  const usageResults = Array.isArray((step as any).toolUsageResults) ? (step as any).toolUsageResults : [];
                  for (const usage of usageResults) {
                    if (!usage || typeof usage !== "object") continue;
                    if (!(usage as any).webSearchResults) continue;
                    const results = extractSearchResults((usage as any).webSearchResults);
                    if (!results.length) continue;
                    const resultsKey = `${stepRolloutId || stepToolUsageId}|${results.length}`;
                    if (seenSearchResults.has(resultsKey)) continue;
                    seenSearchResults.add(resultsKey);
                    const list = formatSearchResults(results);
                    const pending = popSearchQuery(resultsKey);
                    const headerPrefix = pending?.prefix ?? prefix;
                    const queryText = pending?.query ?? "";
                    let msg = "";
                    if (queryText) msg += `${buildSearchHeader(headerPrefix, true)}🔍 搜索: ${queryText}\n`;
                    msg += `${buildSearchHeader(headerPrefix, false)}📄 找到 ${results.length} 条结果\n`;
                    if (list) msg += `${list}\n`;
                    if (showThinking) {
                      if (!thinkOpened) {
                        msg = `<think>\n${msg}`;
                        thinkOpened = true;
                      }
                    }
                    completionText += msg;
                    controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, msg)));
                  }

                  if (stepTags.includes("raw_function_result") && (step as any).webSearchResults) {
                    const results = extractSearchResults((step as any).webSearchResults);
                    if (results.length) {
                      const resultsKey = `${stepRolloutId || stepToolUsageId}|${results.length}`;
                      if (!seenSearchResults.has(resultsKey)) {
                        seenSearchResults.add(resultsKey);
                        const list = formatSearchResults(results);
                        const pending = popSearchQuery(resultsKey);
                        const headerPrefix = pending?.prefix ?? prefix;
                        const queryText = pending?.query ?? "";
                        let msg = "";
                        if (queryText) msg += `${buildSearchHeader(headerPrefix, true)}🔍 搜索: ${queryText}\n`;
                        msg += `${buildSearchHeader(headerPrefix, false)}📄 找到 ${results.length} 条结果\n`;
                        if (list) msg += `${list}\n`;
                        if (showThinking) {
                          if (!thinkOpened) {
                            msg = `<think>\n${msg}`;
                            thinkOpened = true;
                          }
                        }
                        completionText += msg;
                        controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, msg)));
                      }
                    }
                  }
                }
              }

              // Skip aggregated model-level webSearchResults/toolUsageResults to avoid duplicate summaries.
            }

            if (isImage) {
              const modelResp = grok.modelResponse;
              if (modelResp) {
                const urls = normalizeGeneratedAssetUrls(modelResp.generatedImageUrls);
                if (urls.length) {
                  const linesOut: string[] = [];
                  for (const u of urls) {
                    const imgPath = encodeAssetPath(u);
                    const imgUrl = toImgProxyUrl(global, origin, imgPath);
                    linesOut.push(`![Generated Image](${imgUrl})`);
                  }
                  controller.enqueue(
                    encoder.encode(makeChunk(id, created, currentModel, linesOut.join("\n"), "stop")),
                  );
                  controller.enqueue(encoder.encode(makeDone()));
                  if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
                  controller.close();
                  return;
                }
              } else if (typeof rawToken === "string" && rawToken) {
                controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, rawToken)));
              }
              continue;
            }

            // Text chat stream
            if (Array.isArray(rawToken)) {
              if (wasThinking && !currentIsThinking) thinkingFinished = true;
              isThinking = currentIsThinking;
              continue;
            }
            if (typeof rawToken !== "string" || !rawToken) {
              if (wasThinking && !currentIsThinking) thinkingFinished = true;
              isThinking = currentIsThinking;
              continue;
            }
            let token = rawToken;

            if (thinkingFinished && currentIsThinking) {
              isThinking = currentIsThinking;
              continue;
            }


            if (showSearch && messageTag === "tool_usage_card") {
              const parsed = parseToolUsageCardToken(token);
              if (parsed && isWebSearchTool(parsed.toolName)) {
                const queryRaw = (parsed.args as any)?.query;
                const query = normalizeSearchText(queryRaw, 200);
                if (query) {
                  const dedupeKey = `${rolloutId || toolUsageCardId}|${query}`;
                  if (!seenSearchQueries.has(dedupeKey)) {
                    seenSearchQueries.add(dedupeKey);
                    let prefix = "";
                    if (rolloutId) prefix = `[${rolloutId}] `;
                    queueSearchQuery(dedupeKey, prefix, query);
                  }
                }
              }
              if (wasThinking && !currentIsThinking) thinkingFinished = true;
              isThinking = currentIsThinking;
              continue;
            }

            if (showSearch && messageTag === "raw_function_result") {
              const results = extractSearchResults(grok.webSearchResults);
              if (results.length) {
                const resultsKey = `${rolloutId || toolUsageCardId}|${results.length}`;
                if (!seenSearchResults.has(resultsKey)) {
                  seenSearchResults.add(resultsKey);
                  let prefix = "";
                  if (rolloutId) prefix = `[${rolloutId}] `;
                  const list = formatSearchResults(results);
                  const pending = popSearchQuery(resultsKey);
                  const headerPrefix = pending?.prefix ?? prefix;
                  const queryText = pending?.query ?? "";
                  let msg = "";
                  if (queryText) msg += `${buildSearchHeader(headerPrefix, true)}🔍 搜索: ${queryText}\n`;
                  msg += `${buildSearchHeader(headerPrefix, false)}📄 找到 ${results.length} 条结果\n`;
                  if (list) msg += `${list}\n`;
                  if (showThinking) {
                    if (!thinkOpened) {
                      msg = `<think>\n${msg}`;
                      thinkOpened = true;
                    }
                  }
                  completionText += msg;
                  controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, msg)));
                }
              }
              if (wasThinking && !currentIsThinking) thinkingFinished = true;
              isThinking = currentIsThinking;
              continue;
            }

            if (showSearch && grok.webSearchResults?.results && Array.isArray(grok.webSearchResults.results)) {
              const results = extractSearchResults(grok.webSearchResults);
              if (results.length) {
                const resultsKey = `${rolloutId || toolUsageCardId}|${results.length}`;
                if (!seenSearchResults.has(resultsKey)) {
                  seenSearchResults.add(resultsKey);
                  let prefix = "";
                  if (rolloutId) prefix = `[${rolloutId}] `;
                  const list = formatSearchResults(results);
                  const pending = popSearchQuery(resultsKey);
                  const headerPrefix = pending?.prefix ?? prefix;
                  const queryText = pending?.query ?? "";
                  let msg = "";
                  if (queryText) msg += `${buildSearchHeader(headerPrefix, true)}🔍 搜索: ${queryText}\n`;
                  msg += `${buildSearchHeader(headerPrefix, false)}📄 找到 ${results.length} 条结果\n`;
                  if (list) msg += `${list}\n`;
                  if (showThinking) {
                    if (!thinkOpened) {
                      msg = `<think>\n${msg}`;
                      thinkOpened = true;
                    }
                  }
                  completionText += msg;
                  controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, msg)));
                }
              }
              if (wasThinking && !currentIsThinking) thinkingFinished = true;
              isThinking = currentIsThinking;
              continue;
            }

            if (filteredTags.some((t) => token.includes(t))) continue;

            let content = token;
            if (messageTag === "header") content = `\n\n${token}\n\n`;

            let shouldSkip = false;
            if (currentIsThinking) {
              if (!showThinking) {
                shouldSkip = true;
              } else if (!thinkOpened) {
                content = `<think>\n${content}`;
                thinkOpened = true;
              }
            } else if (thinkOpened && showThinking) {
              content = `\n</think>\n${content}`;
              thinkOpened = false;
              if (isThinking) thinkingFinished = true;
            }

            if (showSearch && thinkOpened && !currentIsThinking) {
              content = `\n</think>\n${content}`;
              thinkOpened = false;
            }

            if (!shouldSkip) {
              queueContent(content);
            }
            isThinking = currentIsThinking;
          }
        }

        flushPendingContent();
        if (showThinking && thinkOpened) {
          const closeChunk = "\n</think>\n";
          completionText += closeChunk;
          controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, closeChunk)));
          thinkOpened = false;
        }

        const usage = buildChatUsageFromTexts({
          promptTextTokens: promptEst.textTokens,
          promptImageTokens: promptEst.imageTokens,
          completionText,
        });
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: currentModel,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: usage.input_tokens,
                completion_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
                prompt_tokens_details: {
                  cached_tokens: usage.cached_tokens,
                  text_tokens: usage.input_tokens_details.text_tokens,
                  audio_tokens: 0,
                  image_tokens: usage.input_tokens_details.image_tokens,
                },
                completion_tokens_details: {
                  text_tokens: usage.output_tokens_details.text_tokens,
                  audio_tokens: 0,
                  reasoning_tokens: usage.reasoning_tokens,
                },
              },
            })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, "", "stop")));
        controller.enqueue(encoder.encode(makeDone()));
        if (opts.onFinish) {
          await opts.onFinish({
            status: finalStatus,
            duration: (Date.now() - startTime) / 1000,
            usage,
          });
        }
        controller.close();
      } catch (e) {
        finalStatus = 500;
        flushPendingContent();
        controller.enqueue(
          encoder.encode(
            makeChunk(id, created, currentModel, `处理错误: ${e instanceof Error ? e.message : String(e)}`, "error"),
          ),
        );
        controller.enqueue(encoder.encode(makeDone()));
        if (opts.onFinish) {
          await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
        }
        controller.close();
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    },
  });
}

export async function parseOpenAiFromGrokNdjson(
  grokResp: Response,
  opts: {
    cookie: string;
    settings: GrokSettings;
    global: GlobalSettings;
    origin: string;
    requestedModel: string;
    promptMessages?: Array<{ content?: unknown }>;
  },
): Promise<Record<string, unknown>> {
  const { global, origin, requestedModel, settings } = opts;
  const text = await grokResp.text();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let searchText = "";
  let responseText = "";
  let model = requestedModel;
  const filteredTags = (settings.filtered_tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const showThinking = settings.show_thinking !== false;
  const showSearch = settings.show_search !== false;
  let sawResponseToken = false;
  let isThinking = false;
  let thinkOpened = false;
  let thinkingFinished = false;
  const seenSearchQueries = new Set<string>();
  const seenSearchResults = new Set<string>();

  const appendSearchText = (textPart: string) => {
    if (!textPart) return;
    searchText += textPart;
  };

  const appendResponseText = (textPart: string) => {
    if (!textPart) return;
    responseText += textPart;
  };

  let lastSearchPrefix = "";
  let lastSearchWasQuery = false;
  const resetSearchPrefix = () => {
    lastSearchPrefix = "";
    lastSearchWasQuery = false;
  };
  const buildSearchHeader = (prefixLabel: string, isQuery: boolean) => {
    if (!prefixLabel) {
      lastSearchPrefix = "";
      lastSearchWasQuery = isQuery;
      return "";
    }
    if (isQuery) {
      lastSearchPrefix = prefixLabel;
      lastSearchWasQuery = true;
      return `${prefixLabel}\n`;
    }
    const header = !lastSearchWasQuery || lastSearchPrefix !== prefixLabel ? `${prefixLabel}\n` : "";
    lastSearchPrefix = prefixLabel;
    lastSearchWasQuery = false;
    return header;
  };

  const pendingSearchQueries = new Map<string, Array<{ prefix: string; query: string }>>();
  const queueSearchQuery = (key: string, prefixLabel: string, query: string) => {
    if (!key || !query) return;
    const bucket = pendingSearchQueries.get(key) ?? [];
    bucket.push({ prefix: prefixLabel, query });
    pendingSearchQueries.set(key, bucket);
  };
  const popSearchQuery = (key: string) => {
    const bucket = pendingSearchQueries.get(key);
    if (!bucket || !bucket.length) return undefined;
    const item = bucket.shift();
    if (!bucket.length) pendingSearchQueries.delete(key);
    return item;
  };

  for (const line of lines) {
    let data: GrokNdjson;
    try {
      data = JSON.parse(line) as GrokNdjson;
    } catch {
      continue;
    }

    const err = (data as any).error;
    if (err?.message) throw new Error(String(err.message));

    const result = (data as any).result;
    const grok = result?.response;
    if (!grok) continue;

    const videoResp = grok.streamingVideoGenerationResponse;
    if (videoResp?.videoUrl && typeof videoResp.videoUrl === "string") {
      const videoPath = encodeAssetPath(videoResp.videoUrl);
      const src = toImgProxyUrl(global, origin, videoPath);

      let poster: string | undefined;
      if (typeof videoResp.thumbnailImageUrl === "string" && videoResp.thumbnailImageUrl) {
        const thumbPath = encodeAssetPath(videoResp.thumbnailImageUrl);
        poster = toImgProxyUrl(global, origin, thumbPath);
      }

      responseText = buildVideoHtml({
        videoUrl: src,
        posterPreview: settings.video_poster_preview === true,
        ...(poster ? { posterUrl: poster } : {}),
      });
      model = requestedModel;
      break;
    }

    const userRespModel = grok.userResponse?.model;
    if (typeof userRespModel === "string" && userRespModel.trim()) model = userRespModel.trim();

    const rawToken = grok.token ?? result?.token;
    const currentIsThinking = Boolean(grok.isThinking ?? result?.isThinking);
    const wasThinking = isThinking;
    const messageTag = grok.messageTag ?? result?.messageTag;
    const rolloutId = typeof grok.rolloutId === "string" ? grok.rolloutId : (typeof result?.rolloutId === "string" ? result.rolloutId : "");
    const toolUsageCardId = typeof grok.toolUsageCardId === "string" ? grok.toolUsageCardId : (typeof result?.toolUsageCardId === "string" ? result.toolUsageCardId : "");

    if (typeof rawToken === "string" && rawToken) {
      let token = rawToken;

      if (thinkingFinished && currentIsThinking) {
        isThinking = currentIsThinking;
      } else if (showSearch && messageTag === "tool_usage_card") {
        const parsed = parseToolUsageCardToken(token);
        if (parsed && isWebSearchTool(parsed.toolName)) {
          const queryRaw = (parsed.args as any)?.query;
          const query = normalizeSearchText(queryRaw, 200);
          if (query) {
            const dedupeKey = `${rolloutId || toolUsageCardId}|${query}`;
            if (!seenSearchQueries.has(dedupeKey)) {
              seenSearchQueries.add(dedupeKey);
              let prefix = "";
              if (rolloutId) prefix = `[${rolloutId}] `;
              queueSearchQuery(dedupeKey, prefix, query);
            }
          }
        }
        if (wasThinking && !currentIsThinking) thinkingFinished = true;
        isThinking = currentIsThinking;
      } else if (showSearch && messageTag === "raw_function_result") {
        const results = extractSearchResults(grok.webSearchResults);
        if (results.length) {
          const resultsKey = `${rolloutId || toolUsageCardId}|${results.length}`;
          if (!seenSearchResults.has(resultsKey)) {
            seenSearchResults.add(resultsKey);
            let prefix = "";
            if (rolloutId) prefix = `[${rolloutId}] `;
            const list = formatSearchResults(results);
            const pending = popSearchQuery(resultsKey);
            const headerPrefix = pending?.prefix ?? prefix;
            const queryText = pending?.query ?? "";
            let msg = "";
            if (queryText) msg += `${buildSearchHeader(headerPrefix, true)}🔍 搜索: ${queryText}\n`;
            msg += `${buildSearchHeader(headerPrefix, false)}📄 找到 ${results.length} 条结果\n`;
            if (list) msg += `${list}\n`;
            if (showThinking) {
              if (!thinkOpened) {
                msg = `<think>\n${msg}`;
                thinkOpened = true;
              }
            }
            appendSearchText(msg);
          }
        }
        if (wasThinking && !currentIsThinking) thinkingFinished = true;
        isThinking = currentIsThinking;
      } else if (showSearch && grok.webSearchResults?.results && Array.isArray(grok.webSearchResults.results)) {
        const results = extractSearchResults(grok.webSearchResults);
        if (results.length) {
          const resultsKey = `${rolloutId || toolUsageCardId}|${results.length}`;
          if (!seenSearchResults.has(resultsKey)) {
            seenSearchResults.add(resultsKey);
            let prefix = "";
            if (rolloutId) prefix = `[${rolloutId}] `;
            const list = formatSearchResults(results);
            const pending = popSearchQuery(resultsKey);
            const headerPrefix = pending?.prefix ?? prefix;
            const queryText = pending?.query ?? "";
            let msg = "";
            if (queryText) msg += `${buildSearchHeader(headerPrefix, true)}🔍 搜索: ${queryText}\n`;
            msg += `${buildSearchHeader(headerPrefix, false)}📄 找到 ${results.length} 条结果\n`;
            if (list) msg += `${list}\n`;
            if (showThinking) {
              if (!thinkOpened) {
                msg = `<think>\n${msg}`;
                thinkOpened = true;
              }
            }
            appendSearchText(msg);
          }
        }
        if (wasThinking && !currentIsThinking) thinkingFinished = true;
        isThinking = currentIsThinking;
      } else if (!filteredTags.some((t) => token.includes(t))) {
            let tokenContent = token;
        if (messageTag === "header") tokenContent = `\n\n${token}\n\n`;
        let shouldSkip = false;
        if (currentIsThinking) {
          if (!showThinking) {
            shouldSkip = true;
          } else if (!thinkOpened) {
            tokenContent = `<think>\n${tokenContent}`;
            thinkOpened = true;
          }
        } else if (thinkOpened && showThinking) {
          tokenContent = `\n</think>\n${tokenContent}`;
          thinkOpened = false;
          if (wasThinking) thinkingFinished = true;
        }
            if (showSearch && thinkOpened && !currentIsThinking) {
              tokenContent = `\n</think>\n${tokenContent}`;
              thinkOpened = false;
            }
            if (!shouldSkip) {
              resetSearchPrefix();
              appendResponseText(tokenContent);
              sawResponseToken = true;
            }
        isThinking = currentIsThinking;
      }
    }

    const modelResp = grok.modelResponse ?? result?.modelResponse;
    if (!modelResp) continue;
    if (showSearch && Array.isArray(modelResp.steps)) {
      for (const step of modelResp.steps) {
        if (!step || typeof step !== "object") continue;
        const stepTags = Array.isArray((step as any).tags) ? (step as any).tags : [];
        const stepRolloutId = typeof (step as any).rolloutId === "string" ? (step as any).rolloutId : rolloutId;
        const stepToolUsageId = typeof (step as any).toolUsageCardId === "string" ? (step as any).toolUsageCardId : toolUsageCardId;
        const prefix = stepRolloutId ? `[${stepRolloutId}] ` : "";

        const toolTextParts = Array.isArray((step as any).text) ? (step as any).text : [];
        for (const rawText of toolTextParts) {
          const cards = extractToolUsageCardsFromText(rawText);
          for (const card of cards) {
            if (!isWebSearchTool(card.toolName)) continue;
            const query = normalizeSearchText((card.args as any)?.query, 200);
            if (!query) continue;
            const dedupeKey = `${stepRolloutId || stepToolUsageId}|${query}`;
            if (seenSearchQueries.has(dedupeKey)) continue;
            seenSearchQueries.add(dedupeKey);
            queueSearchQuery(dedupeKey, prefix, query);
          }
        }

        if (Array.isArray((step as any).webSearchResults) || (step as any).webSearchResults?.results) {
          const results = extractSearchResults((step as any).webSearchResults);
          if (results.length) {
            const resultsKey = `${stepRolloutId || stepToolUsageId}|${results.length}`;
            if (!seenSearchResults.has(resultsKey)) {
              seenSearchResults.add(resultsKey);
              const list = formatSearchResults(results);
              const pending = popSearchQuery(resultsKey);
              const headerPrefix = pending?.prefix ?? prefix;
              const queryText = pending?.query ?? "";
              let msg = "";
              if (queryText) msg += `${buildSearchHeader(headerPrefix, true)}🔍 搜索: ${queryText}\n`;
              msg += `${buildSearchHeader(headerPrefix, false)}📄 找到 ${results.length} 条结果\n`;
              if (list) msg += `${list}\n`;
              if (showThinking) {
                if (!thinkOpened) {
                  msg = `<think>\n${msg}`;
                  thinkOpened = true;
                }
              }
              appendSearchText(msg);
            }
          }
        }

        const usageResults = Array.isArray((step as any).toolUsageResults) ? (step as any).toolUsageResults : [];
        for (const usage of usageResults) {
          if (!usage || typeof usage !== "object") continue;
          if (!(usage as any).webSearchResults) continue;
          const results = extractSearchResults((usage as any).webSearchResults);
          if (!results.length) continue;
          const resultsKey = `${stepRolloutId || stepToolUsageId}|${results.length}`;
          if (seenSearchResults.has(resultsKey)) continue;
          seenSearchResults.add(resultsKey);
          const list = formatSearchResults(results);
          const pending = popSearchQuery(resultsKey);
          const headerPrefix = pending?.prefix ?? prefix;
          const queryText = pending?.query ?? "";
          let msg = "";
          if (queryText) msg += `${buildSearchHeader(headerPrefix, true)}🔍 搜索: ${queryText}\n`;
          msg += `${buildSearchHeader(headerPrefix, false)}📄 找到 ${results.length} 条结果\n`;
          if (list) msg += `${list}\n`;
          if (showThinking) {
            if (!thinkOpened) {
              msg = `<think>\n${msg}`;
              thinkOpened = true;
            }
          }
          appendSearchText(msg);
        }

        if (stepTags.includes("raw_function_result") && (step as any).webSearchResults) {
          const results = extractSearchResults((step as any).webSearchResults);
          if (results.length) {
            const resultsKey = `${stepRolloutId || stepToolUsageId}|${results.length}`;
            if (!seenSearchResults.has(resultsKey)) {
              seenSearchResults.add(resultsKey);
              const list = formatSearchResults(results);
              const pending = popSearchQuery(resultsKey);
              const headerPrefix = pending?.prefix ?? prefix;
              const queryText = pending?.query ?? "";
              let msg = "";
              if (queryText) msg += `${buildSearchHeader(headerPrefix, true)}🔍 搜索: ${queryText}\n`;
              msg += `${buildSearchHeader(headerPrefix, false)}📄 找到 ${results.length} 条结果\n`;
              if (list) msg += `${list}\n`;
              if (showThinking) {
                if (!thinkOpened) {
                  msg = `<think>\n${msg}`;
                  thinkOpened = true;
                }
              }
              appendSearchText(msg);
            }
          }
        }
      }
    }

    // Skip aggregated model-level webSearchResults/toolUsageResults to avoid duplicate summaries.
    if (typeof modelResp.error === "string" && modelResp.error) throw new Error(modelResp.error);

    if (typeof modelResp.model === "string" && modelResp.model) model = modelResp.model;

    const rawUrls = modelResp.generatedImageUrls;
    const urls = normalizeGeneratedAssetUrls(rawUrls);
    if (urls.length) {
      for (const u of urls) {
        const imgPath = encodeAssetPath(u);
        const imgUrl = toImgProxyUrl(global, origin, imgPath);
        appendResponseText(`\n![Generated Image](${imgUrl})`);
      }
      break;
    }

    if (!sawResponseToken && typeof modelResp.message === "string") {
      if (showThinking && thinkOpened) {
        appendSearchText("\n</think>\n");
        thinkOpened = false;
      }
      responseText = modelResp.message;
    }

    // If upstream emits placeholder/empty generatedImageUrls in intermediate frames, keep scanning.
    if (Array.isArray(rawUrls)) continue;

    // For normal chat replies, the first modelResponse is enough.
    if (!Array.isArray(rawUrls)) break;
  }

  if (showThinking && thinkOpened) {
    appendResponseText("\n</think>\n");
    thinkOpened = false;
  }

  const promptEst = estimateInputTokensFromMessages(opts.promptMessages ?? []);
  const usage = buildChatUsageFromTexts({
    promptTextTokens: promptEst.textTokens,
    promptImageTokens: promptEst.imageTokens,
    completionText: `${searchText}${responseText}`,
  });

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `${searchText}${responseText}` },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      prompt_tokens_details: {
        cached_tokens: usage.cached_tokens,
        text_tokens: usage.input_tokens_details.text_tokens,
        audio_tokens: 0,
        image_tokens: usage.input_tokens_details.image_tokens,
      },
      completion_tokens_details: {
        text_tokens: usage.output_tokens_details.text_tokens,
        audio_tokens: 0,
        reasoning_tokens: usage.reasoning_tokens,
      },
    },
  };
}
