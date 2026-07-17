# Exact cancellation, review presentation, and suspended-stall attention contract

Status: implementation contract (no implementation in this note)

## Non-negotiable invariants

1. A destructive tool call never infers its squad target. `squad_modify({ action: "cancel" })` requires a non-empty exact `squadId`.
2. A scheduler is owned/addressed by its persisted squad ID. Acting on squad A never stops, deletes, focuses, or renders scheduler B.
3. When the widget is enabled, its target equals the active/focused squad ID, or both are `null`. A cancelled focused squad is never left displayed.
4. Task execution completion and independent acceptance remain separate. A failed review stays `squad.status === "review"`, retains immutable evidence in `squad.review`, and is not accepted.
5. Suspension is an explicit pause. Reconciliation, restart, dependency changes, and attention delivery never resume a suspended task. Only an explicit resume operation may do that.
6. Task-owned sessions, task mailboxes, review evidence/history, and complete message/evidence text are unchanged and must not be truncated semantically.
7. `resume_task` is idempotent with respect to already-live exact work: it never demotes an `in_progress` task, replaces its child, or queues a duplicate run.

## 1. Exact-ID whole-squad cancellation

### Tool contract

For `squad_modify` with `action: "cancel"`:

- `squadId` is required for this action even if the schema remains conditionally optional for other actions.
- Missing ID returns an error such as: `cancel requires exact squadId; no squad was changed.` It must not consult `activeSquadId`, latest squad, project candidates, or widget state.
- Unknown ID returns: `Squad '<supplied-id>' not found; no squad was changed.`
- Validate/load the persisted target before touching any scheduler or focus state.
- With a live target scheduler: stop only that scheduler, then remove only `schedulers.get(squadId)`.
- Without a live target scheduler: perform the same persisted cancellation transition safely. If scheduler lifecycle cleanup is reused, construct it for the exact ID without focusing it and without registering it as another squad's active scheduler. Existing `in_progress -> suspended` stop semantics may be preserved.
- Persist the target squad's existing cancellation terminal representation (`failed`) after cleanup. This contract does not add a new squad status and does not alter task cancellation semantics.
- Success names the target: `Squad '<squadId>' cancelled.` Any result/error after an ID is supplied also echoes that ID.
- Repeating cancellation for the same already-terminal target is safe/idempotent and still names that target; it must not affect another squad.

Task-level `cancel_task` remains its existing neutral, dependency-safe contract; this section is only whole-squad destructive cancellation.

### Focus/widget synchronization

After the persisted transition, enforce one helper-level invariant rather than updating globals ad hoc:

- If `activeSquadId === cancelledId`: set `activeSquadId = null`, set `widgetState.squadId = null`, and request a widget update so both widget and status line clear.
- If another valid squad B is focused: preserve B and set/retain `widgetState.squadId = B`; do not focus A merely because an absent scheduler had to be reconstructed.
- If globals were already inconsistent and either points at A, repair them to the valid focused B or clear both. Never leave `widgetState.squadId` pointing at A or at a squad different from `activeSquadId`.
- Always request an update after focus repair. Clearing must reset/ignore the prior widget cache key so a same-shaped future squad can render.

Interactive `/squad cancel` may use the visibly focused squad, but it must capture that exact ID before awaiting, cancel only it, notify `Squad '<id>' cancelled`, then apply the same focus/widget repair. If there is no visible focus, it is a no-op with `No focused squad to cancel`.

## 2. Review-state presentation

The persisted lifecycle does not change:

| Squad/task execution | Active review | Acceptance meaning |
|---|---|---|
| all relevant tasks done | `pending` | candidate awaits independent review |
| all relevant tasks done | `failed` | candidate was rejected; same-squad rework required |
| rework starts | absent; failed attempt appended unchanged to `reviewHistory` | executing rework |
| fresh execution settles | fresh `pending` | new candidate awaits review |
| pass/pass-with-issues | `passed`, squad `done` | accepted |

Required presentation in compact widget, status line/tool output, squad list/selection, and detail panel:

- Pending: `◆ REVIEW PENDING · independent review required` (warning style).
- Failed: `✗ REVIEW FAILED · awaiting same-squad rework` (error style).
- Failed must never be rendered as the generic `review required` label used for pending.
- Execution progress (for example `3/3`) remains truthful but must be adjacent to the acceptance label; it must not imply acceptance.
- `squad_status` must render an explicit acceptance line using the labels above. Detail/list surfaces must use distinct pending/failed icon/label text.
- Failed detail may show actionable issues, but if it does it must preserve every issue in the detail view; do not slice the semantic list or issue bodies. Width/viewport clipping may be visual only, with full data still navigable.

Widget render invalidation must include every persisted value that changes visible output, at minimum `squad.status` and `squad.review?.status ?? "none"` (and issue/verdict fields if rendered). A review `pending -> failed` update must repaint even when task statuses, turns, and progress are unchanged. Clearing/focus changes also invalidate independently of this cache.

## 3. Durable level-triggered suspended-stall attention

### Derived stall predicate

Evaluate after normal mailbox recovery and blocked/pending normalization, and before/with completion derivation. Ignore cancelled tasks for scheduling and stall denominators, consistent with current lifecycle rules.

Definitions for one persisted squad DAG:

- `S`: all exact task IDs whose status is `suspended`, sorted lexically.
- A task is runnable/live if it is `in_progress`, or `pending` with every dependency `done`.
- `suspensionBlocked(t)`: `t.status === "blocked"` and at least one currently unsatisfied dependency has a transitive dependency path ending at a task in `S`.
- Terminal for this predicate: `done`, `failed`, or `cancelled` (cancelled is excluded from the relevant set, but remains visible historically).

A **suspended stall** is active iff:

1. `S` is non-empty;
2. there is no runnable/live non-cancelled task; and
3. every non-cancelled task not in `S` is terminal or `suspensionBlocked`.

This covers suspended-only squads and DAGs whose remaining nonterminal work is blocked directly or transitively by suspended ancestors. It does not fire while independent runnable work exists. A blocked task with no transitive suspended ancestor is a different stall and must not be mislabeled.

### Persisted attention/outbox state

Add optional squad-owned metadata (names may vary only if semantics remain exact):

```ts
interface SuspendedStallAttention {
  kind: "suspended_stall";
  fingerprint: string;            // canonical hash/string of sorted S + sorted blockedTaskIds
  suspendedTaskIds: string[];     // sorted, complete, never abbreviated
  blockedTaskIds: string[];       // sorted suspension-blocked descendants, complete
  detectedAt: string;
  delivery: "pending" | "delivered";
  deliveredAt: string | null;
}

interface Squad {
  suspendedStallAttention?: SuspendedStallAttention;
}
```

Rules:

- On false -> true, atomically persist a new `pending` record before emitting an in-memory scheduler event.
- Repeated reconcile with the same canonical fingerprint is a no-op: do not rewrite timestamps and do not emit again.
- If the exact suspended/blocked sets change while still stalled, persist one new semantic episode/fingerprint and permit one updated wake containing the new exact IDs.
- On predicate false (including explicit resume making progress possible), clear the active record. If the same tasks are explicitly suspended again later, that is a new episode and may notify once.
- Delivery handling is an outbox: only a `pending` record emits `suspended_stall`; the extension sends the main-session follow-up and then marks that exact fingerprint `delivered`. Marking must compare the fingerprint so an older callback cannot acknowledge a newer episode.
- Scheduler reconstruction/start calls reconcile and therefore recreates missing attention or emits a still-pending persisted record. A delivered record is still rendered/injected as active attention but is not re-emitted on restart or timer reconcile.
- The unavoidable host boundary is handled as an outbox: a process failure between host acceptance and acknowledgement can retry once after restart; stable `customType` plus squad/fingerprint should be supplied if the host supports dedupe. Normal transitions/reconcile/restart must never create duplicate wakeups.

### Wake content and durable visibility

The wake must name the exact squad and include the complete sorted suspended IDs and complete blocked-descendant IDs. Required actionable text:

```text
[squad] SUSPENDED WORK NEEDS ACTION in '<squadId>'.
Suspended task IDs: <all IDs>
Blocked by suspended work: <all IDs, or none>
No task was resumed automatically.
Resume intentionally with squad_modify { action: "resume_task", squadId: "<squadId>", taskId: "<exact-task-id>" } for each task you choose.
```

No `slice`, `... +N`, or shortened semantic payload is allowed in the wake, injected context, or status/detail data. Terminal-width clipping is presentation-only.

While the record is active:

- `before_agent_start` injects it project-wide even if another squad is focused, so durable attention survives a missed edge notification.
- `squad_status` and the detail panel show `SUSPENDED — explicit resume required` plus all exact IDs.
- The compact widget shows an attention indicator; it need not fit all IDs, but detail/status must preserve them. Its cache key includes the attention fingerprint and delivery-independent active state.
- Attention never calls `resume()` or `resumeTask()`.

### Explicit resumption

The recommended recovery is one exact call per intended task:

```json
{ "action": "resume_task", "squadId": "<exact squad>", "taskId": "<exact suspended task>" }
```

`resume_task` retains the task-owned session/mailbox behavior and immutable failed-review history. It changes only the exact task plus existing descendant invalidation/scheduling rules. Reconcile then clears or replaces attention from current persisted state. If another suspended cut still prevents progress, a new exact-set episode is allowed; otherwise normal scheduling resumes. No descendant is marked successful merely because its ancestor resumed.

Before any status write, descendant invalidation, or scheduling, `Scheduler.resumeTask(taskId)` must load the exact task and check both durable and live state. If `task.status === "in_progress"` and `pool.isRunning(taskId)`, it is an idempotent no-op: preserve `in_progress`, the same child process, session, mailbox, messages, and active review/rework state; do not enqueue/spawn another run. The tool must return truthful text naming both identities, for example `Task '<taskId>' is already running in squad '<squadId>'; no duplicate resume was started.` A safe explicit rejection with the same names is also conforming. A contradictory state (`in_progress` without a live child, or live child with non-`in_progress` durable status) must be reconciled by the existing recovery policy, never by blindly writing `pending` under a live child. This guard specifically covers a completed task reopened by `squad_message` on its original session followed immediately by redundant `resume_task`.

## 4. Edge-case matrix

| Case | Required outcome |
|---|---|
| A focused/running, cancel tool omits ID | Reject; A and every other squad unchanged; widget remains A. |
| A focused, cancel tool explicitly targets B | Stop/persist only B; A scheduler/focus/widget remain A; result names B. |
| Explicit B has no live scheduler | Persist cancellation for B without focusing/stopping A; result names B. |
| Explicit focused A cancelled | Only A stops; focus/widget/status clear; result names A. |
| Interactive cancel on visible A | Cancel captured A, name A, clear/refresh correctly. |
| Unknown explicit ID | No scheduler/focus/store mutation; error echoes supplied ID. |
| Review pending -> failed with tasks still 3/3 | Compact, status, list, detail repaint to `REVIEW FAILED`; progress may remain 3/3. |
| Repeated widget update after failed review | Cache does not suppress first changed render; later identical updates may coalesce. |
| One suspended task, all others done | Persist/wake once; no auto-resume. |
| Suspended root -> blocked child -> blocked grandchild | Wake once with root in suspended IDs and both descendants in blocked IDs. |
| Suspended root plus unrelated runnable task | No suspended-stall wake until unrelated work ceases to be runnable/live. |
| Suspended task plus unrelated irreducible blocked component | Predicate false for suspended-stall; existing generic failure/stall handling may apply. |
| Reconcile timer repeats unchanged stall | Same persisted fingerprint; zero additional wakeups. |
| Scheduler reconstructed/restarted in unchanged delivered stall | Attention remains visible/injected; no duplicate wake. |
| Restart with pending outbox record | Emit it once, acknowledge matching fingerprint after send. |
| Resume one of several suspended tasks | Never resume the others; clear/update attention by the newly derived exact sets. |
| Resume enables work | Scheduler runs normally; active attention clears. |
| Message reopens completed task and its child is live; redundant exact `resume_task` follows | Idempotent already-running result names squad/task; durable state stays `in_progress`; same child/session/mailbox continues; no duplicate spawn/queue. |
| Same task explicitly suspended again later | New false->true episode; one new wake is valid. |
| Cancelled tasks coexist with suspension | Cancelled tasks remain visible but do not satisfy dependencies or affect the suspended-stall denominator. |

## 5. Verification plan

### Focused unit tests

1. Predicate tests: suspended-only; suspended with all done; direct/transitive blocked descendants; unrelated runnable suppression; unrelated blocked-component suppression; cancelled exclusion.
2. Attention reducer/outbox tests: persist-before-emit; canonical sorting; unchanged reconcile dedupe; changed exact set creates one new episode; false clears; stale acknowledgement cannot acknowledge a newer fingerprint.
3. Widget/render tests: pending and failed labels differ; `pending -> failed` repaints with unchanged task state; focus clear removes widget/status; attention fingerprint invalidates cache.

### Extension integration/regression tests

1. Create concurrent squads A and B with independent fake schedulers. Focus A; omitted tool cancellation rejects; explicit B cancellation changes only B and names B; A remains displayed/running.
2. Repeat with B persisted but no scheduler. Assert no implicit focus and no stop/delete of A.
3. Cancel focused A via tool and via `/squad cancel`; assert exact named notification and widget/status clear.
4. Record a failed review after a pending widget render; assert compact/status/detail/list say `REVIEW FAILED · awaiting same-squad rework`, evidence remains byte-for-byte in active review, and rework archives it unchanged.
5. Live transition into suspended-only and suspended-blocking DAG stalls sends exactly one follow-up with all exact IDs and exact-squad `resume_task` guidance.
6. Call reconcile repeatedly and advance the 60-second path; assert no duplicate wake for the same fingerprint.
7. Reconstruct extension/scheduler from persisted pending attention; assert one delivery. Reconstruct from delivered attention; assert durable prompt/status visibility and no duplicate follow-up.
8. Explicitly resume one exact task; assert its original session/mailbox is reused, other suspended tasks remain suspended, attention updates/clears correctly, and blocked descendants schedule only under existing dependency rules.
9. Reopen a completed task through `squad_message`, wait until its original-session child is live and persisted `in_progress`, then immediately call exact `resume_task`. Assert truthful already-running text names squad/task, status never becomes `pending`, child spawn count remains one, session/mailbox identity is unchanged, and one eventual `agent_settled` produces exactly one completion/review transition.

Run the full native suite after focused tests (`npm test`), focused TypeScript checks used by the repository, extension-load smoke if available, and `git diff --check`. No test may rely only on emitted text: assert persisted squad/task state, scheduler map/focus state, widget/status calls, and notification counts.

## 6. Implementation boundaries

- Do not change task-owned session identity or mailbox routing/retention.
- Do not mutate, replace, or truncate failed review evidence; archive only through existing same-squad rework behavior.
- Do not auto-unpause or infer consent from restart/reconcile/dependency edits.
- Do not add cascading task cancellation or make cancelled dependencies successful.
- Prefer small shared helpers for exact target resolution, focus/widget synchronization, review presentation, and the pure suspended-stall derivation; avoid unrelated lifecycle refactors.
