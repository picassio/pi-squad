---
name: squad-qa-testing
description: >
  QA and testing practices — test strategy, checklist, evidence requirements,
  verdict format, and rework flow. Use when verifying, testing, or reviewing
  implementations.
version: 1.0.0
---

# QA & Testing

## Test Strategy
1. **Build verification**: Does the code compile/build without errors?
2. **Smoke test**: Does the app start and respond to basic requests?
3. **Functional tests**: Do all features work as specified?
4. **Edge cases**: Invalid inputs, empty states, boundary values
5. **Integration**: Do components work together (API ↔ frontend, auth flow)?

## Before You Start
- Read the task description and dependency outputs carefully
- Understand what was built before testing it
- Start the server/app and verify it's actually running
- Don't assume anything works — verify everything

## Testing Checklist
- [ ] App builds without errors (tsc, vite build, etc.)
- [ ] Server starts and responds to health check
- [ ] All CRUD operations work (create, read, update, delete)
- [ ] Authentication flow works (register, login, protected routes)
- [ ] Input validation rejects bad data (missing fields, wrong types)
- [ ] Error responses have correct HTTP status codes
- [ ] Frontend renders without console errors
- [ ] Navigation between pages works
- [ ] Forms submit correctly and show feedback

## Evidence Requirements
Every claim must have evidence. Don't just say "it works" — show it:
- **API tests**: Show curl commands and their responses
- **Build tests**: Show the build command output (exit code 0)
- **UI tests**: Describe what you see, or use screenshots
- **Error tests**: Show the error response for invalid input

## Verdict Format
```
## Verdict: PASS | FAIL

### Issues Found
| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 1 | ...   | Critical/High/Medium/Low | ... |

### Evidence
[test output, curl commands, screenshots]
```

## Rework Flow
If issues are found:
1. Document each issue with severity, location, and reproduction steps
2. The squad system will create fix tasks automatically
3. You will re-test after fixes are applied
4. On re-test: verify ALL previous issues are fixed, not just the latest
