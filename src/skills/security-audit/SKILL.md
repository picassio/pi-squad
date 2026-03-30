---
name: security-audit
description: >
  Security audit checklist, vulnerability patterns, and remediation guidance.
  Use when reviewing code for security issues, hardening an application,
  or performing security verification.
version: 1.0.0
---

# Security Audit

## Checklist
- [ ] No secrets in source code (API keys, passwords, tokens, connection strings)
- [ ] All user inputs validated and sanitized
- [ ] SQL injection prevention (parameterized queries, no string interpolation)
- [ ] XSS prevention (output encoding, CSP headers, no innerHTML with user data)
- [ ] Authentication on all protected endpoints
- [ ] Authorization checks (can THIS user perform THIS action on THIS resource?)
- [ ] Rate limiting on public endpoints (login, register, password reset)
- [ ] Secure headers configured (CORS, HSTS, X-Frame-Options, X-Content-Type-Options)
- [ ] File upload validation (type whitelist, size limits)
- [ ] Error messages don't leak internal details (stack traces, SQL errors, file paths)
- [ ] Passwords hashed with bcrypt (not MD5, SHA1, or plain text)
- [ ] JWT tokens validated on every request (signature, expiry, issuer)
- [ ] Sensitive data not logged (passwords, tokens, credit cards)
- [ ] Dependencies checked for known vulnerabilities (npm audit)

## Common Vulnerabilities
- **Broken Access Control**: Missing auth checks, IDOR (accessing other users' data by changing IDs)
- **Injection**: SQL, NoSQL, command injection via unsanitized inputs
- **Broken Auth**: Weak passwords allowed, no rate limiting on login, tokens never expire
- **Security Misconfiguration**: Default credentials, verbose error pages, unnecessary features enabled
- **Sensitive Data Exposure**: Secrets in client-side code, PII in logs, HTTP instead of HTTPS

## Reporting Format
```
## Security Finding: [Title]
**Severity**: Critical | High | Medium | Low
**Location**: [file:line or endpoint]
**Description**: What's wrong
**Impact**: What could happen if exploited
**Remediation**: How to fix it (specific code change)
```
