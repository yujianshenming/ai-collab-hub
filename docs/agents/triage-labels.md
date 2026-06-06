# Triage Labels Mapping

Because this repository uses a local file-based task board (`tasks/todo.md`, `tasks/active.md`, `tasks/done.md`), triage states map directly to file locations rather than GitHub labels.

## Label-to-File Mapping
- `needs-triage`: The task is written to the top of `tasks/todo.md` with Owner `User` or `Pending` for evaluation.
- `needs-info`: The task is written in `tasks/todo.md` with Owner `User` or left in the inbox `inbox/from-user.md` for user clarification.
- `ready-for-agent`: The task is in `tasks/todo.md` with Owner `Codex` or `Antigravity`, fully specified and ready to be picked up.
- `ready-for-human`: The task is in `tasks/todo.md` with Owner `User`.
- `wontfix`: The task is moved to `archive/wontfix.md` (or simply removed/archived).

## State Transitions
To change state:
- **Triage Start**: Move task to `tasks/active.md`.
- **Triage Complete**: Move task to `tasks/done.md` and write the `### Result` section.
