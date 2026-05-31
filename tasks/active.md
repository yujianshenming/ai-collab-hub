# Active Tasks

## [Task-002] Setup and Automate Antigravity IDE Configuration Sync

### Owner
Codex

### Status
active

### Context
根据 `e:\antigravity_sync_instructions.md` 手册，需要实现多台电脑间 Antigravity IDE 配置文件夹（`C:\Users\<Username>\.gemini\antigravity`）的 Git 同步。

### Goal
在 Codex 运行的新机器上初始化配置同步，并编写自动化脚本以安全地拉取和推送配置状态（需检查并确保 IDE 已关闭）。

### Requirements
1. **环境检测**：使用 `whoami` 确定当前 Windows 用户名，定位配置目录 `C:\Users\<Username>\.gemini\antigravity`。
2. **备份现有数据**：如配置目录已存在文件且未包含 `.git`，需将已有文件移动到临时备份目录以清空该目录。
3. **初始化仓库**：在配置目录中初始化 Git，添加远程仓库 `https://github.com/yujianshenming/antigravity-config.git`，拉取并切换至 `master` 分支。
4. **自动化脚本编写**：在 `ai-collab-hub`（即本仓库根目录）中提供两个 PowerShell 脚本：
   * `sync_pull.ps1`：用于拉取最新配置。执行前检查 IDE 是否正在运行，如运行则提示并中止，否则执行 `git pull`。
   * `sync_push.ps1`：用于推送当前配置。执行前检查 IDE 是否正在运行，如运行则提示并中止，否则执行 `git add .`、带有当前时间戳的 `git commit` 以及 `git push`。
5. **进程检测逻辑**：由于 Antigravity 运行在 Gemini 平台，需检测是否存在 `antigravity` 相关的进程，或通过文件锁检测占用。

### Plan
1. Codex 在目标机器上通过 `whoami` 定位路径，执行备份。
2. 初始化 Git 并 checkout `master` 分支以完成初次同步。
3. 编写 `sync_pull.ps1` 与 `sync_push.ps1` 脚本，加入进程占用判断。
4. 在本仓库提交脚本并更新状态。

### Result
*等待 Codex 执行完成并填写*

### Blockers
暂无。

### Next Handoff
Codex -> Antigravity (执行完毕，报告初始化状态与脚本存放路径)。
