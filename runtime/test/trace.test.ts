import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter, redact } from "../src/trace/writer.js";
import { readTrace } from "../src/trace/reader.js";
import { writeNewWorkRequestFixture } from "../src/trace/fixture-new-work-request.js";
import { FixtureReplayDriver } from "../src/driver/fixture-replay.js";

const tmp = () => mkdtempSync(join(tmpdir(), "agent-qa-test-"));

describe("redact", () => {
  it("redacts secret-shaped keys and known literals", () => {
    const out = redact(
      { apiKey: "sk-ant-12345678", note: "used sk-live-abcdefgh to auth", nested: { password: "hunter22" } },
      ["sk-live-abcdefgh"],
    ) as Record<string, unknown>;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.note).toBe("used [redacted] to auth");
    expect((out.nested as Record<string, unknown>).password).toBe("[redacted]");
  });

  it("leaves ordinary data alone", () => {
    const data = { title: "Create Work Request", steps: [1, 2, 3] };
    expect(redact(data)).toEqual(data);
  });
});

describe("TraceWriter + readTrace round-trip", () => {
  it("writes sequenced, validated JSONL that reads back identically", () => {
    const w = new TraceWriter({ runsRoot: tmp(), runId: "r1" });
    w.emit("run_start", {
      mission: "test",
      target: { kind: "web", url: "https://example.com" },
      driver: "fixture-replay",
    });
    w.emit("plan_step", { id: "P1", title: "step one" });
    w.emit("run_end", { status: "completed", steps: 1 });

    const events = readTrace(w.tracePath);
    expect(events.map((e) => e.type)).toEqual(["run_start", "plan_step", "run_end"]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("rejects invalid payloads at emit time", () => {
    const w = new TraceWriter({ runsRoot: tmp(), runId: "r2" });
    // url must be a valid URL
    expect(() =>
      w.emit("run_start", { mission: "x", target: { kind: "web", url: "not-a-url" }, driver: "d" }),
    ).toThrow();
  });

  it("notifies live listeners", () => {
    const w = new TraceWriter({ runsRoot: tmp(), runId: "r3" });
    const seen: string[] = [];
    const off = w.onEvent((e) => seen.push(e.type));
    w.emit("plan_step", { id: "P1", title: "t" });
    off();
    w.emit("plan_step", { id: "P2", title: "t2" });
    expect(seen).toEqual(["plan_step"]);
  });
});

describe("golden fixture", () => {
  it("re-expresses the 2026-07-10 run as a valid trace", () => {
    const root = tmp();
    const w = writeNewWorkRequestFixture(root);
    const events = readTrace(w.tracePath);

    expect(events[0]!.type).toBe("run_start");
    expect(events.at(-1)!.type).toBe("run_end");
    expect(events.filter((e) => e.type === "plan_step")).toHaveLength(5);
    expect(events.filter((e) => e.type === "delta")).toHaveLength(3);
    expect(events.filter((e) => e.type === "verification").every((e) => e.data.verdict === "pass")).toBe(true);
    expect(events.some((e) => e.type === "handoff" && e.data.publication === "Product Exploration Test")).toBe(true);
    // secret-free by construction
    expect(readFileSync(w.tracePath, "utf8")).not.toMatch(/sk-ant|api[_-]?key/i);
  });
});

describe("FixtureReplayDriver", () => {
  it("replays observations and actions from the fixture", async () => {
    const root = tmp();
    const w = writeNewWorkRequestFixture(root);
    const d = new FixtureReplayDriver(w.tracePath);
    await d.launch({ kind: "web", url: "https://app.example.com" });

    const first = await d.observe();
    expect(first.locus.url).toContain("app.example.com");
    expect(first.a11y).toContain("Create Work Request");

    const click = await d.act({ kind: "click", ref: "ref_3" });
    expect(click.ok).toBe(true);

    const drift = await d.act({ kind: "navigate", url: "https://elsewhere.example" });
    expect(drift.note).toContain("drift");
    await d.close();
  });
});
