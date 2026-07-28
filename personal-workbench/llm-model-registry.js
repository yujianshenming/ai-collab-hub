// ============ 公司模型网关注册表（M2，主进程纯逻辑，无网络依赖） ============
// 固定网关：仅允许公司地址，renderer 不得注入任意 Base URL（计划书 §6.2）。
// 注册表始终可显示；/models 成功仅更新可用状态，失败不删除本地条目。
"use strict";

const LLM_GATEWAY_BASE_URL = "https://llm-service.polymas.com/api/openai/v1";

// stableDefault=false 的模型（gpt-5.5 / deepseek-v4-pro / gemini-3.1-pro-preview）
// 初始不得设为默认模型，但允许用户逐个连接测试（计划书 §1 首批模型注册表）
const LLM_MODEL_REGISTRY = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", role: "default", stableDefault: true },
  { id: "gpt-5.4", label: "GPT-5.4", role: "fallback", stableDefault: true },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", role: "analysis", stableDefault: true },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", role: "candidate", stableDefault: false },
  { id: "gpt-5.5", label: "GPT-5.5", role: "candidate", stableDefault: false },
  { id: "qwen3.7-max", label: "Qwen 3.7 Max", role: "domestic", stableDefault: true },
  { id: "kimi-k2.6", label: "Kimi K2.6", role: "domestic", stableDefault: true },
  { id: "glm-5", label: "GLM-5", role: "domestic", stableDefault: true },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", role: "experimental", stableDefault: false }
];

const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

// 模型 ID 归一化：仅接受字符串且只放行常见模型命名字符，防止 IPC 注入路径/头部等杂质
function sanitizeModelId(value) {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (!id || id.length > 120) return "";
  return /^[A-Za-z0-9][\w.\-:/]*$/.test(id) ? id : "";
}

function isKnownModelId(id) {
  return LLM_MODEL_REGISTRY.some((model) => model.id === id);
}

// 只有 stableDefault 的注册模型可以被设为默认（不稳定模型仍可测试与显式选用）
function isAllowedDefaultModel(id) {
  const entry = LLM_MODEL_REGISTRY.find((model) => model.id === id);
  return Boolean(entry && entry.stableDefault);
}

function normalizeDefaultModel(id) {
  const clean = sanitizeModelId(id);
  return isAllowedDefaultModel(clean) ? clean : DEFAULT_MODEL_ID;
}

// /models 兼容两种形状：字符串数组 与 OpenAI 标准 { object, data: [{ id }] }
// 返回去重后的模型 ID 数组；无法识别的形状返回 null（调用方保留本地注册表）
function normalizeModelsResponse(payload) {
  let rawIds = null;
  if (Array.isArray(payload)) {
    rawIds = payload;
  } else if (payload && typeof payload === "object" && Array.isArray(payload.data)) {
    rawIds = payload.data.map((entry) => (typeof entry === "string" ? entry : entry?.id));
  } else if (payload && typeof payload === "object" && Array.isArray(payload.models)) {
    rawIds = payload.models.map((entry) => (typeof entry === "string" ? entry : entry?.id));
  }
  if (!rawIds) return null;
  const ids = [];
  for (const raw of rawIds) {
    const id = sanitizeModelId(raw);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// 注册表快照 + 远端可用状态合并：
// remoteIds 为 null（/models 失败）时全部 availability=unknown，本地条目永不删除
function buildModelList(remoteIds) {
  return LLM_MODEL_REGISTRY.map((model) => ({
    id: model.id,
    label: model.label,
    role: model.role,
    stableDefault: model.stableDefault,
    availability: !Array.isArray(remoteIds)
      ? "unknown"
      : remoteIds.includes(model.id) ? "available" : "unlisted"
  }));
}

module.exports = {
  LLM_GATEWAY_BASE_URL,
  LLM_MODEL_REGISTRY,
  DEFAULT_MODEL_ID,
  sanitizeModelId,
  isKnownModelId,
  isAllowedDefaultModel,
  normalizeDefaultModel,
  normalizeModelsResponse,
  buildModelList
};
