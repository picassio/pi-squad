---
name: squad-plan
description: Author valid pi-squad plans — inline task arrays and strict v1 file specifications. Use when creating a squad plan, writing a squad spec JSON, choosing between inline tasks and specFile, computing specSha256, or debugging squad validation errors (must be array, SPEC_MALFORMED, SPEC_HASH_MISMATCH, Plan rejected).
---

# Squad Plan Authoring

Two ways to start a squad. Pick one:

| Form | When |
|---|---|
| **Inline** `squad({ goal, tasks?, agents?, config? })` | Normal plans. Goal + tasks fit comfortably in a tool call. |
| **File spec** `squad({ specFile, specSha256 })` | Large contracts, many tasks, exact-bytes requirements, or when your transport keeps mangling inline arguments. Children mechanically attest full spec reading. |

## Planner rules (both forms)

- 3–7 tasks is usually right (hard limit 128 in file specs; >9 warns).
- First task(s) have empty `depends`. No cycles; every dependency must name an existing task id.
- When tasks share an interface (API, schema, format), add a design/contract task first and make consumers depend on it.
- Add a final QA/verification task for user-facing changes.
- Task ids: short kebab-case (`setup-db`, `auth-middleware`). File specs enforce `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`.
- Structure descriptions as: Goal (outcome first), Context (files to read), Output (deliverable), Boundaries (what must not change), Verify (proving command).
- Every task's `agent` must name an existing agent definition (defaults: architect, backend, debugger, devops, docs, frontend, fullstack, qa, researcher, reviewer, security).
- **Model/thinking come from configuration.** Omit inline `agents` overrides and keep file-spec entries at `{ "model": null, "thinking": null }` unless the user explicitly asked for a specific model or thinking level. Configured values resolve as: squad-plan override (only if set) → agent definition (`~/.pi/squad/agents/*.json` or project `.pi/squad/agents/`) → `/squad defaults` policy in `~/.pi/squad/settings.json`.

## Inline form

```json
{
  "goal": "Complete user outcome/acceptance contract, preserved for review",
  "tasks": [
    { "id": "api-contract", "title": "Define API contract", "agent": "architect", "depends": [] },
    { "id": "build-api", "title": "Implement API", "agent": "backend", "depends": ["api-contract"],
      "description": "Goal: ... Context: ... Output: ... Boundaries: ... Verify: ..." },
    { "id": "qa", "title": "Verify end to end", "agent": "qa", "depends": ["build-api"] }
  ],
  "config": { "maxConcurrency": 2 }
}
```

- `tasks`, `agents`, and `config` must be real JSON structures. If your transport stringifies them, pi-squad also accepts JSON-encoded strings for these three fields and decodes them — but prefer real structures.
- Omitting `tasks` runs the planner agent on `goal`.
- `Plan rejected:` errors list exact structural problems (duplicate ids, unknown dependency, cycle, no entry task). Fix and resubmit; warnings (`⚠️`) don't block.

## File-spec form (strict v1)

Validation is strict and fail-closed: unknown keys, missing keys, duplicate JSON keys, a UTF-8 BOM, invalid UTF-8, or a wrong hash all reject before anything is scheduled. **Every field below is required — including empty ones.**

```json
{
  "schemaVersion": 1,
  "goal": "Complete acceptance contract...",
  "tasks": [
    {
      "id": "api-contract",
      "title": "Define API contract",
      "description": "Goal: ... Verify: ...",
      "agent": "architect",
      "depends": [],
      "inheritContext": false,
      "artifactRefs": []
    }
  ],
  "agents": {
    "architect": { "model": null, "thinking": null }
  },
  "config": { "maxConcurrency": 2, "autoUnblock": true, "maxRetries": 2 },
  "artifacts": []
}
```

Rules that trip people up:

- Every agent used by a task must appear in `agents`, each entry exactly `{ "model": string|null, "thinking": null|"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max" }`. Use `null`/`null` (configured defaults) unless the user explicitly requested a specific model or thinking level.
- `config` needs all three keys: `maxConcurrency` (1–64), `autoUnblock` (boolean), `maxRetries` (0–20).
- Each task needs all seven keys, even when `description` is `""` and `artifactRefs` is `[]`.
- No Base64 blobs or oversized embedded content (spec ≤ 1 MiB; embedded text budgets enforced). Reference big content via `artifacts`: absolute `path`, exact lowercase `sha256`, exact `bytes`, nonempty `purpose`.
- `specSha256` is the SHA-256 of the exact file bytes, 64 lowercase hex chars. Write the file first, hash second, never edit afterward.

## Workflow: write → validate → call

1. Write the spec to a file (UTF-8, no BOM). Generate it with a script (`JSON.stringify`) rather than by hand to avoid duplicate keys and escaping mistakes.
2. Validate with the bundled validator — it runs the exact same code the squad tool runs and prints the ready-to-use hash:

```bash
node <skill-dir>/validate-spec.mjs /path/to/spec.v1.json
```

On success it prints `VALID`, the `specSha256`, and the exact `squad(...)` call. On failure it prints the same `SPEC_MALFORMED`/`SPEC_TOO_LARGE`/`ARTIFACT_*` error the tool would return — fix and re-run.

3. Call `squad({ specFile, specSha256 })` with the printed values. Do not restate the contract inline.

## Error → fix map

| Error | Fix |
|---|---|
| `tasks: must be array` (tool validation) | Transport stringified your array — send a real array, or pass the JSON string (accepted), or use a file spec. |
| `SPEC_HASH_MISMATCH` | File changed after hashing, or hash uppercase/wrong. Re-run the validator; use its printed hash. |
| `SPEC_MALFORMED: unknown/requires ...` | Add every required key exactly; remove extras. See the full example above. |
| `SPEC_MALFORMED: duplicate task id / invalid dependency / cycle` | Fix the task graph; dependencies reference ids in this spec only. |
| `SPEC_MALFORMED: task X uses undeclared agent Y` | Add Y to `agents` with `{ "model": null, "thinking": null }`. |
| `SPEC_TOO_LARGE` | Move large content to `artifacts` (path + sha256 + bytes) and reference via `artifactRefs`. |
| `Plan rejected:` (inline) | Structural plan errors listed verbatim — apply each fix. |
