# AI Collaboration Hub

AI Collaboration Hub is an open-source workspace protocol for coordinating multiple AI coding agents across machines, tools, and sessions.

It uses a plain GitHub repository as the shared memory layer: agents read and write Markdown files for status, tasks, handoffs, decisions, research notes, and implementation logs. The goal is to make AI-assisted work auditable, portable, and recoverable instead of trapped inside one local app session.

## Why This Exists

Modern AI coding workflows often involve more than one assistant:

- one agent researches and plans;
- another agent edits code and runs checks;
- work moves between a personal computer and a work computer;
- context needs to survive restarts, tool changes, and long gaps between sessions.

AI Collaboration Hub turns those loose interactions into a lightweight protocol. GitHub becomes the shared whiteboard, task queue, handoff notebook, and decision log.

## Core Ideas

- **Human-readable state**: important context lives in Markdown files, not hidden application caches.
- **Role-based collaboration**: planning, implementation, testing, and review can be handled by different agents.
- **Explicit handoffs**: every transfer of work records the current state, important files, decisions, blockers, and requested next action.
- **Multi-machine continuity**: work can move between computers with normal `git pull` and `git push`.
- **Chinese-first workflow**: the working protocol and user-facing system behavior are designed for Chinese-language daily use.

## Current Agent Roles

- **Antigravity** acts as product manager, architect, and researcher. It analyzes requirements, designs solutions, writes specs, and reviews results.
- **Codex** acts as developer, executor, tester, debugger, and GitHub operator. It implements changes, runs commands, verifies behavior, and records outcomes.
- **GitHub** acts as the durable coordination layer: shared memory, task board, handoff area, and decision history.

## Repository Structure

```text
ai-collab-hub/
  status/                 Current status, active goal, next step, known risks
  inbox/                  Incoming requests and notes from user or agents
  tasks/                  Todo, active, and completed work items
  handoff/                Agent-to-agent and machine-to-machine handoffs
  artifacts/              Specs, research, designs, logs, and generated outputs
  decisions/              Architecture decisions and important tradeoffs
  docs/agents/            Agent-facing documentation
  personal-workbench/     Main desktop workbench application track
  PROTOCOL.md             Full collaboration protocol
```

## Protocol Workflow

Every agent session follows the same basic loop:

1. Pull the latest repository state.
2. Read `status/current.md`, `tasks/active.md`, relevant `handoff/` files, and new `inbox/` entries.
3. Do the assigned planning, implementation, verification, or review work.
4. Record results in the appropriate task, handoff, artifact, or decision file.
5. Commit and push the updated shared state.

The full workflow is documented in [PROTOCOL.md](PROTOCOL.md).

## Personal Workbench Track

This repository also contains an active implementation track for a desktop personal workbench:

- persistent browser/webview tabs;
- local PowerShell terminal integration;
- task-driven workflow panels;
- file-bus automation for downloads, uploads, and task files;
- prompt and evaluation workflow support.

See [personal-workbench-roadmap.md](personal-workbench-roadmap.md) for the current roadmap and version plan.

## Quick Start

Clone the repository:

```powershell
git clone https://github.com/yujianshenming/ai-collab-hub.git
cd ai-collab-hub
```

Before starting a session:

```powershell
git pull origin master
```

Then read, in order:

1. `status/current.md`
2. `tasks/active.md`
3. files in `handoff/` that mention your agent, machine, or task
4. new files or notes in `inbox/`

After finishing meaningful work, update the relevant Markdown files and push:

```powershell
git add .
git commit -m "Collab update: yyyy-MM-dd HH:mm"
git push origin master
```

## Project Status

This project is early-stage but actively maintained. It currently serves as both:

- a real working coordination space for multi-agent AI-assisted development;
- a public reference implementation of a GitHub-backed agent collaboration protocol.

The long-term goal is to turn the protocol, templates, and workbench into reusable open-source building blocks for developers who want reliable AI agent collaboration across tools and machines.

## Contributing

Contributions are welcome, especially in these areas:

- clearer handoff and task templates;
- better examples for agent roles and workflows;
- improvements to the personal workbench;
- regression checklists and verification routines;
- documentation for real-world multi-agent collaboration patterns.

For now, open an issue or pull request with the problem, context, proposed change, and any verification you performed.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
