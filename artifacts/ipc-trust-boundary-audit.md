# 资深代码审计 · IPC 信任边界专项

> 审计人:资深开发工程师(Senior Developer)
> 审计对象:`personal-workbench/main.js`(3403 行)、`preload.js`(139 行)
> 方法:直接读真实代码,对照 `docs/ADVERSARIAL_REVIEW_2026-07-24.md` 逐项核实**当前**状态,
> 而非复读旧报告。
> 日期:2026-07-30

---

## 0. 一句话结论

对抗评审发现的路径类 CRITICAL/HIGH **团队已经实际修掉了**(给团队点赞),但修法是
**"每个 bug 各打一个补丁"**,没有沉淀成**团队可复用的单一安全原语**。这导致两个问题:
(1) `resolveTaskPath` 仍用字符串前缀比对,存在 Windows junction 逃逸残留风险;
(2) 5 个分散的路径守卫函数,下一个 IPC handler 大概率不会复用,安全面必然再次张开。

**团队的技术天花板不在"能不能修",而在"写新代码时会不会主动用范式"。** 这是本次审计要
解决的真实课题。

---

## 1. 已修复项(已读源码核实,确认关闭)

| 原评审项 | 问题 | 当前代码证据 | 状态 |
|---|---|---|---|
| SEC-01 | `desktop-app:launch` 任意 spawn | `main.js:3088` 先 `isApprovedDesktopAppPath(exePath)`,拒绝未登记路径;`spawn(approvedExePath, …)` | ✅ 已修 |
| SEC-03 | `todoFilePath` 任意读写 | `main.js:2573` `delete next.todoFilePath`(renderer 传的忽略);`tasks:read-todo-file`(2591)走 `resolveConfiguredTodoFilePath()` | ✅ 已修 |
| SEC-05 | `/cookies` 空 url 倾印 | `main.js:1187` `getWorkbenchCookies` 强制 `url` 校验,缺失返回 `[]`(fail-closed) | ✅ 已修 |
| SEC-06 | `upload:resolve-files` 路径穿越 | `main.js:2499` 走 `validateUploadPaths(paths, request.taskFolder)` 而非裸路径 | ✅ 已修 |

> 说明:对抗评审机制有效,团队执行到位。这是好信号,下面要谈的是"如何不让它退化"。

---

## 2. 仍开放的真实风险(资深视角)

### [HIGH · 残留] `resolveTaskPath` 用字符串前缀而非 `realpath` —— Windows junction 逃逸

```js
// main.js:1896  —— 当前实现
function resolveTaskPath(candidate) {
  const tasksRoot = path.resolve(downloadRoot, "tasks");
  const target = path.resolve(String(candidate || ""));
  if (target !== tasksRoot && !target.startsWith(`${tasksRoot}${path.sep}`)) return null;
  return target;
}
```

- **问题**:`path.resolve` 不展开 junction/symlink。攻击者在 `temp/tasks/` 下建一个 junction
  指向 `C:\Windows\System32`,`startsWith` 比对通过,但后续 `fs` 操作访问的是越界目录。
- **对照**:同文件的 `resolveConfiguredPathCandidate`(1880 行)已经用 `fs.realpathSync`
  做对了 —— **同一个仓库,路径守卫的严谨度不一致**,这是架构味道,不是偶然。
- **残留风险原文**(评审 7 节):"`resolveTaskPath` 字符串前缀非 realpath,Windows junction 下
  tasks 根逃逸残留。" 至本次审计仍未闭合。

### [MEDIUM · 架构] 路径守卫有 5 个分散实现,缺单一事实源

| 函数 | 行号 | 校验方式 | 复用范围 |
|---|---|---|---|
| `resolveTaskPath` | 1896 | 字符串 `startsWith` | 任务文件类 IPC |
| `resolveConfiguredPathCandidate` | 1876 | `realpathSync` + `.txt` | todo 文件 |
| `resolveConfiguredTodoFilePath` | 1887 | 包上面 | todo 读取 |
| `isApprovedDesktopAppPath` | 416 | allowlist | 桌面程序 |
| `validateUploadPaths` | 1128 | taskFolder 内 | 上传 |

- **风险**:没有统一入口,新人加 IPC handler 时"不知道该调哪个",或干脆不调 → 安全面回归。
- **根因**:每次评审发现问题,都是**就地补一个专用函数**,而不是**抽出一个共享、被测试覆盖
  的边界模块**。这正是团队从"会修 bug"迈向"会建范式"的差距所在。

---

## 3. 核心教训:你们在"修 bug",但没在"建范式"

对抗评审是**事后**找茬,很棒。但团队能力的跃迁,来自把每次发现提炼成**事前**可复用的
原语 + 评审硬规则。否则:

- 旧 bug 修好了,新 handler 又开一个口子;
- 评审发现的安全面,会随代码增长再次张开;
- 资深经验留在 PR 评论里,没变成代码里的"护栏"。

**建议的范式**:任何 IPC handler 只要碰 `fs`/`path`,**必须经过单一路径守卫模块**,且模块本身
有单元测试覆盖 junction/symlink 逃逸。把"记得要校验"变成"不校验编译器/评审都不让过"。

---

## 4. 整改清单(按优先级)

| 优先级 | 行动 | 产出 |
|---|---|---|
| **P0** | 抽取 `safe-paths.js` 单一路径边界模块,统一 `realpath` 比对 + 扩展名约束 | 新模块 + 单测 |
| **P0** | `resolveTaskPath` 改用 `realpath` 后比对,消除 junction 逃逸 | 改 1896 行 |
| **P1** | 立 Code Review 硬规则:IPC handler 调用 `fs`/`path` 不得裸写,必须经 `safePaths.*` | PR 模板条目 |
| **P1** | 为 `safe-paths.js` 补 junction/symlink 逃逸单测(见示例) | 测试文件 |
| **P2** | `preload.js` 每个暴露 API 标注信任等级(renderer 可控 / 主进程受信),评审时核对 | 注释规范 |

---

## 5. 示例修复代码(草案,未落库)

### 5.1 新增 `safe-paths.js`(单一事实源)

```js
// safe-paths.js —— 主进程唯一路径边界事实源
const fs = require("node:fs");
const path = require("node:path");

const TASKS_ROOT = path.resolve(downloadRoot, "tasks"); // downloadRoot 来自 main.js

// 统一 realpath 解析后比对,杜绝 Windows junction / symlink 逃逸
function resolveWithin(root, candidate, { extensions } = {}) {
  const raw = String(candidate || "").trim();
  if (!raw) return null;
  let resolved;
  try {
    resolved = fs.realpathSync(raw);                 // 跟随 junction/symlink 到真实目标
  } catch {
    return null;                                      // 不存在/不可达 → 拒绝
  }
  if (extensions && !extensions.includes(path.extname(resolved).toLowerCase())) return null;
  const normalizedRoot = fs.realpathSync(root);       // root 也 realpath,避免自身被绕
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
}

module.exports = {
  taskFile: (c) => resolveWithin(TASKS_ROOT, c),
  todoFile: (c) => resolveWithin(TASKS_ROOT, c, { extensions: [".txt"] }),
  uploadFile: (c, taskFolder) => resolveWithin(taskFolder, c),
  desktopApp: (c) => isApprovedDesktopAppPath(c),     // 复用现有 allowlist 逻辑
};
```

### 5.2 改造 `resolveTaskPath`(消除 junction 逃逸)

```js
// main.js —— 改为复用单一模块,不再自行做字符串前缀
const safePaths = require("./safe-paths");
function resolveTaskPath(candidate) {
  return safePaths.taskFile(candidate); // 内部已 realpath 比对
}
```

### 5.3 单元测试示例(junction 逃逸必须失败)

```js
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { safePaths } = require("../safe-paths");

test("taskFile 拒绝 junction 越界到系统目录", () => {
  const evil = path.join(TASKS_ROOT, "evil-link");
  try { fs.symlinkSync("C:\\Windows\\System32", evil, "junction"); } catch {}
  assert.strictEqual(safePaths.taskFile(evil), null); // 若返回路径即逃逸漏洞
});

test("taskFile 允许 tasks 内合法文件", () => {
  const ok = path.join(TASKS_ROOT, "report.json");
  assert.strictEqual(typeof safePaths.taskFile(ok), "string");
});
```

---

## 6. 可直接贴进 PR 模板的资深 Review 清单

- [ ] 本 PR 新增/修改的 IPC handler 是否触碰 `fs`/`path`?若是,是否全部经过 `safePaths.*`?
- [ ] 任何 renderer 可控制的字符串路径,是否都经主进程 `realpath` 比对,而非字符串前缀?
- [ ] 写操作(删除/覆盖/覆盖写)是否有 allowlist 或 dialog 受信来源约束?
- [ ] 失败路径是否 fail-closed(默认拒绝),而非静默放行?
- [ ] 新增边界逻辑是否补了单元测试(含 junction/symlink 逃逸用例)?

---

## 7. 给团队技术负责人的建议(下一步)

本次审计验证了"对抗评审 → 修复"的闭环是健康的。下一步建议把闭环**前移一层**:
把评审结论沉淀为(1)共享代码原语 + (2)PR 硬规则 + (3)单测,让 junior 在写代码时
就被"护栏"保护,而不是等资深在评审里兜底。这才是可持续的团队技术能力提升。

如需我直接落地 `safe-paths.js` 并改造 `main.js` 的 5 处调用,请切换到"认领修复"模式,我可
在 1 个 commit 内完成并附带单测。
