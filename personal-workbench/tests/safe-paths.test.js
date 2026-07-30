// safe-paths.test.js —— 路径边界守卫单测
// 重点:验证 realpath 比对能拒绝 Windows junction/symlink 逃逸(对抗评审残留风险 #3)。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveContained } = require("../safe-paths");

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "safe-paths-"));
}

test("返回真实绝对路径:候选在 baseDir 内(含子目录)", () => {
  const root = makeTempRoot();
  const file = path.join(root, "report.json");
  fs.writeFileSync(file, "{}");
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub);
  const nested = path.join(sub, "nested.txt");
  fs.writeFileSync(nested, "x");
  assert.strictEqual(resolveContained(root, file), fs.realpathSync(file));
  assert.strictEqual(resolveContained(root, nested), fs.realpathSync(nested));
});

test("返回 null:候选越出 baseDir", () => {
  const root = makeTempRoot();
  const outside = path.resolve(os.tmpdir(), `outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, "x");
  assert.strictEqual(resolveContained(root, outside), null);
  fs.unlinkSync(outside);
});

test("拒绝 Windows junction / symlink 逃逸(在 baseDir 内指向外部)", (t) => {
  const root = makeTempRoot();
  const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), "escape-target-"));
  const junction = path.join(root, "evil-link");
  let created = false;
  try {
    // 在 root 内放一个 junction 指向外部目录;realpath 会解析到外部,应当被拒绝
    fs.symlinkSync(escapeTarget, junction, "junction");
    created = true;
  } catch {
    // 当前环境不支持 junction(如无权限 / 非 Windows):跳过而非误报
  }
  if (!created) {
    t.skip("junction creation unsupported in this environment");
    return;
  }
  assert.strictEqual(resolveContained(root, junction), null);
});

test("扩展名过滤:仅接受白名单扩展名", () => {
  const root = makeTempRoot();
  const good = path.join(root, "ok.txt");
  const bad = path.join(root, "bad.md");
  fs.writeFileSync(good, "x");
  fs.writeFileSync(bad, "x");
  assert.strictEqual(resolveContained(root, good, { extensions: [".txt"] }), fs.realpathSync(good));
  assert.strictEqual(resolveContained(root, bad, { extensions: [".txt"] }), null);
});

test("baseDir 为 null:不限目录但校验扩展名", () => {
  const anywhere = path.resolve(os.tmpdir(), `anywhere-${Date.now()}.txt`);
  fs.writeFileSync(anywhere, "x");
  assert.strictEqual(resolveContained(null, anywhere, { extensions: [".txt"] }), fs.realpathSync(anywhere));
  fs.unlinkSync(anywhere);
});

test("fail-closed:空串 / 不存在路径返回 null", () => {
  const root = makeTempRoot();
  assert.strictEqual(resolveContained(root, ""), null);
  assert.strictEqual(resolveContained(root, path.join(root, "nope.json")), null);
});
