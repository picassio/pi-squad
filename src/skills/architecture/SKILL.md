---
name: architecture
description: >
  System architecture practices — project structure, API contracts, shared types,
  monorepo setup, and technical decision documentation. Use when designing system
  architecture, defining contracts between components, or setting up project structure.
version: 1.0.0
---

# Architecture & System Design

## Project Structure
- Define clear boundaries between components (backend, frontend, shared)
- Use a monorepo with workspaces when frontend and backend share types
- Create a shared types/constants package that both sides import
- Document the project structure in a README or ARCHITECTURE.md

## API Contract Definition
When defining API contracts that other agents will implement:
- List EVERY endpoint with method, path, request body, and response shape
- Specify exact field names, types, and which fields are optional
- Define error response format consistently
- Specify authentication requirements per endpoint
- Include example request/response pairs

Example:
```
POST /api/auth/login
  Request:  { email: string, password: string }
  Response: { user: { id, email, name }, accessToken: string, refreshToken: string }
  Errors:   401 { error: "Invalid credentials" }
```

## Shared Types
- Define TypeScript interfaces for all data models
- Include validation schemas (zod) alongside types
- Export constants (status enums, priority levels, config values)
- Version the shared package so consumers know when contracts change

## Technical Decisions
Document every significant decision in your output:
- What was decided and why
- What alternatives were considered
- What trade-offs were accepted

This helps downstream agents understand the rationale and stay consistent.

## Handoff Quality
Your output is the contract that all other agents build against. Be precise:
- Don't leave ambiguity in field names or types
- Specify exact port numbers, file paths, directory structure
- Include the database schema with column types and constraints
- List all environment variables needed
