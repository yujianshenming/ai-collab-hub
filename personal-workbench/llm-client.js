// ============ Polymas OpenAI 兼容客户端（M2，仅主进程使用） ============
// 安全边界（计划书 §6）：
// - Base URL 固定为公司网关；createLlmClient 的 baseUrl 参数仅供本地假服务测试注入，
//   main.js 生产路径不得传入，renderer 更无法触达本模块。
// - API key 只经 Authorization 头发出；错误消息、返回值一律经 sanitizeErrorText 脱敏。
// - 响应体硬上限 2 MiB；默认超时 60s，连接测试 15s；AbortController 支持取消。
"use strict";

const { LLM_GATEWAY_BASE_URL, normalizeModelsResponse } = require("./llm-model-registry.js");

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const TEST_TIMEOUT_MS = 15000;

// 网关错误 → 用户可理解的安全文案；不透传原始响应体（可能包含回显的请求头）
function safeErrorForStatus(status) {
  if (status === 401) return "认证失败：API key 无效或已过期";
  if (status === 403) return "没有权限访问该模型";
  if (status === 404) return "模型或接口不存在";
  if (status === 429) return "请求过于频繁，请稍后再试";
  if (status >= 500) return `网关服务异常（${status}）`;
  return `请求失败（${status}）`;
}

// 从任意文本中抹去 key，避免异常路径把密钥带进日志/renderer
function sanitizeErrorText(text, apiKey) {
  let safe = String(text || "");
  if (apiKey && safe.includes(apiKey)) safe = safe.split(apiKey).join("[REDACTED]");
  safe = safe.replace(/Bearer\s+[\w.\-]+/gi, "Bearer [REDACTED]");
  return safe.slice(0, 500);
}

// 读取响应体并施加 2 MiB 硬上限
async function readBodyCapped(response) {
  const lengthHeader = Number(response.headers?.get?.("content-length") || 0);
  if (lengthHeader > MAX_RESPONSE_BYTES) throw new Error("响应体超过大小上限");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("响应体超过大小上限");
  return text;
}

// choices[0].message.content：兼容纯字符串与内容数组两种形状
function extractMessageContent(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

// getApiKey: () => string|Promise<string>，由 main.js 注入（safeStorage/env）
function createLlmClient(options = {}) {
  const baseUrl = String(options.baseUrl || LLM_GATEWAY_BASE_URL).replace(/\/+$/, "");
  const getApiKey = typeof options.getApiKey === "function" ? options.getApiKey : () => "";
  const fetchImpl = options.fetchImpl || fetch;

  async function request(pathname, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    const apiKey = String((await getApiKey()) || "");
    if (!apiKey) return { ok: false, error: "尚未配置 API key" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const onOuterAbort = () => controller.abort(signal?.reason || new Error("cancelled"));
    if (signal) {
      if (signal.aborted) onOuterAbort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    try {
      const response = await fetchImpl(`${baseUrl}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await readBodyCapped(response);
      if (!response.ok) return { ok: false, status: response.status, error: safeErrorForStatus(response.status) };
      if (!text.trim()) return { ok: false, error: "网关返回空响应" };
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, error: "网关响应不是合法 JSON" };
      }
      return { ok: true, payload };
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = String(controller.signal.reason?.message || controller.signal.reason || "");
        if (reason.includes("timeout")) return { ok: false, error: "请求超时", timedOut: true };
        return { ok: false, error: "请求已取消", cancelled: true };
      }
      return { ok: false, error: `无法连接模型网关：${sanitizeErrorText(error?.message, apiKey)}` };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    }
  }

  // GET /models：返回 { ok, ids }；形状不识别按失败处理，调用方保留本地注册表
  async function listModels({ signal, timeoutMs = TEST_TIMEOUT_MS } = {}) {
    const result = await request("/models", { timeoutMs, signal });
    if (!result.ok) return result;
    const ids = normalizeModelsResponse(result.payload);
    if (!ids) return { ok: false, error: "无法识别 /models 返回形状" };
    return { ok: true, ids };
  }

  // POST /chat/completions：返回 { ok, content }；空内容视为失败
  async function chatCompletion({ model, messages, temperature = 0, maxTokens, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const body = { model, messages, temperature };
    if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    const result = await request("/chat/completions", { method: "POST", body, timeoutMs, signal });
    if (!result.ok) return result;
    const content = extractMessageContent(result.payload);
    if (!String(content).trim()) return { ok: false, error: "模型返回了空内容" };
    return { ok: true, content };
  }

  // 逐模型连接测试：短请求 + 15s 超时；返回 { ok, latencyMs, error? }
  async function testModel(modelId, { signal } = {}) {
    const startedAt = Date.now();
    const result = await chatCompletion({
      model: modelId,
      messages: [{ role: "user", content: "连接测试，请只回复：OK" }],
      maxTokens: 16,
      timeoutMs: TEST_TIMEOUT_MS,
      signal
    });
    const latencyMs = Date.now() - startedAt;
    return result.ok ? { ok: true, latencyMs } : { ok: false, latencyMs, error: result.error };
  }

  return { listModels, chatCompletion, testModel, baseUrl };
}

module.exports = {
  createLlmClient,
  sanitizeErrorText,
  extractMessageContent,
  safeErrorForStatus,
  MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  TEST_TIMEOUT_MS
};
