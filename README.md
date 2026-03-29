# pi-squad

Multi-agent collaboration extension for [pi](https://github.com/badlogic/pi-mono). Decomposes complex tasks into subtasks, assigns specialist agents, manages dependencies, runs them in parallel with automatic QA rework loops — all with a live TUI widget, overlay panel, and slash commands.

## Install

```bash
# From npm
pi install npm:pi-squad

# Or symlink for development
ln -sf /path/to/pi-squad/src ~/.pi/agent/extensions/squad
```

Pi auto-discovers extensions on startup. No build step required.

## Quick Start

Ask pi to do something complex. It calls the `squad` tool automatically:

```
> Build a REST API with authentication, tests, and documentation
```

Or be explicit with predefined tasks:

```
> Use squad: goal="Build task API", tasks=[
    {id: "api", title: "Build CRUD endpoints with express", agent: "backend"},
    {id: "tests", title: "Write tests", agent: "qa", depends: ["api"]},
    {id: "docs", title: "Write README", agent: "docs", depends: ["api"]}
  ]
```

### What Happens

1. Extension creates tasks and starts the scheduler
2. A **live widget** appears above the editor showing task status
3. Agents spawn as separate pi processes, work in parallel where dependencies allow
4. QA agents can trigger **automatic rework loops** when they find bugs
5. When complete, pi reports the summary with costs

## User Interface

### Widget (above editor)

Always visible when a squad is active. Component-based, event-driven rendering — updates on every scheduler event with no polling.

```
⏳ squad Build task API 2/3 $0.58 3m12s  ^q detail · /squad msg
  ✓ api (backend) 2m12s Created CRUD REST API with validation
  ⏳ tests (qa) 45s → bash npm test
  ◻ docs (docs) ← api
```

Features:
- Per-task elapsed time (warning color after 3 minutes)
- Live tool call preview for running tasks
- Stale detection — shows `⏳ idle` when agent has no output for 2+ minutes
- Responsive — caps visible tasks based on terminal height
- Completion duration for finished tasks

### Status Bar (footer)

```
⏳ squad 2/3 $0.58
```

### Panel (Ctrl+Q)

Centered overlay panel. Press `Ctrl+Q` to open/close.

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
│ 2/3 · $0.58 · 3m                            │
├──────────────────────────────────────────────┤
│ ↑↓ nav  ⏎ msgs  m send  p pause  ^q close  │
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
│ ↑↓ scroll  m send  esc back  ^q close       │
╰──────────────────────────────────────────────╯
```

## Commands

| Command | Description |
|---|---|
| `/squad` or `/squad select` | Pick a squad to view (interactive selector) |
| `/squad list` | List squads for current project |
| `/squad all` | List all squads across all projects |
| `/squad agents` | List, view, edit, enable/disable agents |
| `/squad agents <name>` | Quick view of a specific agent |
| `/squad msg [agent] text` | Send message to a running agent |
| `/squad widget` | Toggle live widget |
| `/squad panel` | Toggle overlay panel |
| `/squad cancel` | Cancel running squad |
| `/squad clear` | Dismiss widget, deactivate view |

## Keyboard Shortcuts

| Key | Context | Action |
|---|---|---|
| `Ctrl+Q` | Anywhere | Toggle squad panel overlay |
| `↑↓` or `jk` | Panel | Navigate tasks / scroll messages |
| `Enter` | Panel task list | View task messages |
| `Esc` | Panel message view | Back to task list |
| `m` | Panel | Send message to selected task's agent |
| `p` | Panel task list | Pause/resume task |
| `x` | Panel task list | Cancel task |
| `q` | Panel task list | Close panel |

## Tools (LLM-callable)

| Tool | Description |
|---|---|
| `squad` | Start a squad (non-blocking, returns immediately) |
| `squad_status` | Check progress, costs, task states |
| `squad_message` | Send message to a running agent via `steer()` |
| `squad_modify` | Add/cancel/pause/resume tasks, or cancel/resume entire squad |

The main pi agent sees squad state in its system prompt automatically (`<squad_status>` block) and can relay messages, add tasks, or check status on your behalf.

## QA Rework Loop

When a QA agent outputs `## Verdict: FAIL`, the scheduler automatically:

1. **Parses** the failure details from QA output
2. **Creates a rework task** for the original agent with QA feedback injected into its system prompt
3. **Creates a retest task** for QA, blocked until the rework completes
4. After fix, QA re-tests. If still failing, loops up to `maxRetries` (default: 2)
5. If retry limit exceeded, **escalates** to the main agent for human decision

### Example flow

```
auth (backend) ✓
  → qa-auth (qa) ✓ — found race condition bug
    → auth-fix-1 (backend) ✓ — fixed it [auto-created]
      → qa-auth-retest-1 (qa) ✓ — retested, found another issue
        → auth-fix-2 (backend) ✓ — fixed again [auto-created]
          → qa-auth-retest-2 (qa) ✓ — all tests pass ✓
```

### What the rework agent sees

The rework agent's system prompt includes:
- Original task output (what was built)
- QA feedback (what failed, with specific issues)
- Instructions to make targeted fixes, not rewrite everything

### QA verdict format

QA agents should end their output with a structured verdict:

```markdown
## Verdict: PASS
All 42 tests passing. No issues found.
```

```markdown
## Verdict: FAIL

## Issues
1. **[src/auth.ts:45]** JWT expiry not enforced
   - Expected: 401 for expired tokens
   - Got: 200 (token accepted)
2. **[src/routes.ts:23]** Missing rate limit on /login
```

### Configuration

```
config: {
  maxConcurrency: 3,  // parallel agents
  maxRetries: 2,      // rework attempts before escalation (default: 2)
}
```

## Sending Messages to Agents

Three ways:

1. **`/squad msg`** — type in the main editor
   ```
   /squad msg Use postgres instead of SQLite
   /squad msg backend Use postgres instead of SQLite
   ```

2. **`m` key** — press in the panel, opens input dialog

3. **Natural chat** — tell pi, it relays automatically
   ```
   > Tell the backend agent to use argon2 for password hashing
   ```

Messages are delivered in real-time via RPC `steer()` if the agent is running, or queued for delivery when the agent spawns.

## Agents

### 11 Bundled Agents

On first run, copied to `~/.pi/squad/agents/` for editing.

| Agent | Specialty | Tags |
|---|---|---|
| **planner** | Task breakdown and planning | planning, architecture |
| **fullstack** | General-purpose coding | general, coding |
| **architect** | System design, architecture | architecture, design |
| **backend** | APIs, databases, server-side | api, server, database |
| **frontend** | UI/UX, React, CSS | react, ui, css |
| **debugger** | Root cause analysis | debugging, bugs |
| **qa** | Testing, verification | testing, qa, e2e |
| **security** | Security audits | security, audit |
| **docs** | Technical writing | documentation, readme |
| **researcher** | Code exploration, analysis | research, analysis |
| **devops** | CI/CD, infrastructure | ci-cd, docker |

### Agent Management

Use `/squad agents` for interactive management:

```
/squad agents              — list all, select to view/edit
/squad agents backend      — quick view of specific agent
```

Actions available per agent:
- **View details** — name, role, model, tools, tags, prompt, file path
- **Edit in editor** — opens the agent JSON file
- **Change model** — set a specific model or use default
- **Toggle tools** — restrict to specific tools or enable all
- **Enable/Disable** — disabled agents are hidden from the planner

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
  "prompt": "You are an ML engineer specializing in PyTorch...",
  "disabled": false
}
```

- `model`: `null` = pi default. Override with any model ID your provider supports.
- `tools`: `null` = all tools. Array like `["bash", "read", "write", "edit"]` to restrict.
- `tags`: Used by the planner to match agents to tasks.
- `disabled`: `true` = hidden from planner, tasks assigned to this agent will fail.
- Project-local agents override global agents with the same name.

## How Agents Collaborate

### Chain Context (primary)

When task A completes, its **full output** is injected into task B's system prompt as a `# Completed Dependencies` section. Downstream agents read what was built and extend it.

### Shared Filesystem

All agents work in the same project directory. Upstream agents create files, downstream agents read and modify them. Each agent is instructed to read files before writing to avoid conflicts.

### Sibling Awareness

When agents run in parallel, each sees the other's status and modified files in their system prompt:

```
# Sibling Tasks
- template-engine [in_progress] — fullstack — Create HTML templates
  
## Files Modified by Other Agents
**fullstack:** src/templateEngine.js, templates/post.html
⚠️ Coordinate with the owning agent before editing files listed above.
```

### @Mention Routing

Agents can message each other in real-time:

```
Agent output: "@frontend what token format do you need?"
→ Router parses @mention
→ Delivers to running agent via steer()
→ Or queues for delivery when agent spawns
```

### Block Detection

If an agent says "I'm blocked" or "cannot proceed", the router detects it and escalates to the main agent.

## Session Resilience

### Crash Recovery

When a pi session crashes (tmux dies, SIGKILL, etc.):
- In-progress tasks are automatically **suspended** on next startup
- Squad is marked as **paused**
- Only squads with completed tasks trigger a notification

### Resume

Resume a paused squad across sessions:

```
> Resume the squad
```

The agent calls `squad_modify({ action: "resume" })`, which:
1. Finds the latest paused squad for the project
2. Creates a fresh scheduler from disk state
3. Restarts suspended tasks

All state lives on disk — squads are fully reconstructable.

## Governance

| Mechanism | What it does |
|---|---|
| **Dependency DAG** | Blocked tasks never spawn. Auto-unblock when deps complete. |
| **Concurrency control** | `maxConcurrency` limits parallel agents (default: 2) |
| **Health monitoring** | Idle warning (3m), stuck intervention (5m), loop detection (same tool 5x), 30m hard ceiling |
| **QA rework loop** | Auto-creates fix + retest tasks when QA fails (up to `maxRetries`) |
| **File tracking** | Warns agents about files modified by other agents |
| **@mention routing** | Parsed from output, delivered via RPC `steer()` |
| **Escalation** | Blocked agents, stuck agents, and retry limit → notify main agent |

## Data Layout

All state lives in `~/.pi/squad/`. No database, no daemon, no external services. Writes are atomic (temp file + rename).

```
~/.pi/squad/
├── agents/                    — agent definitions (user-editable)
│   ├── backend.json
│   ├── qa.json
│   └── ...
└── {squad-id}/                — one directory per squad
    ├── squad.json             — goal, status, config, cwd
    ├── context.json           — live state snapshot
    ├── knowledge/             — shared decisions/findings
    │   ├── decisions.jsonl
    │   └── findings.jsonl
    └── {task-id}/             — one directory per task
        ├── task.json          — status, agent, output, usage
        └── messages.jsonl     — full conversation log
```

## Architecture

```
src/
├── index.ts              — extension entry: tools, commands, widget, panel, lifecycle
├── types.ts              — Squad, Task, Agent, Message types
├── store.ts              — JSON/JSONL file I/O with atomic writes
├── scheduler.ts          — dependency DAG, concurrency, rework loop, task lifecycle
├── agent-pool.ts         — pi RPC process spawn/steer/kill
├── protocol.ts           — system prompt builder (7 sections)
├── router.ts             — @mention parsing, cross-agent messaging
├── monitor.ts            — health checks: idle/stuck/loop/ceiling
├── supervisor.ts         — quality review, block analysis
├── planner.ts            — one-shot goal decomposition via LLM
├── panel/
│   ├── squad-panel.ts    — overlay component (ctx.ui.custom with done())
│   ├── squad-widget.ts   — component-based widget (setWidget factory)
│   ├── task-list.ts      — task tree with status icons, elapsed time
│   └── message-view.ts   — scrollable message log per task
├── skills/
│   ├── supervisor/       — teaches main agent to supervise squads
│   ├── squad-protocol/   — communication rules for child agents
│   ├── collaboration/    — team interaction patterns
│   └── verification/     — verify-before-done + structured verdicts
└── agents/_defaults/     — 11 bundled agent definitions
```

## Test Results

### Simple (3 tasks, linear chain)
- URL shortener API: 3 tasks, $0.83, 4.5 minutes
- Backend → QA → Docs, all passing

### Medium (6 tasks, diamond dependency)
- Static blog engine: 6 tasks, $4.56, 24 minutes
- Markdown parser → HTML converter → site generator → Express server → QA + Docs
- 87+ tests passing

### Complex (5 original + 4 auto-rework = 9 tasks)
- Chat API with auth + rooms: 9 tasks, $4.60, 26 minutes
- QA found 2 bugs → 2 automatic rework cycles → both fixed and verified
- 176 turns across 5 specialist agents

## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent
- An API key configured in pi (Anthropic, OpenRouter, etc.)
- Node.js 18+

## License

MIT
