# pi-squad

Multi-agent collaboration extension for [pi](https://github.com/badlogic/pi-mono). Decomposes complex tasks into subtasks, assigns specialist agents, manages dependencies, runs them in parallel with automatic QA rework loops — all with a live TUI widget, overlay panel, and slash commands.

## Install

```bash
# From npm
pi install npm:pi-squad

# From git
pi install git:github.com/picassio/pi-squad

# Or symlink for development
ln -sf /path/to/pi-squad/src ~/.pi/agent/extensions/squad
```

Pi auto-discovers extensions on startup. No build step required.

## Quick Start

Ask pi to do something complex. It calls the `squad` tool automatically:

```
> Build a REST API with authentication, tests, and documentation
```

The planner agent reads your codebase and creates a task breakdown automatically. Or define tasks explicitly:

```
> Use squad: goal="Build task API", tasks=[
    {id: "api", title: "Build CRUD endpoints", agent: "backend"},
    {id: "tests", title: "Write tests", agent: "qa", depends: ["api"]},
    {id: "docs", title: "Write README", agent: "docs", depends: ["api"]}
  ]
```

### What Happens

1. **Planner** analyzes the codebase and creates tasks with dependencies
2. A **live widget** appears above the editor showing task progress
3. **Specialist agents** spawn as separate pi processes, working in parallel where dependencies allow
4. QA agents can trigger **automatic rework loops** when they find bugs
5. On completion, pi receives a summary with each task's output
6. Multiple squads can run concurrently across different projects

## Features

### Dependency-Aware Scheduling

Tasks define dependencies. The scheduler resolves the DAG, spawns ready tasks up to `maxConcurrency`, and auto-unblocks dependents when tasks complete.

```
architect → backend ──→ qa
              ↑
architect → frontend ─┘
```

Architect runs first. Backend and frontend run in parallel after architect completes. QA waits for both.

### QA Rework Loop

When a QA agent outputs `## Verdict: FAIL`, the scheduler automatically:

1. Creates a **fix task** for the original agent with QA feedback
2. Creates a **retest task** for QA, blocked until the fix completes
3. Loops up to `maxRetries` (default: 2), then escalates

```
api (backend) ✓ → qa (qa) ✗ found bug
  → api-fix-1 (backend) ✓ → qa-retest-1 (qa) ✓ all passing
```

### Built-in Engineering Skills

9 skills ship with the extension. Every squad agent automatically loads them:

| Skill | Purpose |
|---|---|
| `squad-architecture` | API contract definition, shared types, project structure, decision documentation |
| `squad-backend-dev` | REST conventions, database patterns, auth implementation, error handling, security |
| `squad-frontend-dev` | React patterns, state management, Tailwind CSS, accessibility, API integration |
| `squad-qa-testing` | Test strategy, checklist, evidence requirements, verdict format, rework flow |
| `squad-security-audit` | Vulnerability checklist, common patterns, reporting format |
| `squad-verification` | Verify before claiming done, evidence-based completion |
| `squad-collaboration` | Building on others' work, asking questions, sharing knowledge |
| `squad-protocol` | Communication rules, @mention syntax, completion format |
| `squad-supervisor` | Squad management guidance for the main pi agent |

Skills are prefixed with `squad-` to avoid conflicts with user or project skills. Squad agents also inherit all skills from the main pi session (user skills, package skills, project skills).

### 11 Specialist Agents

Bundled agent definitions are copied to `~/.pi/squad/agents/` on first run. Edit them freely — the extension never overwrites existing files.

| Agent | Role | Tags |
|---|---|---|
| `architect` | Software Architect | architecture, design, patterns |
| `backend` | Backend Engineer | api, server, database, auth |
| `frontend` | Frontend Engineer | react, ui, css, tailwind, accessibility |
| `fullstack` | Fullstack Developer | general, coding, implementation |
| `qa` | QA Engineer | testing, verification, e2e |
| `security` | Security Engineer | audit, vulnerability, threat-modeling |
| `debugger` | Debugger & Root Cause Analyst | debugging, investigation, bugs |
| `devops` | DevOps Engineer | ci-cd, docker, deployment |
| `docs` | Technical Writer | documentation, readme, api-docs |
| `researcher` | Research Analyst | research, analysis, exploration |
| `planner` | Project Planner | planning, architecture, coordination |

### Agent Collaboration

**Chain context**: When task A completes, its output is injected into task B's system prompt. Downstream agents know what was built.

**Shared filesystem**: All agents work in the same project directory. Upstream agents create files, downstream agents read and modify them.

**Sibling awareness**: Parallel agents see each other's status and modified files, with warnings about shared file edits.

**@mention routing**: Agents write `@frontend what token format?` in their output. The router delivers it in real-time via RPC `steer()`.

### Smart Planner

The planner creates task breakdowns with proper dependency ordering:
- Frontend tasks depend on backend API tasks (so frontend can test against real endpoints)
- Parallel tasks that share interfaces get a design/architecture task first
- Task descriptions include specific API paths, schemas, and conventions

When the main agent provides tasks directly (via the `tasks` parameter), unknown agent names are automatically remapped to `fullstack` instead of failing.

## User Interface

### Widget (above editor)

Shows live squad progress. Truncated to terminal width — no wrapping, deterministic height.

```
⏳ squad Build task API 2/3 $0.58 3m12s  ^q detail · /squad msg
  ✓ api (backend) 2m12s Created CRUD REST API with validation
  ⏳ tests (qa) 45s → bash npm test
  ◻ docs (docs) ← api
```

### Status Bar

```
⏳ squad 2/3 $0.58
```

### Panel (Ctrl+Q)

Full overlay with task list, live activity preview, and scrollable message view.

| Key | Action |
|---|---|
| `↑↓` / `jk` | Navigate tasks / scroll messages |
| `Enter` | View task messages |
| `Esc` | Back to task list |
| `m` | Send message to agent |
| `p` | Pause/resume task |
| `x` | Cancel task |
| `Ctrl+Q` / `q` | Close panel |

### Slash Commands

| Command | Description |
|---|---|
| `/squad select` | Pick a squad to view |
| `/squad list` | List project squads |
| `/squad all` | List all squads |
| `/squad agents` | Manage agent definitions |
| `/squad msg [agent] text` | Send message to agent |
| `/squad widget` | Toggle widget |
| `/squad panel` | Toggle panel |
| `/squad cancel` | Cancel running squad |
| `/squad clear` | Dismiss widget |
| `/squad cleanup` | Delete squad data |
| `/squad enable/disable` | Enable/disable the extension |

## Tools (LLM-callable)

| Tool | Description |
|---|---|
| `squad` | Start a squad with goal + optional tasks/config |
| `squad_status` | Check progress, costs, task states |
| `squad_message` | Send message to a running agent |
| `squad_modify` | Add/cancel/pause/resume tasks or squads |

The main agent sees available agents in its system prompt and squad state when a squad is active.

## Configuration

```javascript
squad({
  goal: "Build the app",
  config: {
    maxConcurrency: 3,  // parallel agents (default: 2)
    maxRetries: 2,      // QA rework attempts before escalation (default: 2)
  },
  agents: {
    backend: { model: "claude-sonnet-4-20250514" },  // per-agent model override
  },
})
```

### Custom Agents

Create `~/.pi/squad/agents/my-agent.json` (global) or `{project}/.pi/squad/agents/my-agent.json` (project override):

```json
{
  "name": "my-agent",
  "role": "ML Engineer",
  "description": "Machine learning, PyTorch, data pipelines",
  "model": null,
  "tools": null,
  "tags": ["ml", "pytorch", "data"],
  "prompt": "You are an ML engineer specializing in PyTorch..."
}
```

- `model`: `null` = use pi's default model. Override per agent or per squad.
- `tools`: `null` = all tools. Restrict with `["bash", "read", "write", "edit"]`.
- `tags`: Used by the planner to match agents to tasks automatically.
- Project-local agents override global agents with the same name.

## Reliability

### Meaningful Work Check

Agents must complete at least 1 LLM turn AND make at least 1 tool call to be marked as "done". Agents that exit cleanly but did no work (rate limit, API error, model not found) are retried once, then failed — never silently marked successful.

### Session Resilience

- In-progress tasks are **suspended** on session crash, **resumed** on next startup
- Squads are fully reconstructable from JSON files on disk
- Spawn failures are retried once with a 2-second delay
- All errors logged to `~/.pi/squad/debug.log` (always for errors, `PI_SQUAD_DEBUG=1` for verbose)

### Health Monitoring

| Check | Threshold | Action |
|---|---|---|
| Idle warning | 3 minutes no output | Steer agent with nudge |
| Stuck detection | 5 minutes no output | Abort and fail task |
| Loop detection | Same tool call 5x | Steer with warning |
| Hard ceiling | 30 minutes total | Abort task |

## Data Layout

All state in `~/.pi/squad/`. No database, no daemon. Writes are atomic. JSONL reads skip corrupt lines.

```
~/.pi/squad/
├── agents/              — agent definitions (user-editable)
├── debug.log            — error and debug logging
└── {squad-id}/
    ├── squad.json       — goal, status, config, cwd
    ├── context.json     — live state snapshot
    └── {task-id}/
        ├── task.json    — status, output, usage, retryOf, qaFeedback
        └── messages.jsonl  — conversation log
```

## Architecture

```
src/
├── index.ts          — extension entry: tools, commands, widget, panel, lifecycle
├── types.ts          — type definitions
├── store.ts          — JSON/JSONL file I/O, atomic writes
├── scheduler.ts      — dependency DAG, concurrency, rework loop, task lifecycle
├── agent-pool.ts     — pi RPC process management, activity tracking
├── protocol.ts       — system prompt builder (chain context, sibling awareness, knowledge)
├── router.ts         — @mention parsing, cross-agent messaging
├── monitor.ts        — health checks (idle, stuck, loop, ceiling)
├── planner.ts        — one-shot goal decomposition via LLM
├── logger.ts         — file-based logging (never writes to stderr)
├── panel/            — TUI overlay panel and widget
├── skills/           — 9 bundled skills for agents
└── agents/_defaults/ — 11 bundled agent definitions
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono) v0.63.0+ (recommended v0.64.0+)
- An API key configured in pi (Anthropic, OpenRouter, etc.)
- Node.js 18+

## License

MIT
