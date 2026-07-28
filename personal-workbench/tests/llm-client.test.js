// M2：llm-client 契约测试 —— 本地假 HTTP 服务（node:http 随机端口），
// 绝不访问真实网关；假 key 为合成数据（计划书 §7 测试纪律）
const assert = require("node:assert");
const test = require("node:test");
const http = require("node:http");

const { createLlmClient, sanitizeErrorText, safeErrorForStatus, extractMessageContent } = require("../llm-client.js");

const FAKE_KEY = "sk-fake-test-key-000000";

// 启动一次性假网关：handler(req, res, bodyText) 决定响应
function startFakeGateway(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => handler(req, res, raw));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function makeClient(baseUrl, apiKey = FAKE_KEY) {
  return createLlmClient({ baseUrl, getApiKey: () => apiKey });
}

function chatPayload(content) {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

test("无 key 时直接失败，不发起任何请求", async () => {
  let hit = 0;
  const gateway = await startFakeGateway((req, res) => { hit += 1; res.end("{}"); });
  try {
    const client = makeClient(gateway.baseUrl, "");
    const result = await client.chatCompletion({ model: "claude-sonnet-4-6", messages: [] });
    assert.equal(result.ok, false);
    assert.match(result.error, /尚未配置 API key/);
    assert.equal(hit, 0);
  } finally {
    await gateway.close();
  }
});

test("chatCompletion：携带 Bearer 头，解析纯字符串内容", async () => {
  let seenAuth = "";
  let seenBody = null;
  const gateway = await startFakeGateway((req, res, raw) => {
    seenAuth = req.headers.authorization;
    seenBody = JSON.parse(raw);
    res.setHeader("content-type", "application/json");
    res.end(chatPayload("OK"));
  });
  try {
    const client = makeClient(gateway.baseUrl);
    const result = await client.chatCompletion({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16
    });
    assert.deepEqual(result, { ok: true, content: "OK" });
    assert.equal(seenAuth, `Bearer ${FAKE_KEY}`);
    assert.equal(seenBody.model, "claude-sonnet-4-6");
    assert.equal(seenBody.max_tokens, 16);
    assert.equal(seenBody.temperature, 0);
  } finally {
    await gateway.close();
  }
});

test("chatCompletion：内容数组形状拼接，空内容视为失败", async () => {
  const bodies = [
    JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "第一" }, "第二"] } }] }),
    chatPayload("   ")
  ];
  const gateway = await startFakeGateway((req, res) => {
    res.end(bodies.shift());
  });
  try {
    const client = makeClient(gateway.baseUrl);
    const first = await client.chatCompletion({ model: "m", messages: [] });
    assert.deepEqual(first, { ok: true, content: "第一第二" });
    const second = await client.chatCompletion({ model: "m", messages: [] });
    assert.equal(second.ok, false);
    assert.match(second.error, /空内容/);
  } finally {
    await gateway.close();
  }
});

test("HTTP 错误映射为安全文案，响应体不透传，key 不出现在返回值", async () => {
  const statuses = [401, 403, 404, 429, 503];
  let index = 0;
  const gateway = await startFakeGateway((req, res) => {
    res.statusCode = statuses[index];
    index += 1;
    // 恶意响应体：回显 Authorization 头，客户端必须不透传
    res.end(JSON.stringify({ error: `boom ${req.headers.authorization}` }));
  });
  try {
    const client = makeClient(gateway.baseUrl);
    const expected = [/认证失败/, /没有权限/, /不存在/, /过于频繁/, /网关服务异常（503）/];
    for (let i = 0; i < statuses.length; i += 1) {
      const result = await client.chatCompletion({ model: "m", messages: [] });
      assert.equal(result.ok, false);
      assert.equal(result.status, statuses[i]);
      assert.match(result.error, expected[i]);
      assert.ok(!JSON.stringify(result).includes(FAKE_KEY), "key 绝不出现在返回值");
    }
  } finally {
    await gateway.close();
  }
});

test("非法 JSON 与空响应都按失败处理", async () => {
  const bodies = ["not-json{{{", ""];
  const gateway = await startFakeGateway((req, res) => { res.end(bodies.shift()); });
  try {
    const client = makeClient(gateway.baseUrl);
    const bad = await client.listModels();
    assert.equal(bad.ok, false);
    assert.match(bad.error, /不是合法 JSON/);
    const empty = await client.listModels();
    assert.equal(empty.ok, false);
    assert.match(empty.error, /空响应/);
  } finally {
    await gateway.close();
  }
});

test("listModels：两种形状都归一为 ids，不识别形状按失败", async () => {
  const bodies = [
    JSON.stringify({ object: "list", data: [{ id: "claude-sonnet-4-6" }, { id: "gpt-5.4" }] }),
    JSON.stringify(["glm-5", "kimi-k2.6"]),
    JSON.stringify({ unexpected: true })
  ];
  const gateway = await startFakeGateway((req, res) => {
    assert.equal(req.url, "/models");
    res.end(bodies.shift());
  });
  try {
    const client = makeClient(gateway.baseUrl);
    assert.deepEqual(await client.listModels(), { ok: true, ids: ["claude-sonnet-4-6", "gpt-5.4"] });
    assert.deepEqual(await client.listModels(), { ok: true, ids: ["glm-5", "kimi-k2.6"] });
    const bad = await client.listModels();
    assert.equal(bad.ok, false);
    assert.match(bad.error, /无法识别/);
  } finally {
    await gateway.close();
  }
});

test("超时：慢响应返回 timedOut，不抛异常", async () => {
  const gateway = await startFakeGateway((req, res) => {
    setTimeout(() => res.end(chatPayload("late")), 2000);
  });
  try {
    const client = makeClient(gateway.baseUrl);
    const result = await client.chatCompletion({ model: "m", messages: [], timeoutMs: 150 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.error, /超时/);
  } finally {
    await gateway.close();
  }
});

test("外部取消：AbortController 返回 cancelled", async () => {
  const gateway = await startFakeGateway((req, res) => {
    setTimeout(() => res.end(chatPayload("late")), 2000);
  });
  try {
    const client = makeClient(gateway.baseUrl);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await client.chatCompletion({ model: "m", messages: [], signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
  } finally {
    await gateway.close();
  }
});

test("testModel：成功带 latencyMs，失败带安全错误", async () => {
  const bodies = [chatPayload("OK"), null];
  const gateway = await startFakeGateway((req, res, raw) => {
    const body = bodies.shift();
    if (body) {
      const parsed = JSON.parse(raw);
      assert.equal(parsed.max_tokens, 16);
      res.end(body);
    } else {
      res.statusCode = 401;
      res.end("{}");
    }
  });
  try {
    const client = makeClient(gateway.baseUrl);
    const good = await client.testModel("claude-sonnet-4-6");
    assert.equal(good.ok, true);
    assert.equal(typeof good.latencyMs, "number");
    const bad = await client.testModel("claude-sonnet-4-6");
    assert.equal(bad.ok, false);
    assert.match(bad.error, /认证失败/);
    assert.ok(!JSON.stringify(bad).includes(FAKE_KEY));
  } finally {
    await gateway.close();
  }
});

test("连接失败：错误文本经脱敏且不含 key", async () => {
  // 指向已关闭端口
  const gateway = await startFakeGateway((req, res) => res.end("{}"));
  const deadUrl = gateway.baseUrl;
  await gateway.close();
  const client = makeClient(deadUrl);
  const result = await client.chatCompletion({ model: "m", messages: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /无法连接模型网关/);
  assert.ok(!result.error.includes(FAKE_KEY));
});

test("sanitizeErrorText / safeErrorForStatus / extractMessageContent 纯函数行为", () => {
  assert.equal(sanitizeErrorText(`oops ${FAKE_KEY} leaked`, FAKE_KEY), "oops [REDACTED] leaked");
  assert.equal(sanitizeErrorText("header Bearer abc.def-123 tail", ""), "header Bearer [REDACTED] tail");
  assert.equal(sanitizeErrorText("x".repeat(600), "").length, 500);
  assert.equal(safeErrorForStatus(418), "请求失败（418）");
  assert.equal(extractMessageContent({ choices: [{ message: { content: "hi" } }] }), "hi");
  assert.equal(extractMessageContent({}), "");
  assert.equal(extractMessageContent({ choices: [{ message: { content: [{ text: "a" }, null, "b"] } }] }), "ab");
});
