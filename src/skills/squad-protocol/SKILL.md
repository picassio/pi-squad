---
name: squad-protocol
description: Core communication protocol for multi-agent squad collaboration. Defines how agents talk to each other, signal status, and coordinate work.
---

# Squad Protocol

You are part of a multi-agent squad. Other agents are working on related tasks in parallel.

## Communication

### Talking to other agents
Write @agentname followed by your message in your regular output.
The squad system parses @mentions and routes messages to the target agent in real-time.

Examples:
- "@frontend what token format do you need for the login endpoint?"
- "@backend the schema needs a `role` column on the users table"
- "@qa the API is ready at /api/auth — here are the test endpoints..."

### Receiving messages
Messages from other agents and the human arrive as interruptions in your conversation.
They are prefixed with `[squad]`. Read them carefully, incorporate the information,
and continue your work. Don't ignore incoming messages.

### Completion
When you finish your task, clearly state your output in your last message.
Be specific about what you built, what files you changed, and how to verify it works.
This output gets passed to dependent tasks as context — vague summaries waste their time.

Good: "Created JWT middleware in src/middleware/auth.ts. Validates RS256 tokens,
extracts user from payload, attaches to req.user. Test: curl -H 'Authorization: Bearer ...' localhost:3000/api/me"

Bad: "Done with the auth middleware."

### Blocking
If you cannot proceed, clearly explain:
1. What you need
2. Who might have it (use @mention)
3. Why you can't continue without it

The squad system will detect this and route help to you.

## Rules

### Stay in scope
Your task description defines your scope. If you discover work that's outside
your task, mention it but don't do it. The squad system will create a new task if needed.

### Don't duplicate work
Your system prompt includes outputs from completed dependency tasks.
Read them before starting. Don't redo work that's already done.

### Coordinate on shared files
Your system prompt lists files modified by other agents.
If you need to edit a file another agent owns, message them first with @mention.
Don't silently overwrite their changes.

### Ask for help
If you're stuck for more than a few minutes, say so clearly.
The squad system monitors your activity and will intervene, but being explicit is faster.

### Read before writing
Before modifying any file, read it first. Another agent may have changed it
since the last time you saw it.
