# Agent QA PoC

A proof-of-concept experiment in agent-driven end-to-end QA.

The question it explores: instead of writing click-and-assert test scripts, what if an
agent opened a web application in a real browser, read the application's source code to
predict what each screen should do, walked through a task the way a new user would, and
then reported where the product and the code disagreed?

That is what this repo does. You give it a mission in plain English ("document how to
kick off a new work request"), a target URL and a path to the target application's
source. It opens a headed Chromium window through Playwright, hands you the window to
log in yourself, then takes over: it grounds itself by reading the repo, emits a plan,
drives the UI step by step, and after each meaningful step records a verification
comparing what the code predicted to what it actually saw. Anything only usage reveals
gets recorded as a delta. Every step is written to an append-only JSONL trace and
streamed live over SSE to a small mission-control front end, so you can watch it work.
At the end, the trace compiles into a work order a documentation service can act on —
written to a local JSON file, or POSTed to a webhook you configure.

## What is in the repo

```
runtime/src/trace/     trace event schema v1, JSONL writer/reader, golden fixture
runtime/src/driver/    SurfaceDriver interface + adapters (Playwright, fixture replay)
runtime/src/agent/     Claude tool-use loop, guardrails, repo grounding
runtime/src/compile/   trace -> work order compiler
runtime/src/handoff/   pluggable handoff sinks (local JSON file, generic webhook)
runtime/src/server/    run manager, HTTP + SSE server
runtime/ui/            mission control front end
runtime/test/          unit and integration tests, including a live Playwright test
```

Two design choices carried through the whole thing. Only
`runtime/src/driver/web-playwright.ts` imports Playwright; everything else talks to the
`SurfaceDriver` interface, so another surface could be added without touching the agent
loop. And the agent is fenced: it may only act on allowlisted hosts, never handles your
credentials (you log in yourself, in a real browser window), and refuses elements
matching a no-go pattern covering deletion, billing and access management.

## Running it

```bash
cd runtime
npm install
npx playwright install chromium
cp .env.example .env     # see the file for the variables it needs
```

Without any API key, the test suite and the recorded demo both run:

```bash
npm test                  # unit + Playwright + SSE integration tests
npx tsx src/cli.ts serve  # http://localhost:4174, tick "demo", Start exploration
```

Demo mode replays a golden fixture — a real recorded exploration — through the full
trace to SSE to UI pipeline, so you can see the whole thing move without spending a
token.

A live run needs `ANTHROPIC_API_KEY` in `runtime/.env`:

```bash
npx tsx src/cli.ts run \
  --mission "Document how to kick off a new work request" \
  --target https://app.example.com \
  --repo /path/to/target-repo
```

A headed Chromium window opens. Log in yourself, press Enter, and the agent takes over.
The same flow is available from the UI: `serve`, untick demo, fill in target and repo,
Start, then "I'm logged in — hand off".

To inspect or hand off the result:

```bash
npx tsx src/cli.ts compile --run <runId>
npx tsx src/cli.ts handoff --run <runId> --publication "<name>" [--dry-run]
```

## Status

Proof of concept, not maintained. It was built to find out whether the approach works,
and it does; it is published as an experiment to read and run, not as a supported tool.

## License

MIT. See [LICENSE](./LICENSE).

---

Built with [Claude Code](https://claude.com/claude-code).
