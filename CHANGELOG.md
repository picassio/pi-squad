# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.20.3] - 2026-08-10

### Fixed

- File-spec squads whose tasks legitimately modify pinned artifact files are no longer permanently wedged. Artifact drift (a pinned contract file changing after spec publication) previously failed `validateTaskSpecAttestation` at every completion site with the misleading message "read all chunks with squad_spec_read" — the agent obediently re-read and re-completed in an infinite paid reject/reopen loop, and even orchestrator `complete_task` was blocked with no recovery path. Now: the full-read attestation remains a hard completion gate, but artifact drift is a review-time concern — reported precisely (file, expected→actual bytes/sha) in a prominent ⚠ SPEC ARTIFACT DRIFT block of the review-required notification so the orchestrator verifies each change is a legitimate product of the work.
- Attestation rejection messages now state the exact failure (attestation missing, recorded against a different spec revision, chunk N mismatch, incomplete state, identity mismatch) via `explainTaskSpecAttestationFailure` instead of a generic re-read instruction.
- Loop breaker: three consecutive completion rejections for the same task suspend it and send one escalation to the main session with the precise reason and the `resume_task` recovery call, instead of respawning the agent forever. Explicit `resume_task` grants a fresh rejection budget.

## [0.20.2] - 2026-08-06

### Fixed

- Zombie `in_progress` tasks whose worker process was lost (session restart, model switch, provider rate-limit kill, crash) are now automatically healed by `reconcile()`. Previously a task stuck in `in_progress` with no live process blocked all downstream tasks forever with no recovery path except manual `resume_task`. Now the scheduler detects the orphan, resets it to `pending`, records a diagnostic message, and respawns it on the same durable session — no work is lost.
- The `squad` tool no longer fails at registration time on strict OpenAI-compatible providers (DeepSeek, OpenAI, and others that reject `type: null` at the root of `function.parameters`). Its parameter schema was a top-level `Type.Union([...])` of two `Type.Object`s (inline vs. file-spec mode); TypeBox emits that as `{ anyOf: [...] }` with no root `type`, which those providers refuse with `Invalid schema for function 'squad': schema must be a JSON Schema of 'type: "object"', got 'type: null'`. Flattened to a single `Type.Object` with all fields optional (`goal`, `agents`, `tasks`, `config`, `specFile`, `specSha256`) and moved the inline-vs-spec discrimination into `execute()`: `specFile` presence selects file-spec mode (requires `specSha256`, forbids inline fields), otherwise inline mode routes through `coerceInlineSquadStart` as before. Behavior is unchanged for callers; only the emitted JSON Schema shape differs. Google Gemini tolerated the previous shape, which is why the bug only surfaced when switching provider.

## [0.20.1] - 2026-07-29

### Fixed

- Huge squads (e.g. 89 tasks) no longer blow the main session's context window at review time. When the assembled review-required report exceeds the inline limit (default 24,000 chars; `PI_SQUAD_REVIEW_INLINE_LIMIT`), the complete report is written untruncated to `<squad>/review-report.md` and the main session receives a bounded digest: counts/cost, a per-task index with output sizes, a compact gate with durable `task.json` pointers, and a mandate to read the entire report file before reviewing. Review gates with oversized delegated plans (>~8,000 chars) also auto-compact to `task.json` pointer lines in every injection site (finish report, per-turn gate reminder, restart restoration, `squad_status`). Nothing is truncated — the canonical bytes are relocated to durable files.

## [0.20.0] - 2026-07-26

### Added

- `squad_modify add_task` accepts `forkFromTask: "<task id>"`: the new task's session is forked from the source task's durable session, so follow-up and review-rework agents continue with the source's complete context instead of redoing everything. Validated at add time (source must exist and have run once; mutually exclusive with `inheritContext`) and guarded by the same 50%-of-context-window check as `inheritContext`.

### Fixed

- Provider/API outages no longer leave tasks permanently unretriable. Unexpected agent exits now retry on the same durable session with backoff (2s/10s/30s/60s/120s, `PI_SQUAD_SPAWN_RETRIES` overrides the count) instead of a single 2s retry whose in-memory flag was never cleared — previously one early blip consumed the only retry forever, and a resumed task could instantly re-fail terminally. Successful completion and explicit `resume`/`resume_task` grant a fresh budget, and the terminal failure message now teaches the exact recovery call.
- A failed `squad_review` verdict now responds with explicit same-squad rework instructions (add `-fix` tasks, ideally `forkFromTask` the reviewed implementation) and forbids cancelling or abandoning the squad, closing the observed "review failed → squad stopped, no rework requested" drift.

## [0.19.5] - 2026-07-24

### Fixed

- Terminal task failures are now reported to the main session immediately when the rest of the squad keeps running (new `squad-task-failed` notification with the exact task, agent, error, and repair guidance). Previously an individual agent death — e.g. `Agent devops exited before RPC response` — was invisible in chat until the whole squad stalled or finished. When no runnable work remains, the existing `squad-failed` summary is sent instead, never both.
- A task that completes after an interim failure (spawn retry, RPC race during reopen) no longer displays the stale error annotation forever; successful completion clears `task.error`.

## [0.19.4] - 2026-07-24

### Fixed

- The mandatory review-required report can no longer be silently lost or invisibly stalled. Successful delivery is durably recorded as `review.notifiedAt`; the 60s reconcile loop re-raises an unrecorded pending gate (covers delivery exceptions and disabled-mode drops), and an immediate TUI notification surfaces the pending review even while a long or stalled main-session run delays the queued follow-up report. Delivered gates are never re-notified while a human review is in progress.
- `squad_failed` stall notifications now fire only on the actual transition to `failed`. Repeated reconciles over an already-failed squad no longer queue duplicate notifications, each of which previously triggered its own main-session turn.
- Review-required delivery failures are now logged to `~/.pi/squad/debug.log` instead of being swallowed.

## [0.19.3] - 2026-07-19

### Fixed

- Newly generated squad IDs now combine a path-safe readable goal slug with a full UUID, eliminating collisions while retaining recognizable names. Slugs also trim separators introduced at the 40-character boundary, preventing `PUBLISH_FAILED: unsafe squad id`. Existing persisted squad IDs and user-authored task IDs are unchanged.

## [0.19.2] - 2026-07-18

### Fixed

- The compact widget now auto-dismisses when a squad is accepted as done through `squad_review`. Review-pending, review-failed, and failed squads keep the widget because they require attention, and explicitly selecting a done squad still displays it.

## [0.19.1] - 2026-07-18

### Fixed

- `squad-plan` validator now works from an installed package: Node refuses TypeScript type stripping under `node_modules`, so `validate-spec.mjs` stages the real validator sources in a temp directory before importing them. Validation output is byte-identical.

## [0.19.0] - 2026-07-18

### Added

- `squad-plan` skill: authoring guide for inline plans and strict v1 file specifications, an error→fix map, and a bundled `validate-spec.mjs` that runs the exact tool validator and prints the ready-to-use `specSha256`.

### Fixed

- The `squad` tool now accepts JSON-encoded strings for `tasks`, `agents`, and `config` and decodes them with precise per-field errors, so transports that stringify structured arguments no longer fail valid plans (`tasks: must be array`). Verified live: a real Opus 4.8 session emitted stringified tasks unprompted and the squad started correctly.

### Changed

- Agent `model`/`thinking` now follow configuration unless the user explicitly requests otherwise: the planner prompt, squad tool schema/guidelines, and skills all instruct omitting overrides so agent definitions and `/squad defaults` apply.

## [0.18.0] - 2026-07-18

### Added

- Squad completion reports now include a Working Tree Snapshot (`git diff --stat` plus untracked-file count) when the squad cwd is a Git repository; non-repository output is unchanged and task handoffs are never truncated.
- Continuous integration workflow running the full test suite on pushes to `main` and all pull requests.
- This changelog, backfilled for v0.16.5 through v0.17.2, and shipped in the npm package.

### Fixed

- Schedulers reconstructed through the panel and Ctrl+Q paths are now registered and event-wired, so their review/failure/reply/escalation notifications reach the main session instead of being silently dropped.

### Changed

- Refactored the extension into focused modules (`runtime`, `tools-registration`, `commands`, `lifecycle`, `panel-runtime`, `scheduler-runtime`, `start-squad`); `src/index.ts` is now a thin composition root. Behavior, tool schemas, and command surface are unchanged.
- `reviveScheduler()` is the single authoritative scheduler reconstruction helper; `handleAgentEvent` is a thin dispatcher over per-event handlers.

### Removed

- Dead `supervisor.ts` auto-approval stub and the unused squad knowledge/memory persistence feature (never written by any caller). Legacy `knowledge/` directories in existing squad state remain ignored safely.

## [0.17.2] - 2026-07-18

### Fixed

- Persisted the squad master switch across sessions and enforced it consistently for commands, tools, recovery, and the panel.

## [0.17.1] - 2026-07-17

### Fixed

- Synchronized squad widget and panel focus so the active squad remains consistent across UI interactions and cancellation.

## [0.17.0] - 2026-07-17

### Added

- Added attested file-based squad specifications, including canonical chunk delivery and full-read verification for child agents.

## [0.16.7] - 2026-07-17

### Fixed

- Hardened exact squad targeting and preserved paused or suspended work for explicit operator attention.

## [0.16.6] - 2026-07-17

### Fixed

- Repaired dependency state after task cancellation so downstream tasks are updated consistently.

## [0.16.5] - 2026-07-16

### Fixed

- Kept failed-review rework in the original squad, preserving task ownership and durable session continuity.

[Unreleased]: https://github.com/picassio/pi-squad/compare/v0.19.2...HEAD
[0.19.2]: https://github.com/picassio/pi-squad/compare/v0.19.1...v0.19.2
[0.19.1]: https://github.com/picassio/pi-squad/compare/v0.19.0...v0.19.1
[0.19.0]: https://github.com/picassio/pi-squad/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/picassio/pi-squad/compare/v0.17.2...v0.18.0
[0.17.2]: https://github.com/picassio/pi-squad/compare/v0.17.1...v0.17.2
[0.17.1]: https://github.com/picassio/pi-squad/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/picassio/pi-squad/compare/v0.16.7...v0.17.0
[0.16.7]: https://github.com/picassio/pi-squad/compare/v0.16.6...v0.16.7
[0.16.6]: https://github.com/picassio/pi-squad/compare/v0.16.5...v0.16.6
[0.16.5]: https://github.com/picassio/pi-squad/compare/v0.16.4...v0.16.5
