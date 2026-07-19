# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Generated squad IDs now trim a separator introduced at the 40-character truncation boundary, preventing valid file-spec squads from failing publication with `PUBLISH_FAILED: unsafe squad id`.

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
