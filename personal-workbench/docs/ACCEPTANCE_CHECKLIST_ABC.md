# Personal Workbench 本机验收清单（A / B / C）

> 对应提交：`167604d`（A）、`ca6f85d`（B）、`b283c57`（C）  
> 分支：`codex/personal-workbench-redesign`  
> 日期：2026-07-16  
> 文档状态：历史验收清单，用于复验 A/B/C；当前事实主文档仍以 [`PROJECT_HANDBOOK.md`](./PROJECT_HANDBOOK.md) 为准。2026-07-24 已同步当前测试与风险状态，清单中的 `[ ]` 是执行时检查项，不代表功能尚未实现。

## 0. 谁做什么

| 步骤 | 环境 |
|---|---|
| 恢复截断文件、清换行污染、修跨平台测试 | Cowork / 本机 git 均可 |
| `npm test`、打 tag、push | **本机 Code / PowerShell** |
| 启动应用、点 UI、企微粘贴、后台通知 | **本机 Windows** |

## 1. 机器检查（本机）

```powershell
cd C:\Users\24391\Documents\ai-collab-hub\personal-workbench
git status --short --branch
git log -5 --oneline
node --check main.js
node --check renderer.js
npm test
```

期望：

- 工作区干净，或仅有你明确知道的未提交改动
- `npm test` 全部通过
- 最近提交包含 A/B/C 三个 `feat:`

可选 E2E（较慢，会起多个 Electron）：

```powershell
npm run test:e2e
# 或单跑：
node tests/weekly-report.e2e.js
node tests/task-controls.e2e.js
```

启动：

```powershell
npm start
# 若 node-pty AttachConsole 失败：
Start-Process .\node_modules\.bin\electron.cmd -ArgumentList "." -WorkingDirectory (Get-Location)
```

## 2. 功能 A：周报历史 + 模板

- [ ] 打开「周报中心」
- [ ] 从任务生成 → 改姓名/标题/备注 → 保存草稿 → 状态为「已保存」
- [ ] 「已保存周次」列表出现当前周；点「上一周 / 下一周」可切换
- [ ] 切换到新周次时，新建草稿带默认姓名（若已设模板）
- [ ] 「存为默认」后，再开新周次草稿姓名正确；**已保存周报姓名不被覆盖**
- [ ] 再次「从任务生成」：手动备注仍在，toast 提示保留备注
- [ ] 复制周报 / 复制表格；导出 HTML / MD / DOCX 可选验一项
- [ ] 人工：粘贴到企业微信文档（完整周报与表格各一次）

## 3. 功能 B：搜索 / 筛选 / 归档

- [ ] 任务中心出现搜索框、状态 chips、学校下拉
- [ ] 搜索学校或课程关键字，列表只剩匹配项
- [ ] 点状态 chip（如「已暂停」），列表过滤正确
- [ ] **统计卡数字不随筛选变小**（仍是全局计数）
- [ ] 卡片菜单「归档」→ 默认列表消失
- [ ] chip「已归档」可见该任务；「取消归档」后回到默认列表
- [ ] 归档后 `chatLogPath` / `reportPath` / 文件夹仍在（打开产物文件夹可验）
- [ ] 「写回待做任务」不包含已归档任务（若你使用待做任务.txt）

## 4. 功能 C：产物徽章 + 报告通知

- [ ] 有对话/报告路径的任务卡显示「对话」「报告」徽章为 ready（可点）
- [ ] 任务文件夹放入 `cards.md` 后，回到任务中心或等文件夹变更，出现「卡片」ready
- [ ] 点 ready 徽章可打开文件（或打开文件夹）
- [ ] missing 徽章为 muted 且不可点
- [ ] **前台**：评估报告下载完成有 toast
- [ ] **后台**（窗口失焦）：系统通知「评估报告已就绪」（依赖 Windows 通知权限；专注助手可能拦截）
- [ ] 无活动任务时的普通下载**不会**弹出评估报告通知
- [ ] 已归档任务不强制刷徽章回扫

## 5. 安全与回归抽检

- [ ] 普通外网页 webview 控制台：`window.__workbenchSessionToken === undefined`
- [ ] 任务舱/扩展在常用路径无未捕获异常
- [ ] 分屏、终端开关仍可用（冒烟）

## 6. 验收通过后：打 tag（本机）

确认干净且测试绿：

```powershell
cd C:\Users\24391\Documents\ai-collab-hub
git status --short --branch
git log -3 --oneline -- personal-workbench/

# 建议 tag 名（可按当天日期调整）
git tag -a personal-workbench-stable-2026-07-16-abc -m "A weekly report history/templates; B task filter/archive; C artifact badges + report notifications"

# 查看
git show personal-workbench-stable-2026-07-16-abc --stat

# 若使用远程：
# git push origin codex/personal-workbench-redesign
# git push origin personal-workbench-stable-2026-07-16-abc
```

**不要**把 `tasks/weekly_tasks.json`、`temp/`、Cookie、扩展本机路径打进提交。

## 7. 已知非阻塞项

- 系统通知依赖 Windows 权限与专注助手；失败时仍有前台 toast。
- 企业微信粘贴策略由目标编辑器决定；表格复制是 HTML+TSV 尽力兼容。
- 扩展真机登录页、上传 CDP 边界仍见 `regression-checklist.md`，自动化无法全覆盖。
- 在 **Linux 沙箱** 跑路径穿越单测时，Windows 反斜杠向量需测试侧归一化（见 `security-v34-regression.test.js` 注释）；**Windows 本机生产路径逻辑不变**。

## 8. 失败时

1. 保存错误日志 / 截图与复现步骤  
2. **不要**为了变绿删除测试或放宽安全边界  
3. 对照 `PROJECT_HANDBOOK.md` §7 安全边界与 §8 测试要求  
4. 大文件编辑后立刻：`node --check main.js` / `node --check renderer.js`
