# pi-squad — Multi-Agent Collaboration Extension for Pi

A pi extension that enables multi-agent collaboration via a live widget, TUI side panel, and slash commands. Agents work on decomposed tasks with dependencies, communicate via @mentions, and share knowledge — all backed by JSON files on disk with no external services.

## Status

**Working end-to-end.** Tested with single-task and multi-task (3 agents, dependency chains, parallel execution) squads.

### Verified Working
- Extension loads cleanly, 4 tools + 1 slash command registered
- Agent bootstrapping (11 default agents copied to `.pi/squad/agents/`)
- Squad creation (squad.json, task.json, context.json, messages.jsonl)
- RPC agent spawning via `pi --mode rpc` with `--append-system-prompt`
- Agent event streaming (tool calls, text, usage tracking)
- Message logging to JSONL per task
- Pi RPC `agent_end` detection — kills RPC process, triggers completion
- Task completion with output extraction from agent messages
- Dependency chain: auto-unblock dependents when task completes
- Parallel execution: tasks without dep conflicts spawn simultaneously (maxConcurrency)
- Squad completion detection: all tasks done → squad done, followUp notification
- `squad_status` reads from disk when scheduler is cleared (works after completion)
- `sendUserMessage(followUp)` delivers completion/failure/escalation to main agent
- `PI_SQUAD_CHILD=1` prevents recursive extension loading in child agents
- Live widget above editor: task status, agent activity, cost tracking
- Footer status bar: compact squad progress indicator
- TUI overlay panel: task list, message view, Ctrl+Q toggle
- Slash commands: `/squad status|widget|panel|cancel`

### Known Limitations
- Supervisor review is stub (auto-approves, prompt ready for LLM call)
- Knowledge extraction from agent output not yet implemented
- Cross-squad memory (memory.jsonl) structure exists but not populated
- Panel `m` key for human message input needs `ctx.ui.input()` integration
- File conflict detection tracks files but doesn't hard-block edits
- @mention routing between agents not yet tested with multiple concurrent agents
- Planner agent (auto-decomposition from goal) not yet tested

## Architecture

```
src/
├── index.ts              — extension entry: 4 tools, /squad command, widget, panel, session hooks
├── types.ts              — Squad, Task, Agent, Message, Signal types
├── store.ts              — JSON file I/O with atomic writes, JSONL append, agent bootstrap
├── scheduler.ts          — dependency DAG, concurrency control, auto-unblock, task lifecycle
├── router.ts             — @mention parsing, cross-agent message delivery via steer()
├── agent-pool.ts         — pi RPC process lifecycle: spawn, steer, abort, kill, event parsing
├── monitor.ts            — health checks: idle/stuck/loop detection, hard ceiling
├── supervisor.ts         — on-demand quality review, block analysis (stub)
├── protocol.ts           — system prompt builder: squad protocol + chain context + sibling awareness
├── planner.ts            — one-shot planner agent for goal decomposition
├── panel/
│   ├── squad-panel.ts    — main overlay component, adaptive layout, view switching
│   ├── task-list.ts      — task tree with status icons, live activity, elapsed time
│   └── message-view.ts   — scrollable message log per task, sender coloring
├── skills/
│   ├── squad-protocol/SKILL.md   — communication protocol
│   ├── collaboration/SKILL.md    — team interaction patterns
│   └── verification/SKILL.md     — verify-before-done discipline
└── agents/_defaults/
    └── 11 agent JSONs            — planner through devops
```

### How It Works

```
User: "Build auth system"
  │
  ▼
Main pi agent calls squad({ goal, tasks })
  │
  ▼
Extension (index.ts):
  ├── Writes squad.json + task.json files
  ├── Starts scheduler
  ├── Starts widget refresh (2s interval)
  └── Returns immediately (non-blocking)
  │
  ▼
Scheduler (scheduler.ts):
  ├── Resolves dependency DAG → finds ready tasks
  ├── Spawns pi --mode rpc per task (agent-pool.ts)
  │     ├── System prompt: protocol + identity + chain context + siblings
  │     ├── Sends initial prompt via RPC stdin
  │     └── Subscribes to stdout events
  ├── On agent_end RPC event:
  │     ├── Marks task done, extracts output
  │     ├── Auto-unblocks dependents
  │     ├── Spawns next ready tasks
  │     └── Checks squad completion
  └── On squad completion:
        ├── Updates widget to final state
        └── Sends followUp to main agent with summary
```

## Data Layout

```
.pi/squad/
├── agents/                              — agent definitions (user-editable)
│   ├── planner.json                     — core: task breakdown
│   ├── fullstack.json                   — core: fallback generalist
│   ├── architect.json, backend.json, frontend.json, debugger.json
│   ├── qa.json, security.json, docs.json, researcher.json, devops.json
│   └── {user-created}.json              — custom agents
├── memory.jsonl                         — cross-squad persistent memory
└── {squad-id}/                          — squad instance
    ├── squad.json                       — goal, agents, config, status
    ├── context.json                     — live state snapshot (extension-maintained)
    ├── knowledge/
    │   ├── decisions.jsonl
    │   ├── conventions.jsonl
    │   └── findings.jsonl
    └── {task-id}/                       — one folder per task
        ├── task.json                    — metadata, status, depends, output, usage
        ├── messages.jsonl               — conversation log
        └── {subtask-id}/               — nested subtask folders
```

## User Interface

### Widget (above editor, always visible when squad is active)

```
⏳ squad Build task API with tests and docs 2/3 $0.73 3m12s
  ✓ setup-api (backend) Created CRUD REST API with validation
  ⏳ write-tests (qa) → bash npm test
  ◻ write-docs (docs) ← setup-api
```

Shows per-task: status icon, id, agent, live activity for running tasks, output for done, error for failed, blocker list for blocked. Updated every 2 seconds.

### Footer Status Bar

```
⏳ squad 2/3 $0.73
```

Compact one-line indicator in pi's footer.

### TUI Panel (Ctrl+Q toggle)

Right-side overlay on wide screens (>=160 cols), centered overlay on narrow screens.

**Task list view:**
```
╭─ squad: Build task API ─────────────────────╮
│ ▸ ✓ setup-api (backend) 2m12s               │
│   ⏳ write-tests (qa) 45s                   │
│   ◻ write-docs (docs) blocked               │
│                                              │
│ ── write-tests (live) ──────────────────     │
│ → bash npm test                              │
│ → read src/tasks.test.js                     │
│                                              │
│ 1/3 · $0.73 · 3m                            │
├──────────────────────────────────────────────┤
│ ↑↓ nav  ⏎ msgs  p pause  x cancel  q close │
╰──────────────────────────────────────────────╯
```

**Message view** (press Enter on a task):
```
╭─ write-tests · qa ⏳ ───────────────────────╮
│                                              │
│ 10:03 qa                                     │
│   Starting test implementation               │
│ 10:03 qa                                     │
│   → read src/index.js                        │
│ 10:04 qa                                     │
│   → write src/tasks.test.js                  │
│                                              │
├──────────────────────────────────────────────┤
│ ↑↓ scroll  esc back  q close                │
╰──────────────────────────────────────────────╯
```

### Slash Command: `/squad`

| Subcommand | Action |
|---|---|
| `/squad status` | Show task summary as notification |
| `/squad widget` | Toggle live widget on/off |
| `/squad panel` | Toggle overlay panel |
| `/squad cancel` | Cancel running squad, kill all agents |

## Tools

### squad (non-blocking)
Start a multi-agent squad. Returns immediately with plan summary.

```
goal: string                    — what to accomplish
agents?: { name: { model? } }  — agent roster with optional model overrides
tasks?: [{ id, title, description?, agent, depends? }]  — predefined breakdown (skips planner)
config?: { maxConcurrency? }    — default 2
```

### squad_status
Check progress. Falls back to disk when no active scheduler.

### squad_message
Send human message to a running agent via `steer()`.

### squad_modify
Modify running squad: add_task, cancel_task, pause_task, resume_task, pause, resume, cancel.

## Agent System

### 11 Bundled Agents

| Agent | Role | Tags |
|---|---|---|
| **planner** (core) | Project Planner | planning, architecture, coordination |
| **fullstack** (core) | Fullstack Developer | general, coding, implementation |
| **architect** | Software Architect | architecture, design, patterns |
| **backend** | Backend Engineer | api, server, database, auth |
| **frontend** | Frontend Engineer | react, ui, css, accessibility |
| **debugger** | Root Cause Analyst | debugging, investigation, bugs |
| **qa** | QA Engineer | testing, verification, e2e |
| **security** | Security Engineer | security, audit, vulnerability |
| **docs** | Technical Writer | documentation, readme, api-docs |
| **researcher** | Research Analyst | research, analysis, exploration |
| **devops** | DevOps Engineer | ci-cd, docker, deployment |

Agents are JSON files in `.pi/squad/agents/`. Users can edit existing agents or create new ones.

### Agent Definition Format

```json
{
  "name": "backend",
  "role": "Backend Engineer",
  "description": "APIs, databases, server-side logic, middleware",
  "model": null,
  "tools": null,
  "tags": ["api", "server", "database"],
  "prompt": "You are a backend engineer..."
}
```

- `model`: null = pi default. Override with e.g. `"google/gemini-2.5-flash"`
- `tools`: null = all tools. Override with e.g. `["bash", "read", "write", "edit"]`
- `prompt`: appended to the squad protocol in the agent's system prompt

### Bundled Skills

Injected into every squad agent via `--skill`:

- **squad-protocol** — @mention syntax, completion signals, coordination rules
- **collaboration** — how to build on others' work, ask questions, share findings
- **verification** — verify before claiming done, include evidence in output

## Governance

### Mechanical (scheduler.ts)
- Never spawn agents for blocked tasks (deps not met)
- Auto-unblock dependents when task completes
- Kill agents when task becomes re-blocked
- Concurrency limit (maxConcurrency config)
- Remove completed agents from pool before scheduling next (prevents slot count race)

### Reactive (monitor.ts)
- Idle warning at 3 minutes (steer: "What's your status?")
- Stuck intervention at 5 minutes (steer: "Summarize what's blocking you")
- Loop detection: same tool call 5x in ring buffer
- Hard ceiling: 30 minutes (abort + mark failed)

### Message Routing (router.ts)
- Parses `@agentname` from assistant text
- Routes to running agent via `steer()` (real-time injection)
- Queues for offline agents (delivered on next spawn)
- Detects block signals ("I'm blocked", "cannot proceed") → escalates to main agent

## Context Injection

Each agent's system prompt (via `--append-system-prompt`) includes:

1. **Squad protocol** — communication rules, @mention syntax
2. **Agent identity** — role, description, custom prompt
3. **Task description** — title and description
4. **Chain context** — output from each completed dependency
5. **Sibling awareness** — parallel tasks, agents, modified files
6. **Knowledge entries** — decisions, conventions, findings
7. **Queued messages** — @mentions received while agent wasn't running

## Key Implementation Details

### RPC Agent Lifecycle
- Agents spawn as `pi --mode rpc --no-session --append-system-prompt <file>`
- Extension sends initial prompt via RPC stdin JSON
- Extension subscribes to stdout events (message_end, tool_execution_*, agent_end)
- Pi RPC sends `{"type":"agent_end"}` when agent loop finishes — extension detects this, kills the RPC process, and triggers task completion
- Guard prevents double agent_end emission (RPC event + process exit)
- `PI_SQUAD_CHILD=1` env var prevents recursive squad extension loading

### Dependency Resolution
- Tasks with `depends: []` start as `pending` (ready immediately)
- Tasks with deps start as `blocked`
- When task completes → `autoUnblock()` checks all blocked tasks, sets to `pending` if all deps met
- `scheduleReadyTasks()` finds pending tasks with all deps done, spawns up to maxConcurrency
- Agent pool entry removed before emit so `getRunningAgents()` count is accurate for next scheduling

### Widget System
- `setWidget("squad-tasks", lines)` renders above the editor
- `setStatus("squad", text)` renders in footer
- Refreshed every 2 seconds via `setInterval`
- Scheduler events trigger immediate additional refresh
- Cleared on squad completion (shows final state) and session shutdown

### Session Persistence
- `session_shutdown` → suspends in-progress tasks, kills agents, clears widget
- `session_start` → detects suspended squads on disk, notifies user to resume
- Squad state fully reconstructable from JSON files on disk

## Test Results

### Single Task (1 agent)
- Backend agent: read project, installed express, wrote endpoint, tested, verified
- 6-7 turns, ~$0.08, ~30 seconds

### Multi-Task with Dependencies (3 agents)
- `setup-api` (backend, 29 turns, $0.58) → `write-tests` (qa, 6 turns, $0.34) + `write-docs` (docs, 5 turns, $0.15)
- Dependencies resolved correctly: tests and docs started in parallel after API completed
- Total: 40 turns, $1.06, ~5 minutes
- Files created: modular express app (app.js, routes.js, store.js, validate.js), tests, updated README
