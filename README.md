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
5. When agents finish, the squad enters **`review`**, not `done`; main Pi receives every complete task output as untrusted review input
6. Main Pi independently checks the original user contract, actual diff/source, verification commands, and integration/E2E, then records acceptance with `squad_review`
7. Multiple squads can run concurrently across different projects

### Mandatory Orchestrator Review Gate

Squad agents—including QA/reviewer agents—produce candidate work and evidence claims. They cannot mark a squad accepted. After all tasks finish:

- Persisted status becomes `review`, never directly `done`.
- A persistent `<squad_review_required>` system reminder tells main Pi to re-read the original conversation contract, inspect the actual diff/source, rerun verification independently, and run integration/E2E where applicable.
- Main Pi must call `squad_review` with requirement-by-requirement contract checks, diff review, actual command/result evidence, integration/E2E evidence, and issues.
- Only `pass` or `pass_with_issues` changes the squad to `done`; `fail` leaves it review-blocked and cannot be overwritten by another verdict.
- Failed review is reworked in the **same authoritative squad**: use `squad_modify` with that `squadId` and `add_task` or `resume_task` (or `resume` when interrupted work exists). These operations reconstruct the scheduler after restart. `/squad resume <squad-id>` provides the same resume path.
- When rework begins, the failed attempt moves to `reviewHistory`, the squad returns to `running`, and its evidence remains auditable. After every rework task settles, a fresh pending review becomes the active gate and `squad_review` is required again.
- Pending and failed review gates survive Pi restarts and are restored on the next session. A separate squad never links to, remediates, or accepts the failed gate.
- Every UI/status surface keeps execution progress adjacent to an explicit acceptance state: `◆ REVIEW PENDING · independent review required` means no verdict exists yet; `✗ REVIEW FAILED · awaiting same-squad rework` means the candidate was rejected. A truthful `3/3` task count never means a failed candidate was accepted.

The completion report is explicitly labeled **untrusted and not yet accepted**. Main Pi must never merely relay it or ask whether verification should be run.

### No-Truncation Contract

Task messages, task outputs, dependency/rework handoffs, QA feedback, advisor handoffs, completion reports, failure diagnostics, and planner errors are persisted and forwarded in full. There is no character or task-count limit on report data. TUI widgets may show width/height-limited **views** to fit the terminal, but the underlying data and agent/main-session handoffs remain complete.

## Features

### Dependency-Aware Scheduling

Tasks define dependencies. The scheduler resolves the DAG, spawns ready tasks up to `maxConcurrency`, and auto-unblocks dependents when tasks complete.

```
architect → backend ──→ qa
              ↑
architect → frontend ─┘
```

Architect runs first. Backend and frontend run in parallel after architect completes. QA waits for both.

### Suspended Work Requires Explicit Action

Suspension is an explicit pause, not a retry signal. If every remaining non-cancelled task is suspended or transitively blocked by suspended work, pi-squad durably wakes the main orchestrator once for that exact stall state. The widget shows `⚠ SUSPENDED — explicit resume required`; `squad_status` and the detail panel list every exact suspended task ID and blocked descendant.

Nothing resumes automatically. Choose each task intentionally with an exact squad and task ID:

```javascript
squad_modify({ action: "resume_task", squadId: "<exact-squad-id>", taskId: "<exact-task-id>" })
```

Repeated reconciliation and restart do not create notification storms. A delivered stall remains visible until explicit resumption changes the state; a different suspended/blocked set is a new actionable episode.

### Persistent Master Switch

`/squad disable` persists a global master switch in `~/.pi/squad/settings.json`. It first saves the disabled state, then stops schedulers, durably suspends in-progress tasks, kills child processes, clears focus, and hides the widget. On later Pi restarts, disabled mode does not reconstruct schedulers, recover mail, resume sessions, normalize tasks, or select a squad.

While disabled, all five squad tools and every `/squad` operation fail closed with `/squad enable` guidance; only exact `/squad enable` and the idempotent exact `/squad disable` control commands run. Tool schemas remain registered. Mandatory pending/failed review gates and suspended-stall reminders remain injected because they are durable safety obligations, but they do not authorize squad work while disabled.

`/squad enable` persists the enabled state and restores widget availability without selecting a squad or resuming anything. Suspended work remains suspended until an explicit exact-task resume or `/squad resume <squad-id>`.

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
| `reviewer` | Code Reviewer (read-only) | review, code-quality, over-engineering |
| `security` | Security Engineer | audit, vulnerability, threat-modeling |
| `debugger` | Debugger & Root Cause Analyst | debugging, investigation, bugs |
| `devops` | DevOps Engineer | ci-cd, docker, deployment |
| `docs` | Technical Writer | documentation, readme, api-docs |
| `researcher` | Research Analyst | research, analysis, exploration |
| `planner` | Project Planner | planning, architecture, coordination |

### Agent Collaboration

**Chain context**: When task A completes, its complete output is injected into downstream prompts across the full dependency-ancestor closure (ancestors first, diamond dependencies deduplicated), not only the final direct edge. Integration and QA tasks therefore receive the original contracts their inputs were built from.

**Completed-agent replies**: An `@agent` request aimed at an agent whose task already finished is answered immediately from that agent's durable task output. It is never queued for a nonexistent future spawn, and a blocker resolved this way does not escalate to the human.

**Report-only work**: Planning/review agents may complete with a substantive assistant artifact even when they needed no tool call. Their output still passes through mandatory independent orchestrator review.

**Shared filesystem**: All agents work in the same project directory. Upstream agents create files, downstream agents read and modify them.

**Sibling awareness**: Parallel agents see each other's status and modified files, with warnings about shared file edits.

**@mention routing**: Agents write `@frontend what token format?` in their output. The router delivers it in real-time via RPC `steer()`.

**Main-session request/reply**: `squad_message` addresses one exact task ID. An agent name is accepted only as shorthand for exactly one currently live task, so two tasks assigned to the same role never share or steal messages. Requests are written first to the task's durable mailbox, then delivered with correlated Pi RPC. A completed task is reopened and resumed with `pi --session <its-original-session-file>`; only a task without a session binding receives a new session. This also works after scheduler/main-process reconstruction. By default (`expectReply: true`), the next substantive response is durably marked as the reply, pushed into main Pi, and wakes it; use `expectReply: false` for fire-and-forget steering. pi-squad waits for Pi's final `agent_settled` event before marking the task done or closing the child; low-level `agent_end` never kills queued continuations.

### Smart Planner

The planner creates task breakdowns with proper dependency ordering:
- Frontend tasks depend on backend API tasks (so frontend can test against real endpoints)
- Parallel tasks that share interfaces get a design/architecture task first
- Task descriptions include specific API paths, schemas, and conventions

When the main agent provides tasks directly (via the `tasks` parameter), unknown agent names are automatically remapped to `fullstack` instead of failing.

## User Interface

### Widget (above editor)

Shows live execution progress plus a distinct acceptance/attention state. Truncation is viewport-only: no wrapping, deterministic height, with complete IDs and evidence retained for detail/status output.

```
◆ squad Build task API 3/3 · ◆ REVIEW PENDING · independent review required
✗ squad Build task API 3/3 · ✗ REVIEW FAILED · awaiting same-squad rework
⚠ SUSPENDED — explicit resume required · ^q detail

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

Full overlay with task list, live activity preview, and scrollable message view. The view opens at the live tail but can scroll back through the complete durable history, including acknowledged and older orchestrator/human messages; multiline bodies are not shortened. Main-Pi requests are labeled `ORCHESTRATOR` and panel/user input is labeled `YOU`.

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
| `/squad resume [squad-id]` | Reconstruct and resume an exact paused/failed/failed-review squad |
| `/squad list` | List project squads |
| `/squad all` | List all squads |
| `/squad agents` | Manage agent definitions |
| `/squad msg [task-id\|running-agent] text` | Message an exact task, or use an agent name only when it has one live task |
| `/squad widget` | Toggle widget |
| `/squad panel` | Toggle panel |
| `/squad cancel` | Cancel the visibly focused squad; the notification names it and the focused widget/status clear |
| `/squad clear` | Dismiss widget |
| `/squad cleanup` | Delete squad data |
| `/squad enable/disable` | Persistently enable/disable all squad execution; enabling never auto-resumes work |

## Tools (LLM-callable)

| Tool | Description |
|---|---|
| `squad` | Start a squad with goal + optional tasks/config |
| `squad_status` | Check progress, costs, task states |
| `squad_review` | Record the main orchestrator's independent acceptance review |
| `squad_message` | Durably message an exact task; completed tasks reopen on their original session |
| `squad_modify` | Add/cancel/complete/pause/resume tasks or squads, or replace a task's dependencies with `set_dependencies`; exact `squadId` is required for destructive whole-squad `cancel` and recommended for all task actions |

Tool-level whole-squad cancellation never infers a target: `squad_modify({ action: "cancel", squadId: "<exact-squad-id>" })` affects only that persisted squad and names it in the result. Omitting `squadId` is rejected without changing any squad. Interactive `/squad cancel` instead uses the squad visibly focused in the current UI and names the affected squad.

Dependency repair uses top-level `taskId` and `depends`, for example `squad_modify({ action: "set_dependencies", taskId: "publish", depends: ["build"] })`. The replacement is validated atomically (known IDs, no self-reference, duplicates, or cycles) and is allowed only while the task is not running or done.

`cancel_task` is refused while any non-cancelled task directly depends on the target. Update every listed dependent explicitly with `set_dependencies`, then retry cancellation. Cancellation never cascades to dependents and never rewrites their dependency lists automatically; cancelled tasks remain visible in squad history and can be revived only with explicit `resume_task`.

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
    backend: { model: "claude-sonnet-4-20250514" },   // per-agent model override
    architect: { thinking: "high" },                   // per-agent thinking level
  },
})
```

### Context Inheritance

Agents normally start fresh with only their task description, dependency outputs, and squad protocol. Set `inheritContext: true` on a task to fork the main pi session (via `pi --fork`) so that agent inherits the full conversation context:

```js
squad({
  goal: "Implement the design we discussed",
  tasks: [
    { id: "impl", title: "Implement agreed design", agent: "backend",
      description: "Goal: implement the API design agreed in this conversation. Verify: npm test",
      inheritContext: true },
  ],
})
```

**Caveats:**
- **Cost**: the agent pays the entire conversation history as input tokens on every turn — use sparingly
- **Context-window guard**: the fork is skipped automatically when the estimated session size exceeds 50% of the agent model's context window (agents on smaller-context models silently degrade to standard squad context; the skip is recorded in the task's message log and `debug.log`)
- Requires the main session to have a session file (skipped under `--no-session`)
- Each child session is stored under its task directory at `~/.pi/squad/<squad-id>/<task-id>/session/`, not in your project's session list
- Once created, that task-to-session binding is immutable; later resumes pass the original file through `--session`
- Prefer restating the 3-5 key decisions in the task description — reach for `inheritContext` only when that's impractical

### Task-to-Task Context (`forkFromTask`)

Follow-up and review-rework tasks can fork an **existing task's** durable session instead of starting fresh: `squad_modify { action: "add_task", task: { id: "impl-fix-1", agent: "backend", forkFromTask: "impl", ... } }`. The new agent continues with the source task's complete conversation context — nothing is re-explored or redone. The source must have run at least once (it needs a durable session); the same 50%-of-context-window guard as `inheritContext` applies, and `forkFromTask` is mutually exclusive with `inheritContext`. This is the recommended shape for rework after a failed independent review.

### Custom Agents

Create `~/.pi/squad/agents/my-agent.json` (global) or `{project}/.pi/squad/agents/my-agent.json` (project override):

```json
{
  "name": "my-agent",
  "role": "ML Engineer",
  "description": "Machine learning, PyTorch, data pipelines",
  "model": null,
  "thinking": null,
  "tools": null,
  "tags": ["ml", "pytorch", "data"],
  "prompt": "You are an ML engineer specializing in PyTorch..."
}
```

- `model`: `null` = squad default (see below). Override per agent or per squad.
- `thinking`: `null` = squad default. One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (passed via pi's `--thinking` flag). Override per agent or per squad. Also editable via `/squad agents` → "Change thinking".

### Default Model & Thinking (`/squad defaults`)

Agents without an explicit `model`/`thinking` follow the squad default policy (stored in `~/.pi/squad/settings.json`):

| Policy | Behavior |
|---|---|
| `main` *(default)* | **Follow the main pi session's current model and thinking level** — switch models mid-session and new agents follow |
| `pi-default` | Legacy behavior: the child pi process resolves its own configured default |
| explicit value | A fixed model id (e.g. `openai-codex/gpt-5.6-terra`) or thinking level |

Change interactively with `/squad defaults`. The planner agent follows the same policy. Resolution order: agent def → per-squad override → squad default policy.
- `tools`: `null` = all tools. Restrict with `["bash", "read", "write", "edit"]`.
- `tags`: Used by the planner to match agents to tasks automatically.
- Project-local agents override global agents with the same name.

### Advisor — Self-Healing Squads (`/squad advisor`)

Modeled on the advisor tool pattern ([pi-advisor](https://github.com/RimuruW/pi-advisor) / Anthropic's advisor strategy): when the health monitor flags an agent as stuck, the squad consults a **stronger advisor model in-process** (via pi-ai, no subprocess) with a curated digest — task, recent messages, recent tool activity — before interrupting you.

The advisor returns a verdict (`Course-correct` / `Push through` / `Needs human input`) plus ≤5 action items:
- **Course-correct / Push through** → advice is steered directly into the stuck agent's conversation; escalation suppressed
- **Needs human input** → escalates immediately with the advisor's assessment attached
- Advisor disabled, exhausted (`maxCallsPerTask`), or failed → normal escalation to you

Configure with `/squad advisor` (on/off, model, max calls per task, reasoning effort). Defaults: **enabled**, model = main session's model, 2 calls/task, medium reasoning. Settings persist in `~/.pi/squad/settings.json` under `advisor`. All consultations are recorded in the task's message log (`from: "advisor"`).

## Reliability

### Meaningful Work Check

Agents must complete at least one LLM turn and produce either a tool call or a substantive assistant artifact before they can be marked `done`. This permits legitimate report-only planning/review work while rejecting empty exits. A child that exits before final `agent_settled` (typically a provider/API outage) is resumed on the same task session with backoff — 2s, 10s, 30s, 60s, 120s (override the attempt count with `PI_SQUAD_SPAWN_RETRIES`) — and only fails after the budget is exhausted. Successful completion or an explicit `resume_task`/`resume` grants a fresh budget, so an outage-failed task is always retriggerable once the provider recovers: `squad_modify { action: "resume_task", taskId: "..." }` reopens the same durable session and no work is redone.

### Session Resilience

- Every task owns one durable Pi session. New tasks create it under their task directory; stale, suspended, failed, or explicitly reopened tasks resume that same session rather than starting over. A pre-prompt retry may refresh Pi's provisional session ID only while the bound file is the same and its JSONL has not materialized; afterward both file and ID are immutable.
- Legacy tasks without a session binding migrate on first reopen by creating a task-owned session and seeding its first prompt with the complete persisted multiline message history and prior task output—without truncation.
- In-progress tasks are **suspended** on orderly shutdown; ordinary orphaned work is paused for explicit resume. When the persistent master switch is enabled, a reconstructed scheduler can resume stale `in_progress` state through reconciliation, and startup reconstructs project squads with pending mailbox entries—including `review` or already accepted `done` squads—to resume delivery. Disabled startup performs none of this recovery.
- A durable message to a completed task clears its prior completion/review state, reopens the squad, keeps the task `in_progress` while its agent is live, and requires a fresh orchestrator review after the final `agent_settled`. Every transitive descendant is re-blocked and reruns in dependency order, so results derived from the reopened dependency cannot remain falsely complete.
- Failure is never terminal: `resume` recovers failed squads (failed tasks reset to pending), `complete_task` marks recovered work done and schedules dependents, and a 60s reconcile loop re-derives scheduling from persisted state so out-of-band store edits can't strand ready tasks.
- Mail is acknowledged only after Pi accepts the correlated RPC command. Pending and acknowledged entries remain task-addressed on disk, survive process restart, and remain visible in history. Queue and acknowledgement read/modify/write operations are serialized across processes so concurrent mutations cannot overwrite messages or delivery state.
- Squads are fully reconstructable from JSON files on disk. Unexpected child exits are retried once after 2 seconds on the same bound task session.
- All errors logged to `~/.pi/squad/debug.log` (always for errors, `PI_SQUAD_DEBUG=1` for verbose)

### Health Monitoring

The monitor never kills or blocks work on its own — its strongest action is notifying the main Pi session so you (or the main agent) can decide.

| Check | Threshold | Action |
|---|---|---|
| Idle warning | 3 minutes no output | Steer agent with nudge |
| Stuck detection | 5 minutes no output | Steer, then escalate to main session |
| Loop detection | Same tool call 5x | Steer with warning |
| Long-running check-in | Every 30 minutes total (`PI_SQUAD_CEILING_MS`) | Notify main session — work continues |

## Data Layout

All state in `~/.pi/squad/`. No database, no daemon. Writes are atomic. JSONL reads skip corrupt lines.

```
~/.pi/squad/
├── settings.json        — persistent master switch, defaults, and advisor settings
├── agents/              — agent definitions (user-editable)
├── debug.log            — error and debug logging
└── {squad-id}/
    ├── squad.json       — goal, status, config, cwd
    ├── context.json     — live state snapshot
    └── {task-id}/
        ├── task.json      — status, output, usage, immutable session binding, retry metadata
        ├── messages.jsonl — append-only conversation history
        ├── mailbox.json   — task-addressed inbound mail, including delivery acknowledgements
        └── session/       — this task's durable Pi session JSONL
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
├── monitor.ts        — health checks (idle, stuck, loop, long-run notify)
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

## File-based squad specifications

Large contracts may be started without inlining them: `squad({ specFile, specSha256 })`. The strict v1 JSON contract, size/artifact policy, canonical-byte publication, child-only `squad_spec_read` protocol, tool guard, durable task attestation, and legacy compatibility are specified in [`docs/file-spec-and-full-read-attestation-contract.md`](docs/file-spec-and-full-read-attestation-contract.md). The SHA-256 must be lowercase and match the exact file bytes; malformed, oversized, or artifact-integrity failures are rejected before scheduling.
