import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { getModelInfo, toGrokModel } from "./models";

export interface OpenAIChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url?: string } }>;
}

export interface OpenAIChatRequestBody {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
}

export const CONVERSATION_API = "https://grok.com/rest/app-chat/conversations/new";
export const SHARE_CREATE_API = "https://grok.com/rest/app-chat/conversations/{conversationId}/share";
export const SHARE_CLONE_API = "https://grok.com/rest/app-chat/share-links/{shareLinkId}/clone";

export function extractContent(messages: OpenAIChatMessage[]): { content: string; images: string[] } {
  const formatted: string[] = [];
  const images: string[] = [];

  const roleMap: Record<string, string> = { system: "系统", user: "用户", assistant: "grok" };

  for (const msg of messages) {
    const role = msg.role ?? "user";
    const rolePrefix = roleMap[role] ?? role;
    const content = msg.content ?? "";

    const textParts: string[] = [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "text") textParts.push(item.text ?? "");
        if (item?.type === "image_url") {
          const url = item.image_url?.url;
          if (url) images.push(url);
        }
      }
    } else {
      textParts.push(String(content));
    }

    const msgText = textParts.join("").trim();
    if (msgText) formatted.push(`${rolePrefix}：${msgText}`);
  }

  return { content: formatted.join("\n"), images };
}

export function buildConversationPayload(args: {
  requestModel: string;
  content: string;
  imgIds: string[];
  imgUris: string[];
  postId?: string;
  settings: GrokSettings;
  isReasoning?: boolean;
  parentResponseId?: string;
}): { payload: Record<string, unknown>; referer?: string; isVideoModel: boolean } {
  const { requestModel, content, imgIds, imgUris, postId, settings, isReasoning, parentResponseId } = args;
  const cfg = getModelInfo(requestModel);
  const { grokModel, mode, isVideoModel } = toGrokModel(requestModel);

  if (cfg?.is_video_model && imgUris.length) {
    const ref = postId ? `https://grok.com/imagine/${postId}` : `https://assets.grok.com/post/${imgUris[0]}`;
    const referer = postId ? `https://grok.com/imagine/${postId}` : undefined;
    return {
      isVideoModel: true,
      ...(referer ? { referer } : {}),
      payload: {
        temporary: true,
        modelName: "grok-3",
        message: `${ref}  ${content} --mode=custom`,
        fileAttachments: imgIds,
        toolOverrides: { videoGen: true },
        ...(parentResponseId ? { parentResponseId } : {}),
      },
    };
  }

  return {
    isVideoModel,
    payload: {
      temporary: settings.temporary ?? true,
      modelName: grokModel,
      message: content,
      fileAttachments: imgIds,
      imageAttachments: [],
      disableSearch: false,
      enableImageGeneration: true,
      returnImageBytes: false,
      returnRawGrokInXaiRequest: false,
      enableImageStreaming: true,
      imageGenerationCount: 2,
      forceConcise: false,
      toolOverrides: {},
      enableSideBySide: true,
      sendFinalMetadata: true,
      isReasoning: Boolean(isReasoning),
      webpageUrls: [],
      disableTextFollowUps: true,
      responseMetadata: { requestModelDetails: { modelId: grokModel } },
      disableMemory: false,
      forceSideBySide: false,
      modelMode: mode,
      isAsyncChat: false,
      ...(parentResponseId ? { parentResponseId } : {}),
    },
  };
}

export async function sendConversationRequest(args: {
  payload: Record<string, unknown>;
  cookie: string;
  settings: GrokSettings;
  referer?: string;
  upstreamConversationId?: string;
}): Promise<Response> {
  const { payload, cookie, settings, referer, upstreamConversationId } = args;
  const path = upstreamConversationId
    ? `/rest/app-chat/conversations/${upstreamConversationId}/responses`
    : "/rest/app-chat/conversations/new";
  const headers = getDynamicHeaders(settings, path);
  headers.Cookie = cookie;
  if (referer) headers.Referer = referer;
  const body = JSON.stringify(payload);
  const apiUrl = upstreamConversationId
    ? `https://grok.com${path}`
    : CONVERSATION_API;

  return fetch(apiUrl, { method: "POST", headers, body });
}

export async function createShareLink(args: {
  conversationId: string;
  cookie: string;
  settings: GrokSettings;
}): Promise<Response> {
  const { conversationId, cookie, settings } = args;
  const path = `/rest/app-chat/conversations/${conversationId}/share`;
  const headers = getDynamicHeaders(settings, path);
  headers.Cookie = cookie;
  const apiUrl = SHARE_CREATE_API.replace("{conversationId}", encodeURIComponent(conversationId));
  return fetch(apiUrl, { method: "POST", headers, body: "{}" });
}

export async function cloneShareLink(args: {
  shareLinkId: string;
  cookie: string;
  settings: GrokSettings;
}): Promise<Response> {
  const { shareLinkId, cookie, settings } = args;
  const path = `/rest/app-chat/share-links/${shareLinkId}/clone`;
  const headers = getDynamicHeaders(settings, path);
  headers.Cookie = cookie;
  const apiUrl = SHARE_CLONE_API.replace("{shareLinkId}", encodeURIComponent(shareLinkId));
  return fetch(apiUrl, { method: "POST", headers, body: "{}" });
}
