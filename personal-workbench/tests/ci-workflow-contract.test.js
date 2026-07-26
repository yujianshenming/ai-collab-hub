const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowPath = path.resolve(
  __dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "personal-workbench-ci.yml"
);
const workflow = fs.readFileSync(workflowPath, "utf8");

test("Personal Workbench CI runs quality and Electron E2E checks on Windows", () => {
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /name: Static and unit checks[\s\S]*?run: npm test/);
  assert.match(workflow, /name: Electron E2E[\s\S]*?run: npm run test:e2e/);
  assert.equal((workflow.match(/runs-on: windows-latest/g) || []).length, 2);
});

test("third-party actions are pinned to immutable commits", () => {
  const uses = Array.from(workflow.matchAll(/uses:\s*([^\s#]+)/g), (match) => match[1]);
  assert.ok(uses.length > 0);
  for (const action of uses) {
    assert.match(action, /^[^@\s]+@[a-f0-9]{40}$/);
  }
});
