---
name: backend-dev
description: >
  Backend engineering practices — API design, database patterns, auth implementation,
  input validation, error handling, and security. Use when building APIs, servers,
  databases, or backend services.
version: 1.0.0
---

# Backend Development

## API Design
- RESTful conventions: GET (read), POST (create), PUT (replace), PATCH (update), DELETE (remove)
- Consistent response format: success returns data directly, errors return `{ error: string, code?: string }`
- Validate all inputs at the boundary (use zod, joi, or manual checks)
- Paginate list endpoints (limit/offset or cursor-based)
- Use proper HTTP status codes: 200 OK, 201 Created, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 500 Server Error
- Document every endpoint in your completion output (method, path, request/response shape)

## Database
- Use migrations for schema changes (never ALTER in application code)
- Add indexes for frequently queried columns and foreign keys
- Use foreign keys with appropriate ON DELETE behavior (CASCADE, SET NULL)
- Use transactions for multi-step writes
- Sanitize all user inputs in queries (parameterized queries, never string interpolation)

## Authentication
- Never store passwords in plain text — use bcrypt with sufficient rounds (10+)
- JWT access tokens: short-lived (15min), stateless verification
- Refresh tokens: longer-lived (7d), stored server-side, rotated on use
- Validate tokens on every protected endpoint via middleware
- Return 401 for invalid/expired tokens, 403 for insufficient permissions

## Error Handling
- Catch errors at route level, don't let unhandled rejections crash the server
- Log errors with context (request id, user id, endpoint)
- Never expose stack traces or internal details in API responses
- Use typed error classes for different error categories
- Implement graceful shutdown (close DB connections, finish in-flight requests)

## Security
- Rate-limit public endpoints (login, register, password reset)
- Set security headers (CORS, Helmet for Express)
- Validate file uploads (type whitelist, size limits)
- Never log sensitive data (passwords, tokens, PII)
