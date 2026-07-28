const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const integration = path.join(ROOT, "integrations", "homework-variance");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("homework variance integration keeps the sidecar boundary explicit", () => {
  const main = read("main.js");
  const preload = read("preload.js");
  const renderer = read("renderer.js");
  const index = read("index.html");
  const server = fs.readFileSync(path.join(integration, "web_server.py"), "utf8");
  const engine = fs.readFileSync(path.join(integration, "polymas_grade_engine.py"), "utf8");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(main, /homework-variance:start/);
  assert.match(main, /127\.0\.0\.1/);
  assert.match(main, /--auth-token/);
  assert.match(main, /taskkill/);
  assert.match(preload, /startHomeworkVariance/);
  assert.match(renderer, /HOMEWORK_VARIANCE_ID/);
  assert.match(renderer, /renderHomeworkVarianceCenter/);
  assert.match(index, /id="homework-variance-frame"/);
  assert.match(index, /allow-downloads/);
  assert.match(server, /local_access_guard/);
  assert.match(server, /hmac\.compare_digest/);
  assert.match(server, /@app\.get\("\/health"\)/);
  assert.match(server, /MAX_UPLOAD_BYTES/);
  assert.match(server, /JOB_ID_RE/);
  assert.match(server, /resolve_job_file/);
  assert.match(engine, /PERSONAL_WORKBENCH_HOMEWORK_VARIANCE_SECRETS/);

  const extraResources = packageJson.build?.extraResources || [];
  assert.ok(extraResources.some((entry) => entry.to === "integrations/homework-variance"));
  assert.equal(fs.existsSync(path.join(integration, "secrets.json")), false);
  assert.equal(fs.existsSync(path.join(integration, "output")), false);
});
