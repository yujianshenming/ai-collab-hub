# Issue Tracker: Local Markdown

Issues in this repository are managed locally using markdown files in the `tasks/` directory, following the `PROTOCOL.md` specifications.

## Files
- `tasks/todo.md`: Backlog of tasks waiting to be started.
- `tasks/active.md`: Tasks currently in progress.
- `tasks/done.md`: Completed tasks.

## Format of Tasks
Each task in the files is defined by a level 2 heading (`## [Task-NNN] Title`) and includes:
- `### Owner`: Who is responsible (Antigravity / Codex / User)
- `### Context`: Background of the task
- `### Goal`: Expected output/success criteria
- `### Result` (only for `done.md`): Output and changes summary

## Creating a Task
When creating a task:
1. Generate the task details.
2. Insert it into `tasks/todo.md`.
3. If it starts immediately, move it to `tasks/active.md`.

## Updating Task Status
To change a task status, move its entire block (from `## [Task-NNN]` to the end of its section) from one file to another (e.g., from `tasks/todo.md` to `tasks/active.md` when started, or `tasks/active.md` to `tasks/done.md` when completed, appending the `### Result` section).
