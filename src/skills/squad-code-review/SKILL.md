---
name: squad-code-review
description: >
  Code review methodology — two-pass review (correctness/scope, then
  over-engineering), surgical-change discipline, complexity findings with
  delete/stdlib/native/yagni/shrink tags, machine-parsed verdicts. Use when
  reviewing diffs, implementations, or pull requests.
version: 1.0.0
---

# Code Review

Two passes, in order. Findings from pass 1 gate the verdict; pass 2 findings
are usually non-blocking. Derived from the karpathy-guidelines and ponytail
review disciplines.

## Pass 1 — Correctness & Scope

**Every changed line must trace to the task.**
- Flag unrequested refactors, drive-by "improvements", formatting churn in
  untouched code, and deleted code the task didn't ask to remove
- Orphan check: did the change leave now-unused imports/variables/functions
  it created? (Pre-existing dead code is a mention, not a finding)

**Verify with evidence, not by reading.**
- Run the task's Verify criterion yourself (tests, build, curl). Your review
  is only as strong as the commands you ran
- Reproduce at least one happy path and one failure path where practical
- If you can't run something, say so explicitly — don't imply you did

**Assumptions and interpretations.**
- If the implementation silently picked one of several readings of the task,
  name the choice and whether it matches the task's Goal/Boundaries
- Check the task's Boundaries were respected (unchanged APIs, schemas, configs)

**Error handling in the right places.**
- Trust boundaries (user input, network, file I/O) must handle failure
- Impossible-scenario handling is noise — flag it in pass 2 as yagni

## Pass 2 — Complexity Hunt

Climb the ladder for each addition; stop at the first rung that holds:
need to exist? → already in codebase? → stdlib? → native platform? →
installed dep? → one line? → minimum that works.

One line per finding — location, what to cut, what replaces it:

- `delete:` dead code, unused flexibility, speculative feature → nothing
- `stdlib:` hand-rolled thing the standard library ships → name the function
- `native:` dep/code doing what the platform does → name the feature
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller
- `shrink:` same logic, fewer lines → show the shorter form

Example: `api.ts:L88: yagni: RepositoryFactory with one product. Inline it until a second exists.`

**Never flag as bloat**: trust-boundary validation, data-loss handling,
security, accessibility, or a minimal test. Lean is not careless.

If nothing to cut: `Lean already.` — don't invent findings to look thorough.

## Verdict (machine-parsed — REQUIRED)

End your final message with exactly:

```
## Verdict: PASS | FAIL | PASS WITH ISSUES

## Issues
1. **[file:line]** (Critical/High/Medium/Low) description
   - Expected: X
   - Got: Y
   - Fix: specific change

## Evidence
[commands run + output]
```

- **FAIL**: pass-1 problems (correctness, scope violations, broken Verify).
  Creates a rework task — the fixer only sees your Issues section
- **PASS WITH ISSUES**: works and in-scope, but pass-2 cuts are worth making
- **PASS**: correct, in scope, lean. Say what you verified
- Severity: correctness/security → Critical/High; complexity → Medium/Low
- Do not rename the sections — `## Issues` is extracted verbatim as fix feedback

## You Don't Fix

You report; the squad routes fixes to the original agent. Applying fixes
yourself would bypass the rework loop and confuse file ownership. If a fix
is truly one character, still report it — with the exact edit in the Fix line.
