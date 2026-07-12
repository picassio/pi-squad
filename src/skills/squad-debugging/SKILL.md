---
name: squad-debugging
description: >
  Debugging and rework discipline — reproduce-first workflow, hypothesis testing,
  minimal fixes, regression tests. Use when fixing bugs, handling QA feedback,
  working on rework/fix tasks, or investigating failures.
version: 1.0.0
---

# Debugging & Rework

## The Iron Rule: Reproduce First

Never change code before you've seen the failure with your own eyes.

1. **REPRODUCE**: Run the failing test, repro steps, or command from the QA
   feedback. Confirm you see the same failure. If you can't reproduce it,
   say so explicitly — don't "fix" what you can't observe.
2. **LOCALIZE**: Read the error, stack trace, or diff. Form ONE hypothesis
   about the cause. State it before changing anything.
3. **FIX**: Make the smallest change that addresses the hypothesized cause.
4. **VERIFY**: Re-run the exact reproduction from step 1 — it must now pass.
   Then run the surrounding test suite to catch regressions.
5. **PROTECT**: Add a regression test if none exists for this failure mode.

## Hypothesis Discipline

- One hypothesis at a time. If the fix doesn't work, REVERT it before trying
  the next hypothesis — never stack speculative changes
- If two hypotheses fail, stop and gather more evidence (add logging, isolate
  with a minimal test case) instead of guessing a third time
- Distinguish "the symptom moved" from "the cause is fixed" — re-run the
  ORIGINAL repro, not just your new test

## Rework Tasks (QA sent your work back)

- Fix ONLY the issues listed in the QA feedback — no rewrites, no opportunistic
  refactoring, no unrelated improvements
- Reproduce each reported issue before touching code (the feedback includes
  Expected/Got/Repro for each — use them)
- If a reported issue looks wrong or is not reproducible, say so explicitly
  with evidence instead of silently skipping it
- Your completion message must show each issue → what changed → re-run evidence

## Common Traps

- **Fixing the test instead of the code** — only adjust a test when you can
  argue the test itself was wrong, and say so
- **Shotgun debugging** — many small changes at once; you won't know which
  one mattered and you'll introduce new breakage
- **Environment blame** — "works on my machine" requires evidence: show the
  environment difference, don't assume it
- **Silent scope creep** — noticing other bugs is good; fixing them inside a
  rework task is not. Mention them so the squad can create tasks

## Output Checklist

Your completion message must include:
1. Each issue: root cause (one sentence) + the fix (file:line)
2. Evidence: the original failing command now passing (actual output)
3. Regression scope: which suites you ran and their results
