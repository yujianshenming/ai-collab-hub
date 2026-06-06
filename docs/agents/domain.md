# Domain Documentation

This repository uses a single-context domain model.

## Domain Files
- `PROTOCOL.md`: The main AI Collaboration Protocol document outlining directories, workflows, sync rules, and AI roles.
- `ai_collaboration_protocol.md`: Duplicate/archive of the main protocol.
- `decisions/`: Folder for recording architectural decisions.

## Rules for Agents
- Always read `PROTOCOL.md` and `status/current.md` at the beginning of a session to align on the current context.
- Before making significant architectural changes, consult the `decisions/` directory and record new decisions there.
- Prioritize simplicity: keep code concise, surgical, and aligned with Karpathy guidelines.
