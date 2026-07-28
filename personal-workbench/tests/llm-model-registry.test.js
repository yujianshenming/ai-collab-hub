// M2：模型注册表纯逻辑契约测试（无网络、无真实 key）
const assert = require("node:assert");
const test = require("node:test");

const registry = require("../llm-model-registry.js");
const {
  LLM_GATEWAY_BASE_URL,
  LLM_MODEL_REGISTRY,
  DEFAULT_MODEL_ID,
  sanitizeModelId,
  isKnownModelId,
  isAllowedDefaultModel,
  normalizeDefaultModel,
  normalizeModelsResponse,
  buildModelList
} = registry;

test("网关地址固定为公司域名，不含尾部斜杠", () => {
  assert.equal(LLM_GATEWAY_BASE_URL, "https://llm-service.polymas.com/api/openai/v1");
});

test("注册表：9 个模型且默认模型存在并 stableDefault", () => {
  assert.equal(LLM_MODEL_REGISTRY.length, 9);
  const entry = LLM_MODEL_REGISTRY.find((m) => m.id === DEFAULT_MODEL_ID);
  assert.ok(entry);
  assert.equal(entry.stableDefault, true);
});

test("sanitizeModelId：放行合法 ID，拒绝注入杂质", () => {
  assert.equal(sanitizeModelId("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(sanitizeModelId(" gpt-5.4 "), "gpt-5.4");
  assert.equal(sanitizeModelId("vendor/model:tag"), "vendor/model:tag");
  assert.equal(sanitizeModelId(""), "");
  assert.equal(sanitizeModelId("../etc/passwd"), "");
  assert.equal(sanitizeModelId("bad id\r\nX-Header: 1"), "");
  assert.equal(sanitizeModelId("a".repeat(121)), "");
  assert.equal(sanitizeModelId(null), "");
});

test("不稳定模型不可设为默认，未知模型回退默认", () => {
  // gpt-5.5 / deepseek-v4-pro / gemini-3.1-pro-preview 初始不得为默认
  for (const id of ["gpt-5.5", "deepseek-v4-pro", "gemini-3.1-pro-preview"]) {
    assert.equal(isKnownModelId(id), true);
    assert.equal(isAllowedDefaultModel(id), false);
    assert.equal(normalizeDefaultModel(id), DEFAULT_MODEL_ID);
  }
  assert.equal(normalizeDefaultModel("no-such-model"), DEFAULT_MODEL_ID);
  assert.equal(normalizeDefaultModel(undefined), DEFAULT_MODEL_ID);
  // 稳定模型可设默认
  assert.equal(normalizeDefaultModel("gpt-5.4"), "gpt-5.4");
  assert.equal(normalizeDefaultModel("glm-5"), "glm-5");
});

test("normalizeModelsResponse：兼容字符串数组与 OpenAI data 形状", () => {
  assert.deepEqual(normalizeModelsResponse(["glm-5", "kimi-k2.6", "glm-5"]), ["glm-5", "kimi-k2.6"]);
  assert.deepEqual(
    normalizeModelsResponse({ object: "list", data: [{ id: "gpt-5.4" }, { id: "claude-opus-4-8" }] }),
    ["gpt-5.4", "claude-opus-4-8"]
  );
  assert.deepEqual(normalizeModelsResponse({ models: ["qwen3.7-max", { id: "glm-5" }] }), ["qwen3.7-max", "glm-5"]);
  // 非法条目被剔除，不识别形状返回 null
  assert.deepEqual(normalizeModelsResponse(["ok-model", "../bad", 42]), ["ok-model"]);
  assert.equal(normalizeModelsResponse({ foo: "bar" }), null);
  assert.equal(normalizeModelsResponse("glm-5"), null);
  assert.equal(normalizeModelsResponse(null), null);
});

test("buildModelList：/models 失败保留本地注册表（unknown），成功标记可用状态", () => {
  const unknown = buildModelList(null);
  assert.equal(unknown.length, LLM_MODEL_REGISTRY.length);
  assert.ok(unknown.every((m) => m.availability === "unknown"));

  const merged = buildModelList(["claude-sonnet-4-6", "extra-remote-model"]);
  assert.equal(merged.length, LLM_MODEL_REGISTRY.length, "远端多余模型不进入注册表");
  assert.equal(merged.find((m) => m.id === "claude-sonnet-4-6").availability, "available");
  assert.equal(merged.find((m) => m.id === "gpt-5.4").availability, "unlisted");
  // 列表条目携带 renderer 需要的字段
  const sample = merged[0];
  assert.deepEqual(Object.keys(sample).sort(), ["availability", "id", "label", "role", "stableDefault"]);
});
