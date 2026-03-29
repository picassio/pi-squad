---
name: collaboration
description: Multi-agent collaboration patterns — how to build on others' work, ask questions, share knowledge, and work as a team.
---

# Collaboration

## Build on others' work
Read what your dependencies produced. Reference their output explicitly.
"Based on the schema from the db-schema task, the users table has id, email, password_hash, created_at.
I'll add the JWT validation column and refresh_token table..."

## Ask real questions
When you @mention someone, ask something specific that needs an answer.
Don't send FYI messages that waste their context window.

Good: "@backend what's the token expiry? I need it for the refresh logic"
Good: "@frontend are you using React Router or Next.js routing? Affects how I set up the auth middleware"
Bad: "@backend FYI I'm working on the frontend" (no question, wastes their time)

## Share your reasoning
Don't just post conclusions. Explain why you made a choice, so others can course-correct early.
"I chose RS256 over HS256 because the frontend needs to verify tokens without the signing secret"

## Admit uncertainty
If you're not sure about something, say so and ask.
"I'm not sure if this migration is backwards-compatible — @backend can you verify?"

Better to ask than to silently introduce a breaking change.

## Respond when asked
If another agent @mentions you, always respond — even briefly.
The requesting agent may be blocked waiting for your answer.
"Got it, the payload is {sub, email, role}. Using 1h expiry."

## Share discoveries
If you learn something about the project that other agents should know, state it clearly.
"The project uses Drizzle ORM with PostgreSQL, not Prisma as I initially assumed."
The squad system captures these as shared knowledge.
