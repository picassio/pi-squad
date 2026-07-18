# Persistent squad master-switch contract

Status: implementation contract (not current implementation truth)

## 1. State and persistence

The master switch is global, not project- or session-local.

```ts
interface SquadSettings {
  enabled: boolean;
  // existing defaultModel, defaultThinking, and advisor fields remain unchanged
}

DEFAULT_SQUAD_SETTINGS.enabled = true;
```

- Persist the value at `~/.pi/squad/settings.json` through the existing atomic settings writer.
- A missing settings file, a legacy file without `enabled`, or a non-boolean `enabled` uses the backward-compatible default `true`. Other settings keep their existing deep-merge behavior.
- Every whole-settings write (including `/squad defaults` and `/squad advisor`) must preserve the effective `enabled` value.
- The extension loads the effective setting before any `session_start` widget installation, focus restoration, orphan cleanup, attestation audit, scheduler construction/start, suspended-stall recovery, mailbox recovery, or squad notification.
- Tools and the `/squad` command remain statically registered in both states. Registration is not permission to execute.
- The conditional child-only `squad_spec_read` registration is not a main-session squad execution path; its existing file-spec guard remains unchanged. Disabling the parent kills its child processes.

A failed settings write fails the control command. It must not update the in-memory master state or claim success.

## 2. Disabled startup

When the loaded value is `false`, `session_start` is read-only with respect to squad work:

- do not create or start a `Scheduler`;
- do not audit or rewrite file-spec/task/squad state;
- do not normalize orphaned `in_progress` tasks;
- do not recover pending mail, resume sessions, acknowledge attention, or spawn children;
- do not select/focus a squad, install/show squad widget content, open a panel, or register an operational Ctrl+Q path;
- do not emit ordinary paused/recovery/completion/failure notifications.

The only lifecycle exception is the durable safety injection in section 7. Reading persisted review/attention records for that injection is allowed; reconstructing or mutating work is not.

An enabled startup retains existing recovery behavior and contracts. In particular, explicitly `suspended` tasks still never resume merely because Pi restarted.

## 3. Public tool gate

The enabled check is the first operation in every main-session tool `execute` handler, before target inference, store lookup, focus changes, scheduler construction, mailbox writes, review writes, or other mutations. While disabled, every tool returns a non-throwing result with clear guidance such as:

```text
pi-squad is disabled. Run /squad enable, then retry this operation; no squad work was changed.
```

All five public tools registered in `src/index.ts` are covered:

| Tool | Disabled behavior |
|---|---|
| `squad` | No planning, publication, scheduler, task, or child creation. |
| `squad_status` | No latest/active lookup or context refresh; fail closed rather than offering a read-only bypass. |
| `squad_review` | No attestation scheduler/audit and no review mutation. The durable review gate remains pending/failed and injected. |
| `squad_message` | No mailbox write, scheduler reconstruction, task reopening, or delivery. |
| `squad_modify` | Every action fails closed, including add/set-dependencies/cancel/pause/resume/complete and whole-squad actions. |

Static schemas/descriptions remain available to the model, but a call cannot execute until enabled.

## 4. Slash-command and UI gate

The `/squad` handler checks the master state before defaulting, resolving a direct squad ID, reading targets, or opening interactive UI.

While disabled:

- exact `/squad enable` is allowed;
- repeated `/squad disable` is an idempotent control-plane no-op that reports the extension is already disabled and points to `/squad enable`; it never reconstructs work;
- every other form returns one clear disabled notification and performs no squad-work or settings mutation.

This covers every registered branch and fallback in `src/index.ts`:

| Form | Disabled result |
|---|---|
| `/squad`, `/squad select`, `/squad list`, `/squad all`, `/squad <squad-id>` | No selection, focus, or store-driven UI. |
| `/squad resume [id]` | No scheduler construction or task/squad transition. |
| `/squad msg ...` | No mailbox or task mutation. |
| `/squad widget`, `/squad panel`, `/squad clear` | No view activation or panel/widget bypass. |
| `/squad cancel`, `/squad cleanup [all]` | No stopping/deleting/mutating persisted squads. |
| `/squad agents`, `/squad defaults`, `/squad advisor` | No agent/settings editor mutation while the master switch is off. |

Ctrl+Q and all already-created panel callbacks obey the same gate: while disabled they may consume the input and show enable guidance, but may not resolve/focus a squad, construct/start a scheduler, send mail, pause/resume/cancel tasks, or mutate work. If an overlay is open during disable, close it when supported; regardless, its callbacks must fail closed.

## 5. `/squad disable` transition

From enabled state, ordering is mandatory:

1. Load current settings, set `enabled: false`, and atomically persist them. If this fails, abort without claiming or entering disabled mode.
2. Set the in-memory master state to false immediately after persistence, so concurrent public paths fail closed during shutdown.
3. Stop every registered scheduler. Existing `Scheduler.stop()` ordering remains authoritative: stop monitor/reconcile, durably change each `in_progress` task to `suspended`, then kill all child processes. Await every stop/kill before reporting success.
4. Clear the scheduler registry and active focus. Do not reconstruct an absent scheduler merely to disable it.
5. Force `widgetState.enabled = false`, clear its squad target/status, request a render clear (or dispose the widget), and prevent late scheduler events from showing it again.
6. Leave all pending/failed review evidence, review history, mailbox data, sessions, cancellation state, file-spec evidence, and suspended-stall attention intact.
7. Notify truthfully that pi-squad is disabled and `/squad enable` is required.

The operation is idempotent. Repeating it while already disabled does not rewrite tasks, resume work, create schedulers, or duplicate children; it reports the already-disabled state. A task already suspended remains suspended.

## 6. `/squad enable` transition and no-auto-resume rule

Ordering is symmetric at the persistence boundary:

1. Load current settings, set `enabled: true`, and atomically persist them. On failure, remain disabled.
2. Set the in-memory master state to true.
3. Restore widget *availability* (`widgetState.enabled = true` and install/request its controls when UI exists), but keep focus cleared unless the user explicitly selects a squad. An empty widget is valid.
4. Do not construct/start a scheduler, audit work, recover mail, reopen a task, resume a child session, select a squad, clear an attention record, or change any squad/task status.
5. Notify: pi-squad is enabled; no suspended work was resumed; `/squad select` and an explicit `/squad resume <id>` or exact `squad_modify resume_task` may be required.

Repeated enable is idempotent: it converges persisted/in-memory enabled state and widget availability without spawning, selecting, resuming, or duplicating anything.

**Explicit consent is required after disable.** Work suspended by disable remains suspended across `/squad enable` and across disabled restarts. Selection is view-only. Only a later explicit resume operation may revive it, using the existing exact-target, task-session, mailbox, descendant-invalidation, and failed-review-history contracts.

## 7. Authoritative safety reminders while disabled

Master disable suppresses ordinary squad hints/status prompts and operational event notifications, but it must never hide or weaken these persisted safety obligations:

1. Every project squad in `review` keeps its complete mandatory orchestrator review gate injected by `before_agent_start`, across focus changes and while disabled. Candidate work remains untrusted and cannot become accepted. Because `squad_review` is fail-closed while disabled, the injected guidance must state that `/squad enable` is required before recording the independent review.
2. Every active persisted `suspendedStallAttention` keeps its complete exact squad ID, suspended IDs, blocked IDs, and “No task was resumed automatically” reminder injected project-wide while disabled. Guidance must state: enable first, then explicitly resume only intended exact tasks.

These are read-only, durable prompt injections, not permission to reconstruct a scheduler, acknowledge an outbox record, auto-resume work, or call a blocked tool. Review evidence and suspended-attention data remain authoritative and untruncated.

## 8. Widget and event behavior

The master switch outranks the separate session-local `/squad widget` preference.

- Disabled means no widget body and no squad status-line content, even if a prior widget toggle was on or a late scheduler event arrives.
- Disable clears focus and hides immediately after children are quiesced; enable restores the widget mechanism but does not infer a target.
- Ordinary `before_agent_start` squad hints/active status are absent while disabled; only section 7 safety text remains.
- Late scheduler callbacks after disable must not emit ordinary review/failure/reply/escalation UI or re-enable/focus the widget. Their durable state must still obey existing cancellation, suspension, and review guards.

## 9. Required regression matrix

Implementation tests must prove persisted state as well as returned text:

1. Missing/legacy settings default enabled; `false` and `true` survive extension/session restart; other settings survive both writes.
2. Disabled startup creates zero schedulers/children and performs zero orphan, attestation, mailbox, focus, widget, or task/squad mutation.
3. Each of the five registered public tools fails before lookup/reconstruction/mutation and includes `/squad enable` guidance.
4. Every slash branch/fallback listed in section 4, default `/squad`, direct-ID activation, Ctrl+Q, and panel actions have no disabled bypass.
5. Disable persists before stop, suspends live tasks durably, kills all children, clears scheduler/focus, and hides widget; a persistence failure leaves enabled runtime unchanged.
6. Enable restores widget availability and clear guidance but does not select, reconstruct, recover, or resume work.
7. Repeated enable/disable causes no duplicate scheduler/child, task rewrite, or auto-resume.
8. Disabled restart and later enable leave suspended tasks suspended; only explicit exact resume changes them.
9. Pending/failed review and delivered/pending suspended-attention reminders remain complete and injected while disabled, with enable-first guidance; no review/attention record is mutated.
10. Existing cancellation, mandatory review, file-spec/attestation, mailbox/session, no-truncation, and suspended-stall suites remain green.

## 10. Registration cross-check

`src/index.ts` currently exposes exactly five main-session tools (`squad`, `squad_status`, `squad_review`, `squad_message`, `squad_modify`) and one `/squad` command whose branches are `list`, `all`, `select`, `resume`, `widget`, `panel`, `msg`, `cancel`, `clear`, `cleanup`, `enable`, `disable`, `defaults`, `advisor`, `agents`, plus default selection and direct-ID fallback. Sections 3 and 4 cover every registration and branch. The session-start Ctrl+Q panel path and panel callbacks are covered separately because they are public execution surfaces even though they are not slash commands.
