# pi-fleet ↔ pi-squad Bridge (cross-extension contract)

pi-squad orchestrates **what** gets done (task DAG, QA loop, advisor) with local
`pi --mode rpc` agents. pi-fleet orchestrates **where** work runs (remote tailnet
workers, bundles, baselines, budgets). This document defines how they compose —
and the independence guarantees that composition must never break.

## Independence contract (non-negotiable)

| Installed | Behavior |
|---|---|
| pi-fleet only | Everything works. The bridge global is published but never consumed — zero side effects (FleetManager stays lazy). |
| pi-squad only | Everything works. Squad feature-detects the bridge, finds nothing, and never offers/uses remote placement. Tasks requesting a `host` fail with an actionable error, not a crash. |
| Both | Remote placement unlocks (Phase A below). |

Rules:
- **No package dependency in either direction.** The only coupling is a
  version-checked global (`globalThis.__piFleetBridge`) plus this document.
- Consumers must treat a missing global or `version !== 1` as "fleet absent".
- pi-fleet publishes at server-mode startup and unpublishes on
  `session_shutdown` (ownership-checked, so a reload's new instance wins).
- Consumer exceptions are isolated inside the bridge's event dispatch — a
  buggy consumer cannot break fleet event handling.

## Bridge API v1 (pi-fleet `src/server/bridge.ts`)

```ts
const bridge = (globalThis as Record<string, unknown>).__piFleetBridge as PiFleetBridgeV1 | undefined;
if (bridge?.version === 1) { /* fleet available */ }
```

- `spawnWorker({host, cwd, bundle?, fromBaseline?, maxCost?})` → `{instanceId, host, bundle, staleBaseline?}`
- `prompt(instanceId, message)` — fire-and-forget; observe via `onEvent`
- `rpc(instanceId, command, timeoutMs?)` — raw pi RPC passthrough (steer/abort/set_model/get_state…)
- `onEvent(instanceId, listener)` → unsubscribe — the worker's pi RPC event stream
- `abort(instanceId)` / `stop(instanceId)` / `status(instanceId)`

## Composition phases

**Phase 0 (shipped, prompt-level):** the squad supervisor skill teaches the main
session when to use squad (intra-repo parallelism) vs fleet (machine-bound work)
vs both side by side. Works with either extension alone.

**Phase A (planned, pi-squad side):** `host?` on squad agent entries →
`agents: { backend: { host: "ab-internal-10", fromBaseline: "api-repo" } }`.
Squad's AgentPool gains a bridge-backed executor: spawn via `spawnWorker`,
deliver the squad protocol prompt via `prompt`, map `onEvent` into the existing
AgentEvent pipeline (same events the local RPC children emit), steer via
`rpc({type:"steer"})`, kill via `stop`. Scheduler/monitor/advisor/QA operate on
the event stream and need no changes. Known problems to solve:
- **Skills**: `--skill` paths don't exist remotely — squad skills must ship in
  the worker's bundle (publish a `squad` bundle) or be inlined into the
  appended system prompt.
- **System prompt**: fleet spawn has no `--append-system-prompt` passthrough
  yet; deliver the protocol as the first prompt message, or extend the spawn
  frame (fleet-side change, additive).
- **File coordination**: `modifiedFiles`/sibling-conflict rules are meaningless
  across machines. Remote squad tasks must deliver work as branch/patch
  (fleet's `deliver` mechanism), never assume a shared working tree.
- **inheritContext**: session forks cannot cross machines. The remote
  equivalent is `fromBaseline` (warm repo context, clone-on-spawn).

**Phase B (planned):** unify review — remote squad tasks route fleet
`task_done` into squad's `handleTaskCompleted`; QA `FAIL` verdict maps to
`remote_reject`; fleet's own awaiting-review is suppressed for squad-owned
instances.

**Phase C (planned):** budgets — `maxCost` per squad task; squad cost roll-up
includes remote workers.

## Division-of-labor cheat sheet

| Situation | Use |
|---|---|
| Parallel work inside this repo (backend+frontend+QA share the tree) | squad |
| Work on another machine/OS/dev-env/repo; blast-radius or cost isolation | fleet |
| Big feature here + deployment validation on the VM | both, side by side |
| Warm repo understanding for repeated remote tasks | fleet baselines |
| Stuck-agent rescue with a stronger model | squad advisor (local), orchestrator review (fleet) |
