# AI Collaboration Protocol

> 用途：让生活电脑、工作电脑上的 Codex 与 Antigravity 通过同一个 GitHub 仓库协同工作。
>
> 推荐模式：Antigravity 负责方案、分析、规划；Codex 负责读取方案、修改代码、运行命令、验证结果；GitHub 仓库作为共享记忆、任务队列和交接区。

## 1. 核心目标

我有两台电脑：

- 生活电脑
- 工作电脑

每台电脑上都有：

- Codex
- Antigravity

目标是让这四个 AI 实例通过一个 GitHub 仓库协同工作。它们不需要直接控制彼此，而是通过仓库中的 Markdown 文件、任务文件、状态文件、交接记录来通信。

理想分工：

- Antigravity：产品经理、架构师、研究员、方案生成者
- Codex：工程师、执行者、调试者、测试者、GitHub 操作者
- GitHub：共享记忆、任务队列、交接记录、决策日志

## 2. 重要原则

不要把应用的内部配置目录当作主要通信协议。

例如 Antigravity 的配置目录可能包含数据库、缓存、内部状态文件，适合备份，但不适合稳定协作。真正用于协作的内容应该是明确的人类可读文件，例如 Markdown、JSON、日志、任务清单。

推荐创建一个单独的 GitHub 仓库，例如：

```text
ai-collab-hub
```

或者：

```text
agent-workbench
```

这个仓库专门用于四个 AI 实例共享任务、方案、状态、交接记录。

## 3. 推荐仓库结构

```text
ai-collab-hub/
  README.md
  PROTOCOL.md
  status/
    current.md
  inbox/
    from-user.md
    from-antigravity.md
    from-codex.md
  tasks/
    todo.md
    active.md
    done.md
  handoff/
    antigravity-to-codex.md
    codex-to-antigravity.md
    home-to-work.md
    work-to-home.md
  artifacts/
    specs/
    research/
    designs/
    logs/
  decisions/
    architecture-decisions.md
  archive/
```

各目录含义：

- `status/current.md`：当前整体状态，所有实例开始工作前先读这里。
- `inbox/`：外部输入区。用户、Antigravity、Codex 可以把新想法放这里。
- `tasks/`：任务管理区。记录待办、进行中、已完成。
- `handoff/`：交接区。一个 AI 把工作交给另一个 AI 时写这里。
- `artifacts/`：产物区。方案、研究、设计、日志都放这里。
- `decisions/`：决策记录区。重要架构选择、取舍和原因写这里。
- `archive/`：归档区。过期任务和历史交接移到这里。

## 4. 固定工作流程

### 4.1 开始工作前

任何实例开始工作前，先执行：

```powershell
git pull origin master
```

然后按顺序阅读：

1. `status/current.md`
2. `tasks/active.md`
3. `handoff/` 中与自己相关的文件
4. `inbox/` 中的新输入

### 4.2 Antigravity 的工作方式

Antigravity 主要负责：

- 分析需求
- 拆分任务
- 设计方案
- 写规格说明
- 提出实现路径
- 审查 Codex 的执行结果
- 发现遗漏和风险

Antigravity 完成方案后，应写入：

```text
handoff/antigravity-to-codex.md
```

如果是长期方案或规格，应写入：

```text
artifacts/specs/
artifacts/research/
artifacts/designs/
```

### 4.3 Codex 的工作方式

Codex 主要负责：

- 读取 Antigravity 的方案
- 检查本地代码仓库
- 修改文件
- 运行命令和测试
- 创建提交或 PR
- 写执行结果
- 标记阻塞点

Codex 完成执行后，应写入：

```text
handoff/codex-to-antigravity.md
```

如果有测试日志、错误日志、实现说明，应写入：

```text
artifacts/logs/
```

### 4.4 结束工作后

任何实例完成工作后，执行：

```powershell
git add .
git commit -m "Collab update: yyyy-MM-dd HH:mm"
git push origin master
```

如果没有实际变化，可以不提交，但要明确说明“没有文件变化”。

## 5. 任务格式

每个任务建议使用以下格式：

```markdown
# Task: 简短标题

## Owner
Antigravity / Codex / User

## Status
todo / active / blocked / done

## Context
背景信息。

## Goal
这次任务要达成什么结果。

## Requirements
- 要求 1
- 要求 2
- 要求 3

## Plan
1. 第一步
2. 第二步
3. 第三步

## Result
完成后填写结果。

## Blockers
如果有阻塞，写清楚。

## Next Handoff
下一步交给谁，以及需要对方做什么。
```

## 6. 交接格式

每次从一个 AI 交接给另一个 AI，使用以下格式：

```markdown
# Handoff: 来源 -> 目标

## Date
yyyy-MM-dd HH:mm

## From
Antigravity / Codex / User

## To
Antigravity / Codex / User

## Summary
一句话说明这次交接的核心内容。

## Current State
现在已经完成了什么。

## Important Files
- path/to/file
- path/to/another-file

## Decisions Made
- 决策 1：原因
- 决策 2：原因

## Open Questions
- 问题 1
- 问题 2

## Requested Next Action
请目标 AI 下一步具体做什么。
```

## 7. 状态文件格式

`status/current.md` 应始终保持简洁，推荐格式：

```markdown
# Current Status

## Active Goal
当前最重要的目标。

## Current Owner
当前主要执行者：User / Antigravity / Codex

## Last Updated
yyyy-MM-dd HH:mm

## Latest Summary
最近一次进展摘要。

## Next Step
下一步应该做什么。

## Known Risks
- 风险 1
- 风险 2
```

## 8. 多电脑同步规则

生活电脑和工作电脑都使用同一个 GitHub 仓库。

每台电脑开始工作前：

```powershell
git pull origin master
```

每台电脑结束工作后：

```powershell
git add .
git commit -m "Collab update: yyyy-MM-dd HH:mm"
git push origin master
```

如果遇到冲突：

1. 不要随便覆盖文件。
2. 先保留双方内容。
3. 把冲突写入 `status/current.md` 或 `tasks/active.md`。
4. 让 Codex 或用户解决冲突。

## 9. 给 Antigravity 的启动提示词

可以直接把下面这段发给 Antigravity：

```text
你现在要参与一个多 AI 协作系统。我们会通过一个 GitHub 仓库进行通信，而不是直接控制彼此。

你的主要角色是：产品经理、架构师、研究员、方案生成者。

请遵守以下规则：

1. 开始前先读取协作仓库中的 status/current.md、tasks/active.md、handoff/ 和 inbox/。
2. 你负责把需求分析清楚，拆成可执行任务，并写出方案。
3. 需要 Codex 执行的内容，请写入 handoff/antigravity-to-codex.md。
4. 长期方案、规格、研究、设计分别写入 artifacts/specs/、artifacts/research/、artifacts/designs/。
5. 重要决策写入 decisions/architecture-decisions.md。
6. 每次完成工作后，更新 status/current.md。
7. 不要依赖应用内部配置目录作为主要通信方式，优先使用 Markdown 文件。

推荐交接格式：

# Handoff: Antigravity -> Codex

## Date
yyyy-MM-dd HH:mm

## Summary
一句话总结。

## Current State
现在已经明确了什么。

## Requested Next Action
请 Codex 具体执行什么。

## Important Files
涉及哪些文件。

## Open Questions
还有哪些问题。
```

## 10. 给 Codex 的启动提示词

可以直接把下面这段发给 Codex：

```text
你现在要参与一个多 AI 协作系统。我们会通过一个 GitHub 仓库进行通信，而不是直接控制彼此。

你的主要角色是：工程师、执行者、调试者、测试者、GitHub 操作者。

请遵守以下规则：

1. 开始前先 git pull origin master。
2. 阅读 status/current.md、tasks/active.md、handoff/antigravity-to-codex.md 和 inbox/。
3. 如果 Antigravity 给出了方案，请判断它是否可执行，并在本地代码仓库中实施。
4. 执行前先阅读相关代码，不要盲目修改。
5. 修改后尽量运行测试、lint 或最相关的验证命令。
6. 执行结果写入 handoff/codex-to-antigravity.md。
7. 日志、错误、测试结果写入 artifacts/logs/。
8. 更新 status/current.md。
9. 完成后 git add、commit、push。
10. 如果遇到冲突或不确定事项，不要强行覆盖，写清楚阻塞点。

推荐交接格式：

# Handoff: Codex -> Antigravity

## Date
yyyy-MM-dd HH:mm

## Summary
一句话总结。

## Implemented
完成了什么。

## Verification
运行了什么测试或检查，结果如何。

## Changed Files
改了哪些文件。

## Blockers
有什么阻塞。

## Requested Next Action
请 Antigravity 下一步分析或补充什么。
```

## 11. 用户的推荐使用方式

当你想开始一个新任务时：

1. 把想法写给 Antigravity。
2. 让 Antigravity 把方案写入 `handoff/antigravity-to-codex.md`。
3. 打开 Codex，让 Codex 拉取仓库并执行方案。
4. Codex 执行完后，把结果写入 `handoff/codex-to-antigravity.md`。
5. 再让 Antigravity 审查结果，继续规划下一步。

当你从生活电脑切到工作电脑时：

1. 在当前电脑结束前 push。
2. 到另一台电脑开始前 pull。
3. 先读 `status/current.md`。
4. 继续处理 `tasks/active.md` 中的任务。

## 12. 最重要的一句话

四个 AI 实例不要试图直接共享“脑子”，而是共享清晰、可读、可追踪的工作记录。GitHub 仓库就是它们共同的白板、任务板和交接本。
