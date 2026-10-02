/** Server integration: demo run over the real HTTP + SSE pipeline. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createRuntimeServer } from "../src/server/http.js";
import { writeNewWorkRequestFixture } from "../src/trace/fixture-new-work-request.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-qa-server-"));
  const runsRoot = join(root, "runs");
  mkdirSync(runsRoot);
  writeNewWorkRequestFixture(join(root, "fixtures")); // demo source
  const uiDir = join(process.cwd(), "ui");
  ({ server } = createRuntimeServer(
    { handoffDir: join(runsRoot, "handoffs"), handoffTargets: [], model: "mock", runsRoot, allowedHosts: [] },
    uiDir,
  ));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => server.close());

describe("runtime server", () => {
  it("serves the mission-control UI", async () => {
    const html = await fetch(base + "/").then((r) => r.text());
    expect(html).toContain("AGENT QA PoC");
  });

  it("refuses live runs without an API key", async () => {
    const res = await fetch(base + "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission: "m", target: "https://example.com" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("ANTHROPIC_API_KEY");
  });

  it("runs a demo end to end and streams every event over SSE", async () => {
    const start = await fetch(base + "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission: "demo mission", demo: true }),
    });
    expect(start.status).toBe(201);
    const { runId } = (await start.json()) as { runId: string };

    const res = await fetch(`${base}/api/runs/${runId}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const types: string[] = [];
    let buf = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data) types.push(JSON.parse(data.slice(6)).type);
      }
      if (types.includes("run_end")) break;
    }
    await reader.cancel();

    expect(types[0]).toBe("run_start");
    expect(types).toContain("plan_step");
    expect(types).toContain("verification");
    expect(types).toContain("delta");
    expect(types.at(-1)).toBe("run_end");

    const runs = (await fetch(base + "/api/runs").then((r) => r.json())) as Array<{ id: string; outcome?: string }>;
    const ours = runs.find((r) => r.id === runId);
    expect(ours?.outcome).toBe("completed");
  }, 90_000);
});
