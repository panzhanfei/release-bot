import { env } from "../config/env";
import { trimOutput } from "../utils/text";

let tenantAccessToken = "";
let tenantTokenExpireAt = 0;
const handledFeishuEvents = new Map<string, number>();
const FEISHU_HTTP_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEISHU_HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function cleanupHandledEvents() {
  const now = Date.now();
  for (const [key, expireAt] of handledFeishuEvents.entries()) {
    if (expireAt <= now) handledFeishuEvents.delete(key);
  }
}

export function acquireFeishuEventLock(eventKey: string) {
  cleanupHandledEvents();
  if (handledFeishuEvents.has(eventKey)) return false;
  handledFeishuEvents.set(eventKey, Date.now() + env.FEISHU_EVENT_TTL_MS);
  return true;
}

export async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (tenantAccessToken && now < tenantTokenExpireAt - 60_000) return tenantAccessToken;
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error("missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  }

  const resp = await fetchWithTimeout("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
    }),
  });

  const data = (await resp.json()) as {
    code: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (!resp.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`get tenant_access_token failed: ${data.msg || "unknown"}`);
  }

  tenantAccessToken = data.tenant_access_token;
  tenantTokenExpireAt = now + (data.expire || 7200) * 1000;
  return tenantAccessToken;
}

async function sendFeishuMessageByChatId(chatId: string, text: string) {
  const token = await getTenantAccessToken();
  const resp = await fetchWithTimeout("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });

  const data = (await resp.json()) as { code: number; msg?: string };
  if (!resp.ok || data.code !== 0) {
    throw new Error(`send by chat_id failed: ${data.msg || "unknown"}`);
  }
}

async function replyFeishuMessage(messageId: string, text: string) {
  const token = await getTenantAccessToken();
  const resp = await fetchWithTimeout(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });

  const data = (await resp.json()) as { code: number; msg?: string };
  if (!resp.ok || data.code !== 0) {
    throw new Error(`reply message failed: ${data.msg || "unknown"}`);
  }
}

export async function safeReply(params: { messageId?: string; chatId?: string; text: string }) {
  const content = trimOutput(params.text);
  let replyErr = "";

  if (params.messageId) {
    try {
      await replyFeishuMessage(params.messageId, content);
      return;
    } catch (err: any) {
      replyErr = String(err?.message || "");
      console.warn("reply failed, fallback to chat_id send:", replyErr);
    }
  }

  if (params.chatId) {
    try {
      await sendFeishuMessageByChatId(params.chatId, content);
      return;
    } catch (err: any) {
      const chatErr = String(err?.message || "");
      throw new Error(
        `reply failed: ${replyErr || "unknown"}; chat_id send failed: ${chatErr || "unknown"}`
      );
    }
  } else {
    console.warn("missing message_id and chat_id, skip reply");
  }
}
