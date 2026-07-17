# File-based squad specification and full-read attestation contract

Status: implementation contract (v1)  
Target: pi-squad on Pi 0.80.10  
Non-goal: session compaction, summarization, semantic truncation, or proof based on prompts/`grep`/ordinary `read`.

## 1. Decisions and invariants

1. `squad` gains a mutually exclusive file form: `{ specFile, specSha256 }`. The call does not repeat the goal, tasks, descriptions, source, logs, or Base64.
2. The caller's SHA-256 is over the **original file bytes**. Those validated bytes, unchanged, become the canonical spec. “Canonical” means the immutable authoritative copy, not JSON reserialization.
3. A file squad is not schedulable until the source and referenced artifacts validate and the canonical copy plus squad/task state have been atomically published.
4. Every non-cancelled task in a file squad, including later-added, rework, and retest tasks, requires a valid task-owned read attestation for the squad's one canonical spec before it can become `done`.
5. A file child starts with a small manifest/bootstrap prompt, not duplicated goal/task contract text. Before attestation, the only executable tool is the child-only `squad_spec_read` tool.
6. Reading may occur in any chunk order. Completion requires the exact deterministic set once; duplicate valid reads are harmless. Missing, malformed, or tampered chunks never advance coverage.
7. Legacy inline squads have no `squad.spec`; no reader, guard, or attestation is required. Existing task sessions and mailbox behavior remain unchanged.
8. No layer silently truncates contract bytes, tool results, task output, or mail. A limit violation is an error directing the caller to artifact references.

The transport motivation is the observed 1.34–1.96 MB provider requests and failed large inline squad call described in [[pi-openai-codex-websocket-errors-large-sessions-20260717]].

## 2. Public `squad` call schema

The registered TypeBox schema MUST be equivalent to this JSON Schema. The two forms are exclusive (`additionalProperties: false` on each branch).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["goal"],
      "properties": {
        "goal": { "type": "string" },
        "agents": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "model": { "type": "string" },
              "thinking": { "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }
            }
          }
        },
        "tasks": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "title", "agent"],
            "properties": {
              "id": { "type": "string" },
              "title": { "type": "string" },
              "description": { "type": "string" },
              "agent": { "type": "string" },
              "depends": { "type": "array", "items": { "type": "string" } },
              "inheritContext": { "type": "boolean" }
            }
          }
        },
        "config": {
          "type": "object",
          "additionalProperties": false,
          "properties": { "maxConcurrency": { "type": "integer", "minimum": 1 } }
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["specFile", "specSha256"],
      "properties": {
        "specFile": { "type": "string", "minLength": 1 },
        "specSha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
      }
    }
  ]
}
```

Uppercase hashes are rejected rather than normalized. The file form never invokes the planner and does not remap unknown agents.

## 3. Specification schema (`schemaVersion: 1`)

Validation is strict. JSON duplicate object keys, a BOM, invalid UTF-8, non-finite/non-JSON values, trailing non-whitespace, and unknown properties are malformed. A duplicate-key-aware parser is required; `JSON.parse` alone is insufficient.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "goal", "tasks", "agents", "config", "artifacts"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "goal": { "type": "string", "minLength": 1 },
    "tasks": {
      "type": "array",
      "minItems": 1,
      "maxItems": 128,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "title", "description", "agent", "depends", "inheritContext", "artifactRefs"],
        "properties": {
          "id": { "type": "string", "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
          "title": { "type": "string", "minLength": 1 },
          "description": { "type": "string" },
          "agent": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
          "depends": { "type": "array", "uniqueItems": true, "items": { "type": "string" } },
          "inheritContext": { "type": "boolean" },
          "artifactRefs": { "type": "array", "uniqueItems": true, "items": { "type": "string" } }
        }
      }
    },
    "agents": {
      "type": "object",
      "maxProperties": 64,
      "propertyNames": { "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "required": ["model", "thinking"],
        "properties": {
          "model": { "type": ["string", "null"] },
          "thinking": { "enum": [null, "off", "minimal", "low", "medium", "high", "xhigh", "max"] }
        }
      }
    },
    "config": {
      "type": "object",
      "additionalProperties": false,
      "required": ["maxConcurrency", "autoUnblock", "maxRetries"],
      "properties": {
        "maxConcurrency": { "type": "integer", "minimum": 1, "maximum": 64 },
        "autoUnblock": { "type": "boolean" },
        "maxRetries": { "type": "integer", "minimum": 0, "maximum": 20 }
      }
    },
    "artifacts": {
      "type": "array",
      "maxItems": 1024,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "path", "sha256", "bytes", "purpose"],
        "properties": {
          "id": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
          "path": { "type": "string", "minLength": 1 },
          "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
          "bytes": { "type": "integer", "minimum": 0 },
          "purpose": { "type": "string", "minLength": 1 },
          "mediaType": { "type": "string", "minLength": 1 }
        }
      }
    }
  }
}
```

Additional semantic validation:

- Task IDs and artifact IDs are unique. Dependencies name existing tasks, exclude self, and form a DAG. Every task agent is a key in `agents` and resolves to a present, enabled agent definition; no fallback/remap.
- Every `artifactRefs` value names an artifact. Unreferenced artifacts are allowed for squad-wide context.
- `agents` MUST contain every assigned agent; extra valid roster entries are allowed.
- Artifact paths contain no NUL and are absolute under the host platform's native rules. Windows accepts drive-rooted and UNC absolute paths, rejects drive-relative paths; POSIX requires `/`. Preserve the exact string in spec bytes; use `path.normalize` only for access/comparison, never rewrite the canonical bytes.
- `reviewOnComplete` is intentionally absent and remains unconditionally true in persisted runtime config.
- For file squads, later `squad_modify add_task` IDs MUST satisfy the same task-ID pattern before any path construction. Generated rework/retest IDs must also be validated for the pattern/length (reject rather than truncate or collide).
- Run existing `validatePlan` structural checks. Its stylistic rules may produce warnings, but schema, graph, identity, size, and hash errors are fatal.

## 4. Size and artifact-reference policy

All limits are UTF-8 byte limits, checked before scheduling:

| Item | Limit |
|---|---:|
| canonical spec file | 1,048,576 bytes |
| `goal` | 65,536 bytes |
| one task `title` | 1,024 bytes |
| one task `description` | 131,072 bytes |
| cumulative `goal` + titles + descriptions + artifact purposes | 524,288 bytes |
| one artifact path | 32,768 bytes |
| tasks / agents / artifacts | 128 / 64 / 1024 |

Logs, source trees, binaries, images, generated fixtures, and Base64/data-URI payloads do not belong in text fields. Fields exceeding a limit MUST be moved to one or more `artifacts` entries with exact absolute path, byte length, and SHA-256. Reject over-limit input with the measured and allowed byte counts; never slice it. Reject a Base64/data-URI-like run longer than 4,096 characters in `goal`, `title`, `description`, or `purpose`, even when the total field is under its cap. Ordinary prose/source-like text is not rejected merely for being long.

At creation, every artifact is opened and verified as a regular, non-symlink file using the same stable-read rules as the source spec. A missing, changed, byte-length-mismatched, or hash-mismatched artifact rejects creation. Artifacts remain external and are not copied. Consumers must hash an artifact immediately before use; a later mutation is an explicit integrity error, never permission to use different bytes.

## 5. Stable source read and atomic publication

### Source and artifact reads

For each input path:

1. Resolve a relative `specFile` against the main tool call's `ctx.cwd`; artifact paths must already be absolute. Reject NUL.
2. `lstat` the final component and reject symbolic links/reparse-point links and non-regular files. Open read-only with `O_NOFOLLOW` where supported. On platforms without it, open then compare pre-open `lstat` identity to `fstat` identity; reject uncertainty or mismatch.
3. Record identity, size, mtime/ctime, read all bytes from the open descriptor with no library truncation, then `fstat` again. Reject if identity, size, mtime, or ctime changed. Hash the bytes read and compare byte count and lowercase SHA-256.
4. Decode the spec with a fatal UTF-8 decoder and validate it. Do not reopen by pathname during this operation.

Opening the descriptor pins the object against path replacement; the before/after metadata check detects in-place writes. A final symlink is never followed. Parent-directory symlinks are permitted for a user-supplied source path because the opened identity is pinned; all destination components are controlled by pi-squad.

### Destination

- Add `Squad.spec?: { schemaVersion: 1; sha256: string; bytes: number; path: string; chunkBytes: 32768; chunkCount: number }` where `path` is the absolute canonical path.
- Derive the squad ID with existing `makeTaskId(goal)` only when it is nonempty and path-safe; otherwise use `squad-<first 12 spec-hash hex>`. Resolve collisions with the existing unique suffix before staging. The final ID must match `^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$` and its resolved directory must be an immediate child of the squad root.
- Canonical location: `<squad-root>/<squad-id>/spec/spec.v1.json`. After resolving/normalizing, assert it remains beneath that exact squad directory.
- Build the entire new squad under a sibling staging directory created with exclusive semantics, e.g. `<squad-id>.creating.<uuid>`, mode `0700` where supported. Write canonical bytes with `wx`/mode `0600`, fsync the file, write squad/task JSON atomically, fsync the staging directories, then rename the staging directory to the not-yet-existing final squad directory. Never schedule from staging.
- If final ID exists, choose the unique ID before staging. Never merge or overwrite. Clean abandoned staging directories only after proving their name/shape and that no published squad references them.
- After publication, make the canonical file read-only (`0400`/best effort on Windows). Immutability is enforced primarily by exclusive creation and by verifying `bytes` and SHA-256 on every reader/attestation/settlement path. Any mismatch quarantines the squad from scheduling/acceptance.
- Preserve original bytes exactly, including insignificant JSON whitespace and final newline. `specSha256` and `Squad.spec.sha256` therefore identify exactly what children receive.

Creation failures leave no discoverable squad and start no scheduler/child. Error results identify the class (`SPEC_MALFORMED`, `SPEC_HASH_MISMATCH`, `SPEC_UNSTABLE`, `SPEC_TOO_LARGE`, `ARTIFACT_*`, `PLAN_INVALID`, `PUBLISH_FAILED`) without leaking file contents.

## 6. Child environment, loading, and bootstrap

For a file squad, `AgentPool.spawn` supplies:

```text
PI_SQUAD_CHILD=1
PI_SQUAD_ID=<exact squad id>
PI_SQUAD_TASK_ID=<exact task id>
PI_SQUAD_SPEC_PATH=<absolute canonical path>
PI_SQUAD_SPEC_SHA256=<64 lowercase hex>
PI_SQUAD_SPEC_BYTES=<decimal byte length>
PI_SQUAD_SPEC_CHUNK_BYTES=32768
```

Do not place spec content in argv or environment. Values originate from persisted state, not a prompt. The package extension entry behaves as follows:

- main process: register existing squad tools;
- child without all spec variables (legacy): return exactly as today;
- child with all spec variables: register only the non-recursive reader and guard; never register `squad`, squad commands, scheduler, widget, or nested orchestration.

Pi 0.80.10 package loading must remain sufficient; do not require a global settings edit. If an agent definition has a `--tools` allowlist, force-add `squad_spec_read` for a file child. The child prompt contains only the manifest (IDs, hash, bytes, chunk count), reader usage, and dynamic non-spec messages. `buildSquadProtocol`, `buildTaskSection`, and the first RPC prompt MUST NOT inline `goal`, task descriptions, sibling descriptions, or other spec fields in file mode.

A task added after creation or generated by rework/retest still reads the same canonical spec. Its dynamic task/mailbox delta may be delivered normally and remains task-owned; it does not alter canonical bytes.

## 7. Deterministic UTF-8 chunk protocol

Tool name: `squad_spec_read`. It exists only in a file-spec child.

Input schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["index"],
  "properties": { "index": { "type": "integer", "minimum": 0 } }
}
```

Chunk construction over canonical raw bytes, with `C = 32768`:

```text
start[0] = 0
candidate = min(start[i] + C, byteLength)
while candidate < byteLength and (bytes[candidate] & 0xC0) == 0x80:
    candidate -= 1
end[i] = candidate
start[i+1] = end[i]
```

The already-validated UTF-8 guarantees progress and decoding. Chunks are contiguous, nonempty, code-point aligned, cover `[0, byteLength)` exactly once, and are independent of newline layout. `chunkCount` is computed from this algorithm, not `ceil(bytes/C)`.

Before every read, the tool securely opens the canonical file and verifies whole-file byte length/hash. An out-of-range index or integrity failure is an error and records no coverage. A successful result is:

```json
{
  "content": [
    { "type": "text", "text": "{\"version\":1,\"squadId\":\"...\",\"taskId\":\"...\",\"index\":0,\"chunkCount\":2,\"startByte\":0,\"endByteExclusive\":32768,\"chunkBytes\":32768,\"chunkSha256\":\"...\",\"specBytes\":40000,\"specSha256\":\"...\"}" },
    { "type": "text", "text": "<exact fatal-UTF-8 decoding of raw chunk bytes>" }
  ],
  "details": { "same typed metadata as content[0], not the chunk text" }
}
```

The first text block is compact JSON in the fixed key order shown; the second is the exact chunk text. No prefix, suffix, elision, or viewport truncation is permitted in the second block. Per-chunk SHA-256 is over raw chunk bytes; whole-file SHA-256 is over canonical raw bytes.

Reads may be requested in any order and concurrently. The reader is idempotent. A duplicate with identical metadata/hash leaves the original delivery record unchanged; a conflicting duplicate invalidates progress and blocks the task.

## 8. Tool guard and Pi 0.80.10 parallel semantics

The child extension installs a `tool_call` handler. While complete attestation is absent or invalid:

- allow only `event.toolName === "squad_spec_read"` with the exact schema;
- return `{ block: true, reason: "Read every canonical squad spec chunk with squad_spec_read before using other tools." }` for **every** other tool, including `read`, `bash`, `grep`-capable commands, write/edit, browser/network, MCP/custom tools, and any tool added after startup;
- treat guard exceptions/state parse failures as blocked (fail closed).

Pi 0.80.10 guarantees sibling calls in a parallel assistant message are preflighted sequentially and only then execute concurrently. A sibling normal tool cannot rely on sibling reader results because those results do not exist during preflight; it is blocked. All requested chunks may run in parallel, but normal tools become eligible only in a later model turn after delivery commits. Mutating tool input is not used as authorization.

Tool execution alone is not delivery proof. Keep an untrusted pending record keyed by `toolCallId`; commit a chunk only when the extension observes the finalized successful tool-result `message_end` for that same call and verifies both returned content blocks byte-for-byte against a fresh canonical read. If the process crashes before commit, the chunk is read again. Partial RPC output, `tool_execution_start`, `tool_result`, and `tool_execution_end` alone do not count.

A child may emit text or attempt to settle without tools; Pi has no completion-block return from `tool_call`. Parent settlement enforcement below makes that incapable of completing the task.

## 9. Durable coverage and attestation state machine

Task-owned paths:

```text
<squad-dir>/<task-id>/spec-read-state.json
<squad-dir>/<task-id>/spec-read-attestation.json
```

Use the store's cross-process lock plus atomic temp-write/fsync/rename discipline. State is bound to `{squadId, taskId, specSha256, specBytes, chunkBytes, chunkCount}`. Mismatch means `INVALID`, never migration to a different spec.

States:

```text
NOT_REQUIRED (legacy squad only)
REQUIRED -> READING -> COMPLETE
   |          |           |
   +----------+-----------+--> INVALID (identity/hash/schema/conflicting record)
```

- `REQUIRED`: zero committed chunks.
- `READING`: a durable set of valid committed chunk indices. Order is irrelevant.
- `COMPLETE`: all deterministic indices are present; offsets are contiguous; concatenated raw chunk hashes recompute the whole canonical hash. Atomically write the attestation, then treat the guard as open.
- `INVALID`: fail closed. A canonical mismatch quarantines the squad. A corrupt progress file may be moved aside for audit and reset to `REQUIRED` only after the canonical file verifies; a conflicting/tampered claimed delivery is never accepted.

Exact complete attestation schema:

```json
{
  "version": 1,
  "state": "complete",
  "squadId": "squad-id",
  "taskId": "task-id",
  "specSha256": "64-lowercase-hex",
  "specBytes": 40000,
  "chunkBytes": 32768,
  "chunkCount": 2,
  "chunks": [
    {
      "index": 0,
      "startByte": 0,
      "endByteExclusive": 32768,
      "bytes": 32768,
      "sha256": "64-lowercase-hex",
      "toolCallId": "pi-tool-call-id",
      "deliveredAt": "RFC3339 timestamp"
    }
  ],
  "completedAt": "RFC3339 timestamp"
}
```

`chunks` is stored in ascending index order regardless of delivery order and contains exactly `chunkCount` entries. Unknown properties, duplicate indices, gaps, overlaps, wrong offsets/lengths, wrong hashes, an invalid timestamp, or wrong identity make it invalid. Redundant reads after `COMPLETE` may return content but do not rewrite `completedAt` or the original chunk record.

Restart behavior:

- Durable committed progress survives child/main crashes. Pending executions do not.
- A resumed process for the task's immutable Pi session may trust a still-valid complete task attestation after re-verifying the canonical whole hash; it need not reread. This preserves task-owned session semantics while proving that exact session/task previously received all tool results.
- Incomplete progress resumes at any missing indices. The bootstrap reports the complete sorted missing-index list (never a truncated list).
- A new task/rework/retest has independent state even when assigned to the same agent.

## 10. Parent settlement, review, pause, cancellation, and recovery

All completion paths share `validateTaskSpecAttestation(squad, task)`; do not enforce only in one event handler.

1. On child `agent_settled`, before extracting/promoting output or unblocking dependents, validate canonical bytes and the task attestation. If missing/invalid, reject candidate completion, append a durable status reason, leave `completed = null`, set the task back to `pending`, and reopen the same task-owned session. Never copy candidate output to `Task.output` as accepted output.
2. `squad_modify complete_task` performs the same check and rejects without status mutation when required attestation is absent/invalid.
3. `checkSquadCompletion` may enter review only if every non-cancelled `done` task has a valid attestation. Discovery of a missing/tampered attestation reopens that task and transitively invalidates/re-blocks completed descendants using existing dependency semantics.
4. `squad_review` revalidates all required attestations and canonical bytes before recording any verdict. On failure it rejects the review and reopens affected work; a stale pending review cannot bypass recovery.
5. Parent restart reconciliation performs the same audit for file squads in `running`, `failed`, `paused`, or `review`. It does not automatically resume explicitly `suspended` tasks, preserving pause semantics. It does not revive `cancelled` tasks; cancelled tasks are excluded from completion just as today.
6. Explicit `resume_task` continues the same durable session and coverage state. `pause_task`, whole-squad pause, exact cancellation, mailbox delivery, descendant invalidation, failed-review rework, and main review retain their current targeting and ordering semantics.
7. If settlement repeatedly occurs without attestation, it repeatedly remains non-completing/recoverable; it can be paused or cancelled normally. It is never converted to `done` merely to stop a loop.

A valid attestation proves delivery of bytes into the task's Pi tool-result context, not human-like semantic comprehension. That is the strongest mechanically enforceable claim and is intentionally stronger than prompt instructions or filesystem access logs.

## 11. Compatibility and security matrix

| Case | Required behavior |
|---|---|
| Legacy `{goal,...}` call/task/session | Existing planner, prompts, sessions, mailboxes, and settlement; no attestation required |
| File call also contains `goal`/`tasks` | Schema rejection; no squad directory/scheduler |
| Missing/malformed/duplicate-key/invalid-UTF-8 spec | Reject before publish/schedule |
| Wrong caller hash / uppercase hash | Reject before publish/schedule; no normalization |
| Oversized embedded contract/Base64/data URI | Reject with measured limit; require artifact ref; never truncate |
| Missing/wrong/tampered artifact at creation | Reject before publish/schedule |
| Final-component symlink or non-regular source/artifact | Reject |
| Path replaced during read | Open descriptor identity remains pinned; mismatch/metadata change rejects |
| Canonical file changed after publish | Reader, scheduler, completion, and review fail closed/quarantine |
| Windows drive-relative path / NUL / POSIX relative artifact | Reject; native absolute path rules only |
| Chunk order `N-1..0` | Allowed; final attestation sorted and full coverage verified |
| Duplicate identical chunk | Idempotent; no coverage inflation |
| Missing chunk / out-of-range index | No complete attestation; all normal tools blocked |
| Tampered chunk metadata/text/hash | No commit; conflicting record invalidates progress |
| `grep`, ordinary `read`, or `bash cat spec` before completion | Blocked by all-tool preflight guard; cannot count as proof |
| All reads plus normal tool in one parallel assistant message | Reads may execute; normal sibling was preflighted before results and is blocked |
| Crash before finalized tool-result `message_end` | Pending chunk does not count; reread after restart |
| Crash after durable chunk commit | Coverage resumes without losing committed chunks |
| Complete task session resumed in a new child process | Reverify canonical + attestation; normal tools allowed without redundant reread |
| Child settles with prose only | Parent rejects/reopens; no output promotion/dependent unblock |
| Attestation deleted/tampered after task done | Reconciliation/review reopens task and invalidates descendants |
| Explicitly paused/suspended task on restart | Remains suspended; no auto-resume solely for attestation |
| Cancelled task without attestation | Remains cancelled and excluded under existing semantics |
| Added/rework/retest task in file squad | Fresh task-owned attestation required for same canonical spec |
| Agent tool allowlist omits reader | Spawn force-adds reader; guard remains authoritative |
| Attempted recursive squad from child | Squad tools not registered; pre-attestation guard would also block them |

## 12. Required verification coverage

Implementation is incomplete unless tests cover:

- schema success/failure, duplicate keys, UTF-8/BOM, hash mismatch, total/field/Base64 limits, artifact refs, graph/agent failures;
- stable-descriptor reads, symlink rejection, path replacement/in-place mutation, atomic no-partial publication, existing-ID collision, POSIX and mocked/native Windows path cases;
- multibyte characters on every possible boundary shape, exact concatenated bytes, per-chunk and whole hashes, reverse/random/concurrent order, duplicate/missing/out-of-range/tampered chunks;
- child extension/RPC package loading on Pi 0.80.10, reader forced into a tool allowlist, all-tool blocking (including grep/bash/read/custom), parallel preflight, textual early settlement;
- commit only after finalized tool-result delivery, crash before/after commit, main and child restart, incomplete resume, complete same-session resume;
- missing/tampered attestation at `agent_settled`, manual completion, completion-to-review, and review acceptance; descendant recovery;
- exact pause/resume/cancellation/mailbox behavior, new/rework/retest tasks, and legacy inline compatibility;
- `npm test`, child-process RPC integration, and `npm pack --dry-run` proving the child guard/runtime and documentation are included.
