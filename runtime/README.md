# Agent QA PoC runtime

The agent engine: it explores a web application's UI like a human user, grounded in
that application's source code, and compiles what it proved into a work order a
documentation service can act on.

## Setup

```bash
cd runtime
npm install
npx playwright install chromium
cp .env.example .env     # then fill in ANTHROPIC_API_KEY (handoff needs no key)
```

## Try it without any keys

```bash
npm test                 # 43 tests incl. Playwright + SSE integration
npx tsx src/cli.ts serve # → http://localhost:4174, tick "demo", Start exploration
```

Demo mode replays the golden fixture — a synthetic exploration of a New Work
Request flow in an example app — through the full trace → SSE → UI pipeline.

## A live run

```bash
npx tsx src/cli.ts run \
  --mission "Document how to kick off a New Work Request" \
  --target https://app.example.com \
  --repo /path/to/target-repo
```

A headed Chromium window opens; log in yourself, press Enter, and the agent
takes over (human-in-the-loop auth — Agent QA PoC never handles credentials).
Same thing from the UI: `serve`, untick demo, fill target + repo, Start, then
"I'm logged in — hand off".

## Hand off the work order

The handoff target is pluggable. By default the compiled work order is written
as a JSON file under `AGENTQA_HANDOFF_DIR` (`<runs dir>/handoffs`); set
`AGENTQA_HANDOFF_URL` and the same payload is POSTed to that webhook instead,
with an optional `AGENTQA_HANDOFF_TOKEN` bearer. Anything else implements the
`HandoffSink` interface in `src/handoff/sink.ts`.

```bash
npx tsx src/cli.ts compile --run <runId>                    # inspect the work order
npx tsx src/cli.ts handoff --run <runId> --publication "Product Exploration Test" [--dry-run]
```

## Layout

```
src/trace/     event schema v1 (the product's spine), JSONL writer/reader, golden fixture
src/driver/    Surface Driver interface + adapters (web-playwright; fixture-replay)
src/agent/     Claude tool-use loop, guardrails, repo grounding
src/compile/   trace → work order compiler + polish/handoff stage
src/handoff/   pluggable handoff sinks (local JSON file, generic webhook)
src/server/    run manager + HTTP/SSE server
ui/            mission control (live)
```

Rules that matter:

- **Only `src/driver/web-playwright.ts` may import playwright.** Everything else
  talks to the `SurfaceDriver` interface.
- Secrets live in `.env`, are redacted from every trace event, and never take
  the CLI-args path.
- Guardrails: agent may only act on allowlisted hosts and never on elements
  matching the no-go pattern (delete/billing/access/…) — `src/agent/guardrails.ts`.
