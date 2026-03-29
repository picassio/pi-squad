# pi-squad

Multi-agent collaboration extension for [pi](https://github.com/badlogic/pi-mono). Decomposes complex tasks into subtasks, assigns specialist agents, manages dependencies, and runs them in parallel — with a live TUI widget, side panel, and full slash command interface.

## Install

```bash
# From npm
pi install npm:pi-squad

# Or symlink for development
ln -sf /path/to/pi-squad/src ~/.pi/agent/extensions/squad
```

Pi auto-discovers extensions on startup. No build step.

## Quick Start

Ask pi to do something complex. It calls the `squad` tool automatically:

```
> Build a REST API with authentication, tests, and documentation
```

Or be explicit:

```
> Use squad: goal="Build task API", tasks=[
    {id: "api", title: "Build CRUD endpoints with express", agent: "backend"},
    {id: "tests", title: "Write tests", agent: "qa", depends: ["api"]},
    {id: "docs", title: "Write README", agent: "docs", depends: ["api"]}
  ]
```

### What Happens

1. Extension creates tasks, starts the scheduler
2. A **live widget** appears above the editor showing task status
3. Agents spawn as separate pi processes, work in parallel where deps allow
4. When complete, pi reports the summary

## User Interface

### Widget (above editor)

Always visible when a squad is active. Updates every 2 seconds.

```
⏳ squad Build task API 1/3 $0.58 3m12s  ctrl+q panel · /squad
  ✓ api (backend) Created CRUD REST API with validation
  ⏳ tests (qa) → bash npm test
  ◻ docs (docs) ← api
```

### Status Bar (footer)

```
⏳ squad 1/3 $0.58
```

### Panel (Ctrl+Q)

Side panel on wide screens, centered overlay on narrow screens. Press `Ctrl+Q` to toggle focus between the panel and the editor.

**Task list:**
```
╭─ squad: Build task API ─────────────────────╮
│ ▸ ✓ api (backend) 2m12s                     │
│   ⏳ tests (qa) 45s                         │
│   ◻ docs (docs) blocked                     │
│                                              │
│ ── tests (live) ─────────────────────        │
│ → bash npm test                              │
│                                              │
│ 1/3 · $0.58 · 3m                            │
├──────────────────────────────────────────────┤
│ ↑↓ nav  ⏎ msgs  m send  p pause  ^q switch │
╰──────────────────────────────────────────────╯
```

**Message view** (Enter on a task):
```
╭─ tests · qa ⏳ ─────────────────────────────╮
│ 10:03 qa                                     │
│   Starting test implementation               │
│ 10:04 qa                                     │
│   → write src/tasks.test.js                  │
│ 10:05 YOU                                    │
│   Also test edge cases for empty input       │
├──────────────────────────────────────────────┤
│ ↑↓ scroll  m send  esc back  ^q switch      │
╰──────────────────────────────────────────────╯
```

## Commands

| Command | Description |
|---|---|
| `/squad` or `/squad select` | Pick a squad to view (interactive selector) |
| `/squad list` | List squads for current project |
| `/squad all` | List all squads across all projects |
| `/squad msg [agent] text` | Send message to a running agent |
| `/squad widget` | Toggle live widget |
| `/squad panel` | Toggle overlay panel |
| `/squad cancel` | Cancel running squad |
| `/squad clear` | Dismiss widget, deactivate view |

## Keyboard Shortcuts

| Key | Context | Action |
|---|---|---|
| `Ctrl+Q` | Main editor | Open/focus squad panel |
| `Ctrl+Q` | Panel focused (wide) | Return focus to editor (panel stays visible) |
| `Ctrl+Q` | Panel focused (narrow) | Hide panel |
| `↑↓` | Panel | Navigate tasks / scroll messages |
| `Enter` | Panel task list | View task messages |
| `Esc` | Panel message view | Back to task list |
| `m` | Panel | Send message to selected task's agent |
| `p` | Panel task list | Pause/resume task |
| `x` | Panel task list | Cancel task |
| `q` | Panel task list | Release focus / hide |

## Tools (LLM-callable)

| Tool | Description |
|---|---|
| `squad` | Start a squad (non-blocking, returns immediately) |
| `squad_status` | Check progress, filtered by project |
| `squad_message` | Send message to a running agent via `steer()` |
| `squad_modify` | Add/remove/pause/resume/cancel tasks |

The main pi agent sees squad state in its system prompt automatically and can relay messages, add tasks, or check status on your behalf.

## Sending Messages to Agents

Three ways:

1. **`/squad msg`** — type in the main editor
   ```
   /squad msg Use postgres instead of SQLite
   /squad msg backend Use postgres instead of SQLite
   ```

2. **`m` key** — press in the panel (task list or message view), opens input dialog

3. **Natural chat** — tell pi, it relays automatically
   ```
   > Tell the backend agent to use argon2 for password hashing
   ```

## Agents

11 specialist agents are bundled. On first run, they're copied to `~/.pi/squad/agents/` for editing.

| Agent | Specialty |
|---|---|
| **planner** | Task breakdown and planning |
| **fullstack** | General-purpose coding |
| **architect** | System design, architecture |
| **backend** | APIs, databases, server-side |
| **frontend** | UI/UX, React, CSS |
| **debugger** | Root cause analysis |
| **qa** | Testing, verification |
| **security** | Security audits |
| **docs** | Technical writing |
| **researcher** | Code exploration, analysis |
| **devops** | CI/CD, infrastructure |

### Custom Agents

Create a JSON file in `~/.pi/squad/agents/` (global) or `{project}/.pi/squad/agents/` (project override):

```json
{
  "name": "ml-engineer",
  "role": "ML Engineer",
  "description": "Machine learning, PyTorch, data pipelines",
  "model": "anthropic/claude-sonnet-4-20250514",
  "tools": null,
  "tags": ["ml", "pytorch", "data"],
  "prompt": "You are an ML engineer specializing in PyTorch..."
}
```

Project-local agents override global agents with the same name.

## How Agents Collaborate

- **Dependencies** — task B waits for task A before starting
- **Chain context** — task A's output is injected into task B's system prompt
- **@mentions** — agents write `@agentname message` to talk to each other in real time
- **Human messages** — sent via panel, `/squad msg`, or the LLM's `squad_message` tool
- **Shared knowledge** — decisions and findings tracked in `knowledge/*.jsonl`

## Data

All state lives in `~/.pi/squad/` (global). No database, no daemon, no external services.

```
~/.pi/squad/
├── agents/*.json              — global agent definitions
└── {squad-id}/
    ├── squad.json             — metadata (goal, status, cwd, agents, config)
    ├── context.json           — live state snapshot
    └── {task-id}/
        ├── task.json          — task metadata + output
        └── messages.jsonl     — conversation log
```

Each squad stores its project `cwd` in `squad.json`. The `/squad list` command filters by current project. `/squad all` shows everything.

Project-local agent overrides: `{project}/.pi/squad/agents/`

## Multi-Project Support

Squads are stored globally but scoped to projects by their `cwd` field. Multiple pi sessions can run squads for different projects simultaneously.

```
Session A (cwd: /projects/api)      Session B (cwd: /projects/web)
  └── squad "build-auth"              └── squad "build-dashboard"
      both stored in ~/.pi/squad/
      filtered by cwd when listing
```

`/squad list` shows squads for the current project. `/squad all` shows all projects.

Any pi session can browse and view any squad with `/squad select` or `/squad all`.

## Governance

- **Dependency enforcement** — blocked tasks never spawn, auto-unblock when deps complete
- **Concurrency control** — configurable `maxConcurrency` (default: 2)
- **Health monitoring** — idle warning (3m), stuck intervention (5m), loop detection, 30m hard ceiling
- **@mention routing** — parsed from agent output, delivered via RPC `steer()`
- **File conflict tracking** — warns agents about files modified by others

## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent
- An API key configured in pi (Anthropic, OpenRouter, etc.)

## License

MIT
