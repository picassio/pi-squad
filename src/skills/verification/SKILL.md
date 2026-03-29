---
name: verification
description: Verify work before claiming completion — evidence-based discipline for multi-agent handoffs.
---

# Verification

Before claiming your task is done, verify that your work actually works.
Your output gets passed to dependent tasks. If it's wrong, the entire chain fails.

## The Protocol

1. **IDENTIFY**: What command or test proves the work is correct?
2. **RUN**: Execute it fresh — don't rely on earlier results
3. **READ**: Check the full output, not just the exit code
4. **VERIFY**: Does the output confirm your claim?
   - If NO: fix it, then re-verify
   - If YES: include the evidence in your output

## Red Flags — Stop If You Catch Yourself

- Using "should work", "probably correct", "looks right"
- Claiming done without running the code
- Assuming tests pass without executing them
- Expressing satisfaction before verification
- Saying "just this one time" about skipping verification

## Output Checklist

When completing a task, your final message must include:

1. **What you built/changed** — specific file paths
2. **How to verify** — exact command or steps
3. **Evidence** — actual output from running the verification

Example:
```
Created JWT middleware:
- src/lib/jwt.ts — token generation (RS256, 1h expiry)
- src/middleware/auth.ts — validation middleware
- test/auth.test.ts — 8 tests

Verification:
$ npm test -- test/auth.test.ts
✓ generates valid JWT (12ms)
✓ validates token signature (3ms)
✓ rejects expired tokens (5ms)
...
8 tests passed, 0 failed
```

## For Implementation Tasks

- Run the code, don't just write it
- Check for TypeScript/lint errors
- Run related tests if they exist
- Verify the feature works end-to-end, not just that it compiles

## For Research/Analysis Tasks

- Cite specific files and line numbers
- Include relevant code snippets as evidence
- State confidence level on uncertain findings
- List what you checked AND what you didn't check

## QA Verdict Format (REQUIRED for test/QA tasks)

Your final message MUST end with a structured verdict that automation can parse:

### If everything passes:
```
## Verdict: PASS
All N tests passing. No issues found.
```

### If tests fail:
```
## Verdict: FAIL

## Issues
1. **[file:line]** Description of the failure
   - Expected: X
   - Got: Y
2. **[file:line]** Another issue
   - Steps to reproduce: ...
```

### If tests pass but with concerns:
```
## Verdict: PASS WITH ISSUES

## Minor Issues
1. Description of concern (non-blocking)
```

The verdict line (`## Verdict: PASS/FAIL/PASS WITH ISSUES`) is **machine-parsed** by the squad system. When you output `FAIL`, the squad automatically creates a rework task for the original agent with your feedback, then re-tests after the fix. Make your Issues section **specific and actionable** — the fixing agent only sees your feedback.
