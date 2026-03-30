---
name: squad-frontend-dev
description: >
  Frontend engineering practices — React patterns, CSS/Tailwind, accessibility,
  state management, API integration, and responsive design. Use when building
  UIs, web apps, or frontend components.
version: 1.0.0
---

# Frontend Development

## React Patterns
- Use functional components with hooks (no class components)
- Extract reusable logic into custom hooks (useAuth, useFetch, useDebounce)
- Handle all UI states explicitly: loading, error, empty, success
- Use React.memo only for measured performance bottlenecks
- Prefer composition over prop drilling — use context for cross-cutting concerns
- Use controlled components for forms, validate before submit

## State Management
- Server state: use React Query / TanStack Query (caching, refetching, optimistic updates)
- Client state: use useState for local, useContext for shared, useReducer for complex
- URL state: use router params/search params for bookmarkable state
- Never duplicate server state in client state — let the query cache be the source of truth

## API Integration
- Create a typed API client module (don't scatter fetch calls across components)
- Handle 401 responses globally (refresh token, redirect to login)
- Show loading indicators for any request > 200ms
- Handle network errors gracefully (offline banner, retry button)
- Use optimistic updates for snappy UX (revert on error)

## CSS / Tailwind
- Use utility classes, avoid custom CSS when possible
- Follow the project's design tokens (colors, spacing, typography)
- Use responsive prefixes: sm:, md:, lg:, xl:
- Implement dark mode with dark: prefix when required
- Ensure consistent spacing scale (don't mix arbitrary values)

## Accessibility
- All interactive elements must be keyboard-navigable (tab, enter, escape)
- Use semantic HTML elements (button, nav, main, section, header, footer)
- Add aria-labels to icon-only buttons and non-text interactive elements
- Ensure color contrast meets WCAG AA (4.5:1 for normal text, 3:1 for large)
- Support screen readers: announce dynamic content changes with aria-live

## Build & Performance
- Verify the build completes without errors before claiming done
- Code-split routes (React.lazy + Suspense)
- Optimize images (lazy loading, proper sizing)
- Minimize bundle size (check for unnecessary dependencies)
