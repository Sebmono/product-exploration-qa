# Agent QA PoC — project guide

A proof-of-concept experiment: can an agent explore a web application in a real
browser the way a new user would, ground what it sees in the application's source
code, and report back what it found?

## Layout

```
runtime/           the experiment: agent loop, trace store, surface drivers, UI
runtime/src/trace/     event schema v1, JSONL writer/reader, golden fixture
runtime/src/driver/    Surface Driver interface + adapters (Playwright, fixture replay)
runtime/src/agent/     Claude tool-use loop, guardrails, repo grounding
runtime/src/compile/   trace -> work order compiler
runtime/src/handoff/   pluggable handoff sinks (local JSON file, generic webhook)
runtime/src/server/    run manager + HTTP/SSE server
runtime/ui/            mission control front end
```

## Conventions

- Only `runtime/src/driver/web-playwright.ts` may import Playwright. Everything else
  talks to the `SurfaceDriver` interface, so a non-browser surface can be added
  without touching the agent loop.
- Secrets live in `runtime/.env`, are redacted from every trace event, and never go
  through CLI arguments.
- Guardrails: the agent may only act on allowlisted hosts and never on elements
  matching the no-go pattern (delete, billing, access management). See
  `runtime/src/agent/guardrails.ts`.
- Run `npm test` in `runtime/` before changing agent or driver behavior; the golden
  fixture exercises the whole trace -> SSE -> UI pipeline without any API key.

This is a proof of concept and is not maintained.
